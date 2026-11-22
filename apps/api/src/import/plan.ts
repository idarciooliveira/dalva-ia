/**
 * Turns a Convex export into the Postgres rows to insert, validating every
 * document on the way. Pure: no database. The rules (docs/migration-plan.md,
 * PR 13):
 *
 * - Users: one per email, lowercased; Convex users whose emails differ only by
 *   case become one user (the one with a password that signed in last keeps
 *   its password, profile and active chat link; every finance row moves to it). The name
 *   comes from the Convex user, else the profile, else the email's local part.
 * - Passwords: the Lucia Scrypt hash of the `password` auth account, copied
 *   as-is when it is `<32 hex>:<128 hex>` (Better Auth verifies it unchanged).
 * - Ids: UUIDv7 from `_creationTime` and the Convex id ({@link importId}).
 * - Every amount a safe integer, every date a real `YYYY-MM-DD`, every enum
 *   value known, no NUL in text. Any violation fails the run.
 * - A reference to a missing row, or to another user's row, becomes null on a
 *   nullable column. On the three NOT NULL ones (`subcategories.category_id`,
 *   `goal_contributions.goal_id`, `debt_payments.debt_id`) it fails the run,
 *   or with `dropInvalid` drops the row.
 * - A lone outgoing transfer leg whose destination is gone fails the run (the
 *   new code would read it as incoming), unless `acceptLoneLegs`.
 * - Rows whose owner doesn't exist are skipped (nobody could see them).
 * - Agent chat state, sessions, link codes and idempotency keys are not
 *   migrated: users sign in once, chats start fresh. Linked chats are.
 */
import type {
  accounts,
  authAccounts,
  categories,
  channelIdentities,
  debtPayments,
  debts,
  goalContributions,
  savingsGoals,
  subcategories,
  transactions,
  userProfiles,
  users,
} from "../db/schema";
import type { ConvexDoc, ConvexExport } from "./convex-export";
import { importId, nameUuid } from "./ids";

export interface PlanOptions {
  /** Drop rows whose NOT NULL reference is dangling or another user's, instead of failing. */
  dropInvalid?: boolean;
  /**
   * Import lone outgoing transfer legs whose destination is gone (they read as incoming afterwards, so deleting one
   * reverses the wrong sign) with a warning, instead of failing.
   */
  acceptLoneLegs?: boolean;
}

export type IssueCode =
  // Errors: the run fails.
  | "invalid_document"
  | "duplicate_id"
  | "invalid_value"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_password_hash"
  | "missing_email"
  | "dangling_required_ref"
  | "cross_user_required_ref"
  | "lone_outgoing_leg_without_destination"
  // Warnings: reported, the run goes on.
  | "dropped_dangling_required_ref"
  | "dropped_cross_user_required_ref"
  | "email_case_merge"
  | "orphan_owner"
  | "nulled_dangling_ref"
  | "nulled_cross_user_ref"
  | "lone_transfer_leg"
  | "accepted_lone_outgoing_leg"
  | "user_without_password"
  | "extra_password_account"
  | "ignored_auth_account"
  | "duplicate_profile_dropped"
  | "identity_unlinked"
  | "transfer_group_id_rewritten"
  | "unknown_table";

/** One finding. Ids are Convex ids; no emails, names or amounts. */
export interface Issue {
  code: IssueCode;
  table: string;
  id?: string;
  field?: string;
  detail?: string;
}

export interface ImportRows {
  users: (typeof users.$inferInsert & { id: string })[];
  authAccounts: (typeof authAccounts.$inferInsert)[];
  userProfiles: (typeof userProfiles.$inferInsert)[];
  accounts: (typeof accounts.$inferInsert & { id: string })[];
  categories: (typeof categories.$inferInsert)[];
  subcategories: (typeof subcategories.$inferInsert)[];
  transactions: (typeof transactions.$inferInsert & { id: string })[];
  savingsGoals: (typeof savingsGoals.$inferInsert)[];
  goalContributions: (typeof goalContributions.$inferInsert)[];
  debts: (typeof debts.$inferInsert)[];
  debtPayments: (typeof debtPayments.$inferInsert)[];
  channelIdentities: (typeof channelIdentities.$inferInsert)[];
}

