/**
 * A synthetic `npx convex export`: every migrated table, plus the legacy
 * shapes the import must handle (case-duplicate emails, orphans, cross-user
 * references, lone transfer legs). No real data.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import type { ConvexExport } from "../src/import/convex-export";

/** Lucia `Scrypt` hashes (lucia@3.2.2) and their passwords, as in src/auth/auth.test.ts. */
export const HASHES = {
  staple: {
    password: "correct horse battery staple",
    hash: "df9a91756533bb2f19ac803ae304b64f:b7b6522700874ff4746820259f3fba7dbeaaf3bdf3e73845989bd824d573ebd7c0b7e7e43b745067a7ff7ea1aa8986288af10871aebf881115281e4dd5de3c1b",
  },
  umlaut: {
    password: "Pässwörd-ﬁ 123",
    hash: "63ae00b0912f1567f66e3743b394d851:03ec80f94b509450488954eb399cda4436e9984d9fbff278be976e494b1944602cdb6a16f477e48232f78340c15a2ee0f7ef3fcf88ec199b918dd8f37b80ba1a",
  },
};

/** 2026-01-01T00:00:00Z; each document is one second after the previous one. */
const T0 = 1_767_225_600_000;

type Doc = Record<string, unknown>;

/**
 * Users: `ana` and `ana2` share an email up to case (ana2 signed in last and
 * survives the merge); `bob`; `carl` has no password account. `ghost` owns
 * nothing that exists (its user is gone).
 */