export type ImportTable = keyof ImportRows;

export interface PlanReport {
  /** Documents per table in the export. */
  source: Record<string, number>;
  /** Rows to insert per Postgres table (keys of {@link ImportRows}). */
  planned: Record<ImportTable, number>;
  /** Tables deliberately not migrated, with their document counts. */
  notMigrated: Record<string, number>;
  errors: Issue[];
  warnings: Issue[];
  /** Number of issues per code, errors and warnings. */
  counts: Partial<Record<IssueCode, number>>;
}

export interface ImportPlan {
  rows: ImportRows;
  report: PlanReport;
  /**
   * Per imported account id: its Convex balance and the balance effect of the
   * Convex transactions on it (Convex's own leg rule), for verification.
   */
  balances: Map<string, { convexId: string; balance: number; convexEffect: number }>;
}

/* -------------------------------------------------------------------------- */
/*  Tables                                                                    */
/* -------------------------------------------------------------------------- */

/** Convex table → Postgres rows key. */
const MIGRATED = {
  users: "users",
  authAccounts: "authAccounts",
  userProfiles: "userProfiles",
  accounts: "accounts",
  categories: "categories",
  subcategories: "subcategories",
  transactions: "transactions",
  savingsGoals: "savingsGoals",
  goalContributions: "goalContributions",
  debts: "debts",
  debtPayments: "debtPayments",
  channelIdentities: "channelIdentities",
} as const satisfies Record<string, ImportTable>;

const NOT_MIGRATED = new Set([
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
  "apiIdempotencyKeys",
  "channelLinkCodes",
  "agentInboundEvents",
  "agentSessions",
  "agentMessages",
  "agentPendingActions",
]);

const ERROR_CODES = new Set<IssueCode>([
  "invalid_document",
  "duplicate_id",
  "invalid_value",
  "invalid_amount",
  "invalid_date",
  "invalid_password_hash",
  "missing_email",
  "dangling_required_ref",
  "cross_user_required_ref",
  "lone_outgoing_leg_without_destination",
]);

const ACCOUNT_TYPES = ["bank", "savings", "credit_card", "cash", "e_wallet", "loan", "investment"] as const;
const CATEGORY_TYPES = ["income", "expense"] as const;
const TRANSACTION_TYPES = ["income", "expense", "adjustment", "transfer"] as const;
const DEBT_TYPES = ["credit_card", "loan", "mortgage", "student_loan", "personal_loan", "other"] as const;
const CHANNELS = ["telegram"] as const;
const SCOPES = ["finance:read", "finance:write"] as const;

/** Lucia `Scrypt` / Better Auth: 16-byte salt and 64-byte key, lowercase hex. */
export const PASSWORD_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT32_MAX = 2 ** 31 - 1;

/* -------------------------------------------------------------------------- */
/*  Field readers                                                             */
/* -------------------------------------------------------------------------- */

class Issues {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  add(issue: Issue) {
    (ERROR_CODES.has(issue.code) ? this.errors : this.warnings).push(issue);
  }
}

/** Reads one document's fields, recording an error for each bad one. */
class Fields {
  ok = true;
  constructor(
    private readonly issues: Issues,
    readonly table: string,
    readonly doc: ConvexDoc,
  ) {}

  fail(code: IssueCode, field: string, detail: string) {
    this.ok = false;
    this.issues.add({ code, table: this.table, id: this.doc._id, field, detail });
  }

  private has(field: string) {
    return this.doc[field] !== undefined && this.doc[field] !== null;
  }

  string(field: string): string {
    const value = this.doc[field];
    if (typeof value !== "string") {
      this.fail("invalid_value", field, "expected a string");
      return "";
    }
    if (value.includes("\u0000")) {
      this.fail("invalid_value", field, "contains a NUL character");
      return "";
    }
    return value;
  }

  optString(field: string): string | null {
    return this.has(field) ? this.string(field) : null;
  }