export function convexFixture(): Record<string, Doc[]> {
  let clock = T0;
  const doc = (id: string, fields: Doc): Doc => ({ _id: id, _creationTime: (clock += 1000) + 0.25, ...fields });
  return {
    users: [
      doc("u_ana", { email: "Ana@Example.com", name: "Ana" }),
      doc("u_ana2", { email: "ana@example.com", emailVerificationTime: T0 }),
      doc("u_bob", { email: "bob@example.com" }),
      doc("u_carl", { email: "carl@example.com", name: "Carl" }),
    ],
    authAccounts: [
      doc("aa_ana", { userId: "u_ana", provider: "password", providerAccountId: "Ana@Example.com", secret: HASHES.staple.hash }),
      doc("aa_ana2", { userId: "u_ana2", provider: "password", providerAccountId: "ana@example.com", secret: HASHES.umlaut.hash }),
      doc("aa_bob", { userId: "u_bob", provider: "password", providerAccountId: "bob@example.com", secret: HASHES.staple.hash }),
      doc("aa_bob_gh", { userId: "u_bob", provider: "github", providerAccountId: "42" }),
    ],
    authSessions: [
      doc("s_ana2", { userId: "u_ana2", expirationTime: T0 }),
      doc("s_ana", { userId: "u_ana", expirationTime: T0 }),
      doc("s_ana2b", { userId: "u_ana2", expirationTime: T0 }),
    ],
    authRefreshTokens: [doc("rt_1", { sessionId: "s_ana", expirationTime: T0 })],
    userProfiles: [
      doc("p_ana", { userId: "u_ana", baseCurrency: "USD", onboardingCompleted: true }),
      doc("p_ana2", { userId: "u_ana2", baseCurrency: "EUR", onboardingCompleted: true, name: "Ana Two" }),
      doc("p_bob", { userId: "u_bob", baseCurrency: "USD", onboardingCompleted: true, name: "Bob Profile" }),
    ],
    accounts: [
      doc("a_checking", { userId: "u_ana", name: "Checking", type: "bank", balance: 100_000, currency: "USD" }),
      doc("a_savings", { userId: "u_ana2", name: "Savings", type: "savings", balance: 2_000, currency: "USD", archived: false, theme: "azul" }),
      doc("a_bob", { userId: "u_bob", name: "Cash", type: "cash", balance: 5_000, currency: "USD", archived: true }),
      doc("a_ghost", { userId: "u_ghost", name: "Ghost", type: "cash", balance: 0, currency: "USD" }),
    ],
    categories: [
      doc("c_food", { userId: "u_ana", name: "Food", type: "expense", isDefault: true, sortOrder: 1 }),
      doc("c_salary", { userId: "u_ana2", name: "Salary", type: "income", isDefault: true }),
      doc("c_bob", { userId: "u_bob", name: "Rent", type: "expense", isDefault: false, archived: true }),
    ],
    subcategories: [
      doc("sc_groceries", { userId: "u_ana", categoryId: "c_food", name: "Groceries", archived: false, sortOrder: 0 }),
      // Owner merged: ana2's subcategory under ana's category is the same user after the merge.
      doc("sc_merged", { userId: "u_ana2", categoryId: "c_food", name: "Eating out", archived: false, sortOrder: 1 }),
    ],
    transactions: [
      doc("t_salary", { userId: "u_ana2", type: "income", amount: 50_000, accountId: "a_checking", categoryId: "c_salary", date: "2026-01-31" }),
      doc("t_food", {
        userId: "u_ana", type: "expense", amount: 1_250, accountId: "a_checking", categoryId: "c_food", subcategoryId: "sc_groceries",
        date: "2026-02-28", tags: ["weekly"], payee: "Market", note: "n", description: "d",
      }),
      doc("t_adjust", { userId: "u_ana", type: "adjustment", amount: -300, accountId: "a_checking", date: "2026-03-01" }),
      // A goal contribution's transfer: checking → savings.
      doc("t_out", {
        userId: "u_ana", type: "transfer", amount: 2_000, accountId: "a_checking", destinationAccountId: "a_savings",
        linkedTransactionId: "t_in", transferGroupId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301", date: "2026-03-02",
      }),
      doc("t_in", { userId: "u_ana", type: "transfer", amount: 2_000, accountId: "a_savings", linkedTransactionId: "t_out", transferGroupId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301", date: "2026-03-02" }),
      // Account deleted before the guards.
      doc("t_orphan", { userId: "u_ana", type: "expense", amount: 700, accountId: "a_deleted", categoryId: "c_deleted", date: "2026-03-03" }),
      // Bob's expense on Ana's account and category.
      doc("t_cross", { userId: "u_bob", type: "expense", amount: 400, accountId: "a_checking", categoryId: "c_food", date: "2026-03-04" }),
      // Lone outgoing leg whose destination is gone too: looks incoming after the import.
      doc("t_lone_out", {
        userId: "u_ana", type: "transfer", amount: 900, accountId: "a_checking", destinationAccountId: "a_deleted2",
        linkedTransactionId: "t_deleted", transferGroupId: "legacy-group", date: "2026-03-05",
      }),
      // Lone incoming leg.
      doc("t_lone_in", { userId: "u_ana", type: "transfer", amount: 150, accountId: "a_checking", linkedTransactionId: "t_deleted2", date: "2026-03-06" }),
      // Bob's debt payment expense.
      doc("t_payment", { userId: "u_bob", type: "expense", amount: 1_000, accountId: "a_bob", date: "2026-03-07" }),
      doc("t_ghost", { userId: "u_ghost", type: "income", amount: 1, accountId: "a_ghost", date: "2026-03-08" }),
    ],
    savingsGoals: [
      doc("g_trip", {
        userId: "u_ana", name: "Trip", targetAmount: 100_000, currentAmount: 2_000, targetDate: "2026-12-31",
        linkedAccountId: "a_savings", isVirtual: false, createdAt: "2026-01-02", icon: "plane", color: "#a3e635",
      }),
      doc("g_virtual", { userId: "u_bob", name: "Car", targetAmount: 500_000, currentAmount: 0, isVirtual: true, createdAt: "2026-01-03", archived: true }),
    ],
    goalContributions: [
      doc("gc_1", { userId: "u_ana", goalId: "g_trip", amount: 2_000, date: "2026-03-02", transactionId: "t_out" }),
      // Its transfer was deleted on the transfers page.
      doc("gc_2", { userId: "u_ana", goalId: "g_trip", amount: 500, date: "2026-03-03", transactionId: "t_deleted3", note: "gone" }),
    ],
    debts: [
      doc("d_card", {
        userId: "u_bob", name: "Card", debtType: "credit_card", lender: "Bank", originalAmount: 10_000, currentBalance: 9_000,
        interestRate: 19.9, minimumPayment: 500, dueDate: "2026-04-15", linkedAccountId: "a_checking", createdAt: "2026-01-04",
      }),
    ],
    debtPayments: [
      doc("dp_1", {
        userId: "u_bob", debtId: "d_card", amount: 1_000, principalAmount: 1_000, interestAmount: 0, date: "2026-03-07",
        fromAccountId: "a_bob", sourceTransactionId: "t_payment",
      }),
    ],
    channelIdentities: [
      doc("ci_ana", { userId: "u_ana", channel: "telegram", externalUserId: "111", chatId: "111", scopes: ["finance:read", "finance:write"], linkedAt: T0 + 5_000, consentAt: T0 + 4_000 }),
      doc("ci_ana2", { userId: "u_ana2", channel: "telegram", externalUserId: "222", chatId: "222", username: "ana2", scopes: ["finance:read"], linkedAt: T0 + 1_000, consentAt: T0 }),
      doc("ci_bob_old", { userId: "u_bob", channel: "telegram", externalUserId: "333", chatId: "333", scopes: ["finance:read"], linkedAt: T0, consentAt: T0, unlinkedAt: T0 + 1 }),
    ],
    apiIdempotencyKeys: [doc("ik_1", { userId: "u_ana", key: "k", requestHash: "h", response: null, createdAt: T0 })],
    channelLinkCodes: [],
    agentSessions: [doc("as_1", { userId: "u_ana", identityId: "ci_ana", channel: "telegram", chatId: "111", startedAt: T0, lastActivityAt: T0, messageCount: 1 })],
    agentMessages: [doc("am_1", { userId: "u_ana", sessionId: "as_1", role: "user", content: "{}", seq: 1, createdAt: T0 })],
  };
}

export function asExport(tables: Record<string, Doc[]>): ConvexExport {
  return new Map(Object.entries(tables));
}

const jsonl = (docs: Doc[]) => Buffer.from(docs.map((doc) => `${JSON.stringify(doc)}\n`).join(""));

/** The export as `convex export` unzips it, in a new temp directory. */
export async function writeExportDir(tables: Record<string, Doc[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "convex-export-"));
  await writeFile(join(root, "README.md"), "synthetic export\n");
  await mkdir(join(root, "_tables"));
  await writeFile(join(root, "_tables", "documents.jsonl"), jsonl(Object.keys(tables).map((name, i) => ({ name, id: 10_001 + i }))));
  for (const [table, docs] of Object.entries(tables)) {
    await mkdir(join(root, table));
    await writeFile(join(root, table, "documents.jsonl"), jsonl(docs));
    await writeFile(join(root, table, "generated_schema.jsonl"), '"any"\n');
  }
  return root;
}

/** The export as a zip (deflated entries, directory entries included), in a new temp file. */
export async function writeExportZip(tables: Record<string, Doc[]>): Promise<string> {
  const files: [string, Buffer][] = [["README.md", Buffer.from("synthetic export\n")]];
  for (const [table, docs] of Object.entries(tables)) {
    files.push([`${table}/`, Buffer.alloc(0)], [`${table}/documents.jsonl`, jsonl(docs)]);
  }
  const path = join(await mkdtemp(join(tmpdir(), "convex-export-")), "snapshot.zip");
  await writeFile(path, zip(files));
  return path;
}

/**
 * A minimal zip writer (deflate), enough to feed the reader. `dataDescriptor`
 * writes sizes and CRC after the data, as streaming writers do; `zip64` puts
 * sizes and offsets in zip64 fields and saturates every classic field.
 */
export function zip(files: [string, Buffer][], options: { dataDescriptor?: boolean; zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const U32 = 0xffffffff;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const directory = name.endsWith("/");
    const compressed = directory ? Buffer.alloc(0) : deflateRawSync(content);
    const method = directory ? 0 : 8;
    const flags = options.dataDescriptor ? 0x08 : 0;
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!options.dataDescriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(content.length, 22);
    }
    local.writeUInt16LE(nameBytes.length, 26);
    const record = [local, nameBytes, compressed];
    if (options.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(content.length, 12);
      record.push(descriptor);
    }
    parts.push(...record);

    const extra = Buffer.alloc(options.zip64 ? 28 : 0);
    if (options.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(content.length), 4);
      extra.writeBigUInt64LE(BigInt(compressed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(45, 4);
    entry.writeUInt16LE(45, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(options.zip64 ? U32 : compressed.length, 20);
    entry.writeUInt32LE(options.zip64 ? U32 : content.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(options.zip64 ? U32 : offset, 42);
    central.push(entry, nameBytes, extra);
    offset += record.reduce((sum, part) => sum + part.length, 0);
  }
  const directory = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (options.zip64) {
    end.writeUInt16LE(0xffff, 4);
    end.writeUInt16LE(0xffff, 6);
  }
  end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(options.zip64 ? U32 : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? U32 : offset, 16);
  return Buffer.concat([...parts, directory, ...tail, end]);
}