  stringArray(field: string): string[] | null {
    if (!this.has(field)) return null;
    const value = this.doc[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.includes("\u0000"))) {
      this.fail("invalid_value", field, "expected an array of strings");
      return null;
    }
    return value as string[];
  }

  boolean(field: string): boolean {
    const value = this.doc[field];
    if (typeof value !== "boolean") {
      this.fail("invalid_value", field, "expected a boolean");
      return false;
    }
    return value;
  }

  optBoolean(field: string, fallback: boolean): boolean {
    return this.has(field) ? this.boolean(field) : fallback;
  }

  oneOf<T extends string>(field: string, values: readonly T[]): T {
    const value = this.doc[field];
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail("invalid_value", field, `expected one of ${values.join(", ")}`);
      return values[0]!;
    }
    return value as T;
  }

  /** Minor units: a safe integer (Convex stores a float64). */
  amount(field: string): number {
    const value = this.doc[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.fail("invalid_amount", field, "expected an integer amount in minor units");
      return 0;
    }
    return value;
  }

  optAmount(field: string): number | null {
    return this.has(field) ? this.amount(field) : null;
  }

  int32(field: string): number {
    const value = this.doc[field];
    if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > INT32_MAX) {
      this.fail("invalid_value", field, "expected a 32-bit integer");
      return 0;
    }
    return value;
  }

  optInt32(field: string): number | null {
    return this.has(field) ? this.int32(field) : null;
  }

  optFinite(field: string): number | null {
    if (!this.has(field)) return null;
    const value = this.doc[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail("invalid_value", field, "expected a finite number");
      return null;
    }
    return value;
  }

  /** A real calendar day `YYYY-MM-DD`, years 0001-9999. */
  date(field: string): string {
    const value = this.doc[field];
    if (typeof value !== "string" || !isCalendarDate(value)) {
      this.fail("invalid_date", field, "expected a valid YYYY-MM-DD date");
      return "1970-01-01";
    }
    return value;
  }

  optDate(field: string): string | null {
    return this.has(field) ? this.date(field) : null;
  }

  /** Epoch milliseconds. */
  instant(field: string): Date {
    const value = this.doc[field];
    const date = typeof value === "number" && Number.isFinite(value) ? new Date(value) : undefined;
    if (!date || Number.isNaN(date.getTime())) {
      this.fail("invalid_value", field, "expected a timestamp in ms");
      return new Date(0);
    }
    return date;
  }

  optInstant(field: string): Date | null {
    return this.has(field) ? this.instant(field) : null;
  }

  /** A Convex id field, or undefined when absent. */
  ref(field: string, required: boolean): string | undefined {
    const value = this.doc[field];
    if (value === undefined || value === null) {
      if (required) this.fail("invalid_value", field, "missing id");
      return undefined;
    }
    if (typeof value !== "string") {
      this.fail("invalid_value", field, "expected an id");
      return undefined;
    }
    return value;
  }
}

export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/* -------------------------------------------------------------------------- */
/*  Plan                                                                      */
/* -------------------------------------------------------------------------- */

interface Target {
  id: string;
  userId: string;
}

export function planImport(source: ConvexExport, options: PlanOptions = {}): ImportPlan {
  const issues = new Issues();
  const rows: ImportRows = {
    users: [],
    authAccounts: [],
    userProfiles: [],
    accounts: [],
    categories: [],
    subcategories: [],
    transactions: [],
    savingsGoals: [],
    goalContributions: [],
    debts: [],
    debtPayments: [],
    channelIdentities: [],
  };
  const report: PlanReport = {
    source: {},
    planned: {} as Record<ImportTable, number>,
    notMigrated: {},
    errors: issues.errors,
    warnings: issues.warnings,
    counts: {},
  };

  for (const [table, docs] of source) {
    report.source[table] = docs.length;
    if (NOT_MIGRATED.has(table)) report.notMigrated[table] = docs.length;
    else if (!(table in MIGRATED)) issues.add({ code: "unknown_table", table, detail: `${docs.length} documents not migrated` });
  }

  /** Valid documents of a table; malformed or repeated ones are errors. */
  const docsOf = (table: string): ConvexDoc[] => {
    const seen = new Set<string>();
    const valid: ConvexDoc[] = [];
    for (const doc of source.get(table) ?? []) {
      const candidate = doc as Partial<ConvexDoc> | null;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        typeof candidate._id !== "string" ||
        typeof candidate._creationTime !== "number" ||
        !Number.isFinite(candidate._creationTime) ||
        candidate._creationTime < 0 ||
        candidate._creationTime >= 2 ** 48
      ) {
        issues.add({ code: "invalid_document", table, id: typeof candidate?._id === "string" ? candidate._id : undefined, detail: "missing _id or _creationTime" });
        continue;
      }
      if (seen.has(candidate._id)) {
        issues.add({ code: "duplicate_id", table, id: candidate._id });
        continue;
      }
      seen.add(candidate._id);
      valid.push(candidate as ConvexDoc);
    }
    return valid;
  };
  const idOf = (table: string, doc: ConvexDoc) => importId(table, doc._id, doc._creationTime);
  const createdAt = (doc: ConvexDoc) => new Date(Math.floor(doc._creationTime));

  /* Users ------------------------------------------------------------------ */

  /** Convex user id → Postgres user id (several Convex users map to one after a case merge). */
  const owners = new Map<string, string>();
  const userDocs = docsOf("users");
  const profileDocs = docsOf("userProfiles");
  const lastSignIn = new Map<string, number>();
  for (const session of docsOf("authSessions")) {
    const userId = session.userId;
    if (typeof userId === "string") lastSignIn.set(userId, Math.max(lastSignIn.get(userId) ?? 0, session._creationTime));
  }

  const userIds = new Set(userDocs.map((doc) => doc._id));
  const passwordAccounts = new Map<string, ConvexDoc>();
  for (const account of docsOf("authAccounts")) {
    const userId = account.userId;
    if (typeof userId !== "string" || !userIds.has(userId)) {
      issues.add({ code: "orphan_owner", table: "authAccounts", id: account._id, field: "userId" });
      continue;
    }
    if (account.provider !== "password") {
      issues.add({ code: "ignored_auth_account", table: "authAccounts", id: account._id, detail: `provider ${String(account.provider)}` });
      continue;
    }
    const current = passwordAccounts.get(userId);
    if (current) {
      // Keep the newest password account of a user.
      const [kept, extra] = account._creationTime > current._creationTime ? [account, current] : [current, account];
      passwordAccounts.set(userId, kept);
      issues.add({ code: "extra_password_account", table: "authAccounts", id: extra._id, detail: `kept ${kept._id}` });
    } else {
      passwordAccounts.set(userId, account);
    }
  }

  // Valid users grouped by lowercase email.
  const byEmail = new Map<string, ConvexDoc[]>();
  for (const user of userDocs) {
    const account = passwordAccounts.get(user._id);
    const raw = typeof account?.providerAccountId === "string" ? account.providerAccountId : user.email;
    if (typeof raw !== "string" || !/^[^\s@]+@[^\s@]+$/.test(raw.trim()) || raw.includes("\u0000")) {
      issues.add({ code: "missing_email", table: "users", id: user._id, detail: "no usable email on the user or its password account" });
      continue;
    }
    const email = raw.trim().toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) ?? []), user]);
  }

  const profileNames = new Map<string, string>();
  for (const profile of profileDocs) {
    if (typeof profile.userId === "string" && typeof profile.name === "string" && profile.name.trim()) {
      profileNames.set(profile.userId, profile.name.trim());
    }
  }
  /** Convex id of the user that survives a merge, per Convex user id. */
  const primaryOf = new Map<string, string>();
  /** The row belongs to a user that survived a merge (or was never merged). */
  const ownedByPrimary = (doc: ConvexDoc) => primaryOf.get(doc.userId as string) === doc.userId;

  for (const [email, group] of byEmail) {
    // One with a usable password, then the one that signed in last, then the newest, keeps its credential,
    // profile and active chat link: picking one without a password would lock the person out.
    const rank = (user: ConvexDoc) => {
      const secret = passwordAccounts.get(user._id)?.secret;
      return [typeof secret === "string" && PASSWORD_HASH.test(secret) ? 1 : 0, lastSignIn.get(user._id) ?? -1, user._creationTime];
    };
    const primary = group.reduce((best, user) => {
      const [a, b] = [rank(user), rank(best)];
      const i = a.findIndex((value, index) => value !== b[index]);
      return i >= 0 && a[i]! > b[i]! ? user : best;
    });
    if (group.length > 1) {
      issues.add({
        code: "email_case_merge",
        table: "users",
        id: primary._id,
        detail: `merged ${group.filter((user) => user !== primary).map((user) => user._id).join(", ")}`,
      });
    }

    const fields = new Fields(issues, "users", primary);
    const name = (fields.optString("name") ?? "").trim() || [primary, ...group].map((user) => profileNames.get(user._id)).find(Boolean) || email.split("@")[0]!;
    const image = fields.optString("image");
    const id = idOf("users", primary);
    rows.users.push({
      id,
      name,
      email,
      emailVerified: typeof primary.emailVerificationTime === "number",
      image,
      createdAt: createdAt(primary),
      updatedAt: createdAt(primary),
    });
    for (const user of group) {
      owners.set(user._id, id);
      primaryOf.set(user._id, primary._id);
    }

    const account = passwordAccounts.get(primary._id);
    if (!account) {
      issues.add({ code: "user_without_password", table: "users", id: primary._id });
      continue;
    }
    if (typeof account.secret !== "string" || !PASSWORD_HASH.test(account.secret)) {
      issues.add({ code: "invalid_password_hash", table: "authAccounts", id: account._id, field: "secret", detail: "expected <32 hex>:<128 hex>" });
      continue;
    }
    rows.authAccounts.push({
      id: idOf("authAccounts", account),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: account.secret,
      createdAt: createdAt(account),
      updatedAt: createdAt(account),
    });
  }

  /** The Postgres owner of a row, or undefined (reported, row skipped) when its user doesn't exist. */
  const ownerOf = (table: string, doc: ConvexDoc): string | undefined => {
    const owner = typeof doc.userId === "string" ? owners.get(doc.userId) : undefined;
    if (!owner) issues.add({ code: "orphan_owner", table, id: doc._id, field: "userId" });
    return owner;
  };

  /* Reference resolution --------------------------------------------------- */

  /** Imported rows per Convex table: Convex id → Postgres id and owner. */
  const targets = new Map<string, Map<string, Target>>();
  const register = (table: string, convexId: string, target: Target) => {
    let map = targets.get(table);
    if (!map) targets.set(table, (map = new Map()));
    map.set(convexId, target);
  };

  /** A nullable reference: null when absent, dangling or another user's (both reported). */
  const nullableRef = (fields: Fields, field: string, targetTable: string, owner: string, options: { required?: boolean } = {}) => {
    const convexId = fields.ref(field, options.required ?? false);
    if (convexId === undefined) return null;
    const target = targets.get(targetTable)?.get(convexId);
    if (!target) {
      issues.add({ code: "nulled_dangling_ref", table: fields.table, id: fields.doc._id, field, detail: `${targetTable} ${convexId}` });
      return null;
    }
    if (target.userId !== owner) {
      issues.add({ code: "nulled_cross_user_ref", table: fields.table, id: fields.doc._id, field, detail: `${targetTable} ${convexId}` });
      return null;
    }
    return target.id;
  };

  /** A NOT NULL reference: dangling or another user's fails the run, or drops the row (undefined). */
  const requiredRef = (fields: Fields, field: string, targetTable: string, owner: string): string | undefined => {
    const convexId = fields.ref(field, true);
    if (convexId === undefined) return undefined;
    const target = targets.get(targetTable)?.get(convexId);
    const problem = !target ? "dangling" : target.userId !== owner ? "cross_user" : undefined;
    if (!problem) return target!.id;
    const code: IssueCode = options.dropInvalid ? `dropped_${problem}_required_ref` : `${problem}_required_ref`;
    issues.add({ code, table: fields.table, id: fields.doc._id, field, detail: `${targetTable} ${convexId}` });
    return undefined;
  };

  /* Profiles --------------------------------------------------------------- */

  const profileByOwner = new Map<string, { doc: ConvexDoc; index: number }>();
  for (const doc of profileDocs) {
    const owner = ownerOf("userProfiles", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "userProfiles", doc);
    const row = {
      id: idOf("userProfiles", doc),
      userId: owner,
      name: fields.optString("name"),
      baseCurrency: fields.string("baseCurrency"),
      onboardingCompleted: fields.boolean("onboardingCompleted"),
      createdAt: createdAt(doc),
    };
    // One profile per user: the merge survivor's own, else the oldest.
    const current = profileByOwner.get(owner);
    if (current) {
      const replace = (ownedByPrimary(doc) && !ownedByPrimary(current.doc)) || (ownedByPrimary(doc) === ownedByPrimary(current.doc) && doc._creationTime < current.doc._creationTime);
      const [kept, dropped] = replace ? [doc, current.doc] : [current.doc, doc];
      issues.add({ code: "duplicate_profile_dropped", table: "userProfiles", id: dropped._id, detail: `kept ${kept._id}` });
      if (!replace) continue;
      rows.userProfiles[current.index] = row;
      profileByOwner.set(owner, { doc, index: current.index });
      continue;
    }
    profileByOwner.set(owner, { doc, index: rows.userProfiles.length });
    rows.userProfiles.push(row);
  }

  /* Accounts --------------------------------------------------------------- */

  const balances: ImportPlan["balances"] = new Map();
  for (const doc of docsOf("accounts")) {
    const owner = ownerOf("accounts", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "accounts", doc);
    const id = idOf("accounts", doc);
    const row = {
      id,
      userId: owner,
      name: fields.string("name"),
      type: fields.oneOf("type", ACCOUNT_TYPES),
      balance: fields.amount("balance"),
      currency: fields.string("currency"),
      theme: fields.optString("theme"),
      icon: fields.optString("icon"),
      description: fields.optString("description"),
      archived: fields.optBoolean("archived", false),
      createdAt: createdAt(doc),
    };
    rows.accounts.push(row);
    register("accounts", doc._id, { id, userId: owner });
    balances.set(id, { convexId: doc._id, balance: row.balance, convexEffect: 0 });
  }

  /* Categories and subcategories ------------------------------------------- */

  for (const doc of docsOf("categories")) {
    const owner = ownerOf("categories", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "categories", doc);
    const id = idOf("categories", doc);
    rows.categories.push({
      id,
      userId: owner,
      name: fields.string("name"),
      type: fields.oneOf("type", CATEGORY_TYPES),
      icon: fields.optString("icon"),
      color: fields.optString("color"),
      isDefault: fields.boolean("isDefault"),
      archived: fields.optBoolean("archived", false),
      sortOrder: fields.optInt32("sortOrder"),
      createdAt: createdAt(doc),
    });
    register("categories", doc._id, { id, userId: owner });
  }

  for (const doc of docsOf("subcategories")) {
    const owner = ownerOf("subcategories", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "subcategories", doc);
    const categoryId = requiredRef(fields, "categoryId", "categories", owner);
    if (categoryId === undefined) continue;
    const id = idOf("subcategories", doc);
    rows.subcategories.push({
      id,
      userId: owner,
      categoryId,
      name: fields.string("name"),
      archived: fields.boolean("archived"),
      sortOrder: fields.int32("sortOrder"),
      createdAt: createdAt(doc),
    });
    register("subcategories", doc._id, { id, userId: owner });
  }

  /* Transactions ----------------------------------------------------------- */

  // Register first: legs reference each other.
  const transactionDocs = docsOf("transactions").flatMap((doc) => {
    const owner = ownerOf("transactions", doc);
    if (!owner) return [];
    register("transactions", doc._id, { id: idOf("transactions", doc), userId: owner });
    return [{ doc, owner }];
  });
  for (const { doc, owner } of transactionDocs) {
    const fields = new Fields(issues, "transactions", doc);
    const type = fields.oneOf("type", TRANSACTION_TYPES);
    const amount = fields.amount("amount");
    const rawGroup = fields.optString("transferGroupId");
    let transferGroupId: string | null = null;
    if (rawGroup !== null) {
      transferGroupId = UUID.test(rawGroup) ? rawGroup.toLowerCase() : nameUuid("transferGroupId", rawGroup);
      if (!UUID.test(rawGroup)) issues.add({ code: "transfer_group_id_rewritten", table: "transactions", id: doc._id, field: "transferGroupId" });
    }
    const row = {
      id: idOf("transactions", doc),
      userId: owner,
      type,
      amount,
      accountId: nullableRef(fields, "accountId", "accounts", owner, { required: true }),
      categoryId: nullableRef(fields, "categoryId", "categories", owner),
      subcategoryId: nullableRef(fields, "subcategoryId", "subcategories", owner),
      date: fields.date("date"),
      description: fields.optString("description"),
      note: fields.optString("note"),
      payee: fields.optString("payee"),
      tags: fields.stringArray("tags"),
      destinationAccountId: nullableRef(fields, "destinationAccountId", "accounts", owner),
      linkedTransactionId: nullableRef(fields, "linkedTransactionId", "transactions", owner),
      transferGroupId,
      createdAt: createdAt(doc),
    };
    rows.transactions.push(row);

    if (type === "transfer" && row.linkedTransactionId === null) {
      // A lone leg reverses its own effect. One that was outgoing but lost its destination looks incoming to the
      // new code (no destination, no pair), so deleting it would reverse it with the wrong sign.
      const wasOutgoing = typeof doc.destinationAccountId === "string";
      issues.add({
        code:
          wasOutgoing && row.destinationAccountId === null
            ? options.acceptLoneLegs
              ? "accepted_lone_outgoing_leg"
              : "lone_outgoing_leg_without_destination"
            : "lone_transfer_leg",
        table: "transactions",
        id: doc._id,
      });
    }

    // Convex's balance effect, on the account the Convex row pointed at (whatever its owner).
    const account = typeof doc.accountId === "string" ? targets.get("accounts")?.get(doc.accountId)?.id : undefined;
    const balance = account ? balances.get(account) : undefined;
    if (balance && fields.ok) balance.convexEffect += convexEffect(type, amount, typeof doc.destinationAccountId === "string");
  }

  /* Goals ------------------------------------------------------------------ */

  for (const doc of docsOf("savingsGoals")) {
    const owner = ownerOf("savingsGoals", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "savingsGoals", doc);
    const id = idOf("savingsGoals", doc);
    rows.savingsGoals.push({
      id,
      userId: owner,
      name: fields.string("name"),
      targetAmount: fields.amount("targetAmount"),
      currentAmount: fields.amount("currentAmount"),
      targetDate: fields.optDate("targetDate"),
      linkedAccountId: nullableRef(fields, "linkedAccountId", "accounts", owner),
      isVirtual: fields.boolean("isVirtual"),
      icon: fields.optString("icon"),
      color: fields.optString("color"),
      archived: fields.optBoolean("archived", false),
      createdOn: fields.date("createdAt"),
      createdAt: createdAt(doc),
    });
    register("savingsGoals", doc._id, { id, userId: owner });
  }

  for (const doc of docsOf("goalContributions")) {
    const owner = ownerOf("goalContributions", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "goalContributions", doc);
    const goalId = requiredRef(fields, "goalId", "savingsGoals", owner);
    if (goalId === undefined) continue;
    rows.goalContributions.push({
      id: idOf("goalContributions", doc),
      userId: owner,
      goalId,
      amount: fields.amount("amount"),
      date: fields.date("date"),
      note: fields.optString("note"),
      transactionId: nullableRef(fields, "transactionId", "transactions", owner),
      createdAt: createdAt(doc),
    });
  }

  /* Debts ------------------------------------------------------------------ */

  for (const doc of docsOf("debts")) {
    const owner = ownerOf("debts", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "debts", doc);
    const id = idOf("debts", doc);
    rows.debts.push({
      id,
      userId: owner,
      name: fields.string("name"),
      debtType: fields.oneOf("debtType", DEBT_TYPES),
      lender: fields.optString("lender"),
      originalAmount: fields.amount("originalAmount"),
      currentBalance: fields.amount("currentBalance"),
      interestRate: fields.optFinite("interestRate"),
      minimumPayment: fields.optAmount("minimumPayment"),
      dueDate: fields.optDate("dueDate"),
      linkedAccountId: nullableRef(fields, "linkedAccountId", "accounts", owner),
      archived: fields.optBoolean("archived", false),
      createdOn: fields.date("createdAt"),
      createdAt: createdAt(doc),
    });
    register("debts", doc._id, { id, userId: owner });
  }

  for (const doc of docsOf("debtPayments")) {
    const owner = ownerOf("debtPayments", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "debtPayments", doc);
    const debtId = requiredRef(fields, "debtId", "debts", owner);
    if (debtId === undefined) continue;
    rows.debtPayments.push({
      id: idOf("debtPayments", doc),
      userId: owner,
      debtId,
      amount: fields.amount("amount"),
      principalAmount: fields.amount("principalAmount"),
      interestAmount: fields.amount("interestAmount"),
      date: fields.date("date"),
      note: fields.optString("note"),
      fromAccountId: nullableRef(fields, "fromAccountId", "accounts", owner, { required: true }),
      sourceTransactionId: nullableRef(fields, "sourceTransactionId", "transactions", owner, { required: true }),
      liabilityTransactionId: nullableRef(fields, "liabilityTransactionId", "transactions", owner),
      createdAt: createdAt(doc),
    });
  }

  /* Channel identities ----------------------------------------------------- */

  const identities: { doc: ConvexDoc; row: ImportRows["channelIdentities"][number] }[] = [];
  for (const doc of docsOf("channelIdentities")) {
    const owner = ownerOf("channelIdentities", doc);
    if (!owner) continue;
    const fields = new Fields(issues, "channelIdentities", doc);
    const scopes = doc.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => !(SCOPES as readonly unknown[]).includes(scope))) {
      fields.fail("invalid_value", "scopes", `expected an array of ${SCOPES.join(", ")}`);
    }
    identities.push({
      doc,
      row: {
        id: idOf("channelIdentities", doc),
        userId: owner,
        channel: fields.oneOf("channel", CHANNELS),
        externalUserId: fields.string("externalUserId"),
        chatId: fields.string("chatId"),
        username: fields.optString("username"),
        scopes: Array.isArray(scopes) ? (scopes as (typeof SCOPES)[number][]) : [],
        linkedAt: fields.instant("linkedAt"),
        consentAt: fields.instant("consentAt"),
        unlinkedAt: fields.optInstant("unlinkedAt"),
        createdAt: createdAt(doc),
      },
    });
  }
  // At most one active link per (channel, external user) and per (user, channel), as the partial unique indexes
  // require. A case merge can give one user two; keep the survivor's own link, else the newest, and unlink the
  // others at the kept link's time.
  const keepOrder = [...identities].sort(
    (a, b) =>
      Number(ownedByPrimary(b.doc)) - Number(ownedByPrimary(a.doc)) ||
      b.row.linkedAt.getTime() - a.row.linkedAt.getTime() ||
      b.doc._creationTime - a.doc._creationTime,
  );
  const activeByExternal = new Map<string, ImportRows["channelIdentities"][number]>();
  const activeByUser = new Map<string, ImportRows["channelIdentities"][number]>();
  for (const { doc, row } of keepOrder) {
    if (row.unlinkedAt) continue;
    const external = `${row.channel}\0${row.externalUserId}`;
    const user = `${row.userId}\0${row.channel}`;
    const kept = activeByExternal.get(external) ?? activeByUser.get(user);
    if (kept) {
      row.unlinkedAt = new Date(Math.max(kept.linkedAt.getTime(), row.linkedAt.getTime()));
      issues.add({ code: "identity_unlinked", table: "channelIdentities", id: doc._id, detail: "another active link kept for the same chat or user" });
      continue;
    }
    activeByExternal.set(external, row);
    activeByUser.set(user, row);
  }
  rows.channelIdentities = identities.map(({ row }) => row);

  /* Report ----------------------------------------------------------------- */

  for (const key of Object.keys(rows) as ImportTable[]) report.planned[key] = rows[key].length;
  for (const issue of [...issues.errors, ...issues.warnings]) report.counts[issue.code] = (report.counts[issue.code] ?? 0) + 1;
  return { rows, report, balances };
}

/** A transaction's effect on its account's balance, as Convex applied it (outgoing leg: it has a destination). */
export function convexEffect(type: (typeof TRANSACTION_TYPES)[number], amount: number, hasDestination: boolean): number {
  if (type === "expense") return -amount;
  if (type === "transfer") return hasDestination ? -amount : amount;
  return amount;
}
