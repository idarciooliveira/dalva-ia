import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** `ConvexError` code for edits to rows owned by the transfer or debt-payment flows. */
export const TRANSACTION_MANAGED = "TRANSACTION_MANAGED";

export type TransactionType = "income" | "expense" | "adjustment" | "transfer";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rows owned by another flow: transfer legs (incl. goal-contribution transfers)
 * and debt-payment source/liability transactions. Plain create/update/delete
 * would leave the owning records (or the paired leg) out of sync.
 */
export async function managedTransactionKind(
  ctx: QueryCtx | MutationCtx,
  tx: Doc<"transactions">,
): Promise<"transfer" | "debt_payment" | null> {
  if (tx.type === "transfer" || tx.transferGroupId || tx.linkedTransactionId) {
    return "transfer";
  }
  const payment =
    (await ctx.db
      .query("debtPayments")
      .withIndex("by_sourceTransactionId", (q) => q.eq("sourceTransactionId", tx._id))
      .first()) ??
    (await ctx.db
      .query("debtPayments")
      .withIndex("by_liabilityTransactionId", (q) => q.eq("liabilityTransactionId", tx._id))
      .first());
  return payment ? "debt_payment" : null;
}

async function assertNotManaged(
  ctx: QueryCtx | MutationCtx,
  tx: Doc<"transactions">,
  action: "update" | "delete",
) {
  const kind = await managedTransactionKind(ctx, tx);
  const message =
    kind === "transfer"
      ? `Use the transfer ${action} for transfers`
      : kind === "debt_payment"
        ? action === "delete"
          ? "Use the debt payment delete for debt payments"
          : "Debt payments can't be edited; delete the payment and record it again"
        : null;
  if (message) throw new ConvexError({ code: TRANSACTION_MANAGED, message });
}

/** Income/expense/transfer amounts are positive integers; only adjustments are signed. */
function assertAmount(type: TransactionType, amount: number) {
  if (type === "adjustment") {
    if (!Number.isFinite(amount)) throw new Error("Amount must be a finite number");
    return;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Amount must be positive");
  }
}

/** Compute the signed balance delta for a transaction. */
function balanceDelta(
  type: TransactionType,
  amount: number,
): number {
  if (type === "income") return amount;
  if (type === "expense") return -amount;
  // adjustment keeps the raw signed amount; transfer is handled externally
  return amount;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Parse "YYYY-MM" → { year, month (0-indexed) } */
function parseMonth(ym: string): { year: number; month: number } {
  const [y, m] = ym.split("-").map(Number);
  return { year: y!, month: m! - 1 };
}

/** Subtract N months from { year, month } and return "YYYY-MM" */
function subtractMonths(
  year: number,
  month: number,
  n: number,
): { year: number; month: number } {
  let y = year;
  let m = month - n;
  while (m < 0) {
    m += 12;
    y -= 1;
  }
  return { year: y, month: m };
}

/** Format { year, month (0-indexed) } → "YYYY-MM" */
function formatYM(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * Create a new transaction and update the linked account's balance.
 */
export async function createTransaction(
  ctx: MutationCtx,
  userId: string,
  args: {
    type: TransactionType;
    amount: number;
    accountId: Id<"accounts">;
    categoryId?: Id<"categories">;
    subcategoryId?: Id<"subcategories">;
    date: string;
    description?: string;
    note?: string;
    payee?: string;
  },
) {
  if (args.type === "transfer") {
    throw new Error("Use the transfer create for transfers");
  }
  assertAmount(args.type, args.amount);

  // Validate account ownership
  const account = await ctx.db.get(args.accountId);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  if (args.type === "adjustment") {
    if (args.categoryId) {
      throw new Error("Adjustments cannot have a category");
    }
    if (args.subcategoryId) {
      throw new Error("Adjustments cannot have a subcategory");
    }
  }

  // Validate category ownership (if provided)
  if (args.categoryId) {
    const category = await ctx.db.get(args.categoryId);
    if (!category || category.userId !== userId) {
      throw new Error("Category not found");
    }
  }

  // Validate subcategory ownership (if provided)
  if (args.subcategoryId) {
    const subcategory = await ctx.db.get(args.subcategoryId);
    if (!subcategory || subcategory.userId !== userId) {
      throw new Error("Subcategory not found");
    }
  }

  // Insert the transaction
  const txId = await ctx.db.insert("transactions", {
    userId,
    type: args.type,
    amount: args.amount,
    accountId: args.accountId,
    date: args.date,
    ...(args.categoryId ? { categoryId: args.categoryId } : {}),
    ...(args.subcategoryId ? { subcategoryId: args.subcategoryId } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.payee ? { payee: args.payee } : {}),
  });

  // Update account balance
  const delta = balanceDelta(args.type, args.amount);
  await ctx.db.patch(args.accountId, {
    balance: account.balance + delta,
  });

  return txId;
}

/**
 * Update a transaction. Reverses old balance effect and applies new one.
 */
export async function updateTransaction(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"transactions">;
    type?: TransactionType;
    amount?: number;
    accountId?: Id<"accounts">;
    categoryId?: Id<"categories">;
    subcategoryId?: Id<"subcategories">;
    date?: string;
    description?: string;
    note?: string;
    payee?: string;
  },
) {
  // Fetch existing transaction
  const tx = await ctx.db.get(args.id);
  if (!tx || tx.userId !== userId) {
    throw new Error("Transaction not found");
  }
  await assertNotManaged(ctx, tx, "update");
  if (args.type === "transfer") {
    throw new Error("Use the transfer create for transfers");
  }

  if (args.type === "adjustment") {
    if (args.categoryId) {
      throw new Error("Adjustments cannot have a category");
    }
    if (args.subcategoryId) {
      throw new Error("Adjustments cannot have a subcategory");
    }
  }

  // If account is changing, validate new account ownership
  const newAccountId = args.accountId ?? tx.accountId;
  if (args.accountId && args.accountId !== tx.accountId) {
    const newAccount = await ctx.db.get(args.accountId);
    if (!newAccount || newAccount.userId !== userId) {
      throw new Error("Account not found");
    }
  }

  // Determine old and new values
  const oldType = tx.type;
  const oldAmount = tx.amount;
  const oldAccountId = tx.accountId;

  const newType = args.type ?? oldType;
  const newAmount = args.amount ?? oldAmount;
  assertAmount(newType, newAmount);

  if (newType === "adjustment") {
    const nextCategoryId = args.categoryId ?? tx.categoryId;
    const nextSubcategoryId = args.subcategoryId ?? tx.subcategoryId;
    if (nextCategoryId) {
      throw new Error("Adjustments cannot have a category");
    }
    if (nextSubcategoryId) {
      throw new Error("Adjustments cannot have a subcategory");
    }
  }

  // --- Reverse old balance effect on old account ---
  const oldDelta = balanceDelta(oldType, oldAmount);
  const oldAccount = await ctx.db.get(oldAccountId);
  if (oldAccount) {
    await ctx.db.patch(oldAccountId, {
      balance: oldAccount.balance - oldDelta,
    });
  }

  // --- Apply new balance effect on new account ---
  const newDelta = balanceDelta(newType, newAmount);
  // Re-fetch the target account (may be the same, balance was just updated)
  const targetAccount = await ctx.db.get(newAccountId);
  if (targetAccount) {
    await ctx.db.patch(newAccountId, {
      balance: targetAccount.balance + newDelta,
    });
  }

  // --- Patch the transaction fields ---
  const patch: Record<string, unknown> = {};
  if (args.type !== undefined) patch.type = args.type;
  if (args.amount !== undefined) patch.amount = args.amount;
  if (args.accountId !== undefined) patch.accountId = args.accountId;
  if (newType === "adjustment") {
    patch.categoryId = undefined;
    patch.subcategoryId = undefined;
  } else if (args.categoryId !== undefined) {
    patch.categoryId = args.categoryId;
  }
  if (newType !== "adjustment" && args.subcategoryId !== undefined)
    patch.subcategoryId = args.subcategoryId;
  if (args.date !== undefined) patch.date = args.date;
  if (args.description !== undefined) patch.description = args.description;
  if (args.note !== undefined) patch.note = args.note;
  if (args.payee !== undefined) patch.payee = args.payee;

  await ctx.db.patch(args.id, patch);
}

/**
 * Delete a transaction and reverse its balance effect.
 */
export async function deleteTransaction(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"transactions"> },
) {
  const tx = await ctx.db.get(args.id);
  if (!tx || tx.userId !== userId) {
    throw new Error("Transaction not found");
  }
  await assertNotManaged(ctx, tx, "delete");

  // Reverse balance effect
  const delta = balanceDelta(tx.type, tx.amount);
  const account = await ctx.db.get(tx.accountId);
  if (account) {
    await ctx.db.patch(tx.accountId, {
      balance: account.balance - delta,
    });
  }

  await ctx.db.delete(args.id);
}

/**
 * List transactions for the current user, sorted by date descending.
 * Supports optional filters (dateFrom, dateTo, accountId, categoryId, type).
 * Returns `{ page: [...] }` — no cursor-based pagination yet (uses .take()).
 */
export async function listTransactions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: {
    dateFrom?: string;
    dateTo?: string;
    accountId?: Id<"accounts">;
    categoryId?: Id<"categories">;
    type?: TransactionType;
    paginationOpts?: { numItems: number; cursor: string | null };
  },
) {
  // Use the by_userId_and_date index for efficient querying + sort
  let txs = await ctx.db
    .query("transactions")
    .withIndex("by_userId_and_date", (q) => q.eq("userId", userId))
    .order("desc")
    .take(200);

  // Apply filters in memory
  if (args.dateFrom) {
    txs = txs.filter((tx) => tx.date >= args.dateFrom!);
  }
  if (args.dateTo) {
    txs = txs.filter((tx) => tx.date <= args.dateTo!);
  }
  if (args.accountId) {
    txs = txs.filter((tx) => tx.accountId === args.accountId);
  }
  if (args.categoryId) {
    txs = txs.filter((tx) => tx.categoryId === args.categoryId);
  }
  if (args.type) {
    txs = txs.filter((tx) => tx.type === args.type);
  }

  // Apply simple limit
  const numItems = args.paginationOpts?.numItems ?? 50;
  const page = txs.slice(0, numItems);

  return { page, isDone: page.length < numItems, continueCursor: null };
}

/**
 * How each report reads its rows. Shared with `reportAccountIds` so callers
 * can see exactly which accounts fed a report (for currency checks).
 */
export const REPORT_READS = {
  summary: { order: "desc", take: 200, types: ["income", "expense", "adjustment"] },
  spending: { order: "asc", take: 500, types: ["expense"] },
  cashflow: { order: "asc", take: 2000, types: ["income", "expense"] },
} as const satisfies Record<string, { order: "asc" | "desc"; take: number; types: readonly TransactionType[] }>;

/**
 * Accounts of the rows a report aggregates: the same index range, order and
 * bound as the report, restricted to the types it sums.
 */
export async function reportAccountIds(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { report: keyof typeof REPORT_READS; dateFrom: string; dateTo: string },
) {
  const read = REPORT_READS[args.report];
  const txs = await ctx.db
    .query("transactions")
    .withIndex("by_userId_and_date", (q) =>
      q.eq("userId", userId).gte("date", args.dateFrom).lte("date", args.dateTo),
    )
    .order(read.order)
    .take(read.take);
  const types: readonly TransactionType[] = read.types;
  return [...new Set(txs.filter((tx) => types.includes(tx.type)).map((tx) => tx.accountId))];
}

/**
 * Get a monthly transaction summary: total income, total expenses,
 * and recent transactions for the given month (format: "YYYY-MM").
 */
export async function getTransactionSummary(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { month: string },
) {
  // Derive date range from month string (e.g. "2026-04" → "2026-04-01".."2026-04-31")
  const dateFrom = `${args.month}-01`;
  const dateTo = `${args.month}-31`; // safe upper bound; 31 works for all months

  const txs = await ctx.db
    .query("transactions")
    .withIndex("by_userId_and_date", (q) =>
      q.eq("userId", userId).gte("date", dateFrom).lte("date", dateTo),
    )
    .order("desc")
    .take(REPORT_READS.summary.take);

  let totalIncome = 0;
  let totalExpenses = 0;
  let totalAdjustments = 0;
  for (const tx of txs) {
    if (tx.type === "income") totalIncome += tx.amount;
    else if (tx.type === "expense") totalExpenses += tx.amount;
    else if (tx.type === "adjustment") totalAdjustments += tx.amount;
    // transfers are excluded from income/expense/adjustment totals
  }

  return {
    totalIncome,
    totalExpenses,
    totalAdjustments,
    recentTransactions: txs.slice(0, 10),
  };
}

/**
 * Get spending aggregated by category for a given month.
 * Only includes expense transactions. Returns categories sorted by amount descending.
 */
export async function getSpendingByCategory(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { month: string },
) {
  const dateFrom = `${args.month}-01`;
  const dateTo = `${args.month}-31`;

  const txs = await ctx.db
    .query("transactions")
    .withIndex("by_userId_and_date", (q) =>
      q.eq("userId", userId).gte("date", dateFrom).lte("date", dateTo),
    )
    .take(REPORT_READS.spending.take);

  // Aggregate expense amounts by categoryId
  const categoryTotals = new Map<string, number>(); // categoryId → total amount
  let total = 0;

  for (const tx of txs) {
    if (tx.type !== "expense") continue;
    const key = tx.categoryId ?? "__uncategorized__";
    categoryTotals.set(key, (categoryTotals.get(key) ?? 0) + tx.amount);
    total += tx.amount;
  }

  // Resolve category names
  const categories: Array<{ name: string; amount: number; categoryId: string | null }> = [];
  for (const [key, amount] of categoryTotals) {
    if (key === "__uncategorized__") {
      categories.push({ name: "Uncategorized", amount, categoryId: null });
    } else {
      const cat = await ctx.db.get(key as Id<"categories">);
      categories.push({
        name: cat?.name ?? "Unknown",
        amount,
        categoryId: key,
      });
    }
  }

  // Sort descending by amount
  categories.sort((a, b) => b.amount - a.amount);

  return { categories, total };
}

/**
 * Get cashflow data: income vs expenses for the current month plus a
 * configurable number of trailing months for the trend chart.
 */
export async function getCashflow(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: {
    month: string; // e.g. "2026-04"
    trendMonths?: number; // how many months in the trend (default 6)
  },
) {
  const numMonths = args.trendMonths ?? 6;
  const { year, month } = parseMonth(args.month);

  // Build the list of months to include
  const months: Array<{ year: number; month: number; label: string; key: string }> = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    const { year: y, month: m } = subtractMonths(year, month, i);
    months.push({
      year: y,
      month: m,
      label: MONTH_LABELS[m]!,
      key: formatYM(y, m),
    });
  }

  // Determine overall date range for the query
  const firstMonth = months[0]!;
  const lastMonth = months[months.length - 1]!;
  const dateFrom = `${formatYM(firstMonth.year, firstMonth.month)}-01`;
  const dateTo = `${formatYM(lastMonth.year, lastMonth.month)}-31`;

  // Fetch all transactions in the date range
  const txs = await ctx.db
    .query("transactions")
    .withIndex("by_userId_and_date", (q) =>
      q.eq("userId", userId).gte("date", dateFrom).lte("date", dateTo),
    )
    .take(REPORT_READS.cashflow.take);

  // Initialize buckets
  const buckets = new Map<string, { income: number; expenses: number }>();
  for (const m of months) {
    buckets.set(m.key, { income: 0, expenses: 0 });
  }

  // Aggregate
  for (const tx of txs) {
    if (tx.type === "adjustment") continue;
    const txMonth = tx.date.substring(0, 7); // "YYYY-MM"
    const bucket = buckets.get(txMonth);
    if (!bucket) continue;
    if (tx.type === "income") bucket.income += tx.amount;
    else if (tx.type === "expense") bucket.expenses += tx.amount;
  }

  // Build trend array
  const trend = months.map((m) => {
    const bucket = buckets.get(m.key)!;
    return {
      month: m.label,
      income: bucket.income,
      expenses: bucket.expenses,
    };
  });

  // Current month is the last entry
  const current = buckets.get(formatYM(year, month))!;

  return {
    currentMonth: {
      income: current.income,
      expenses: current.expenses,
      net: current.income - current.expenses,
    },
    trend,
  };
}


/* -------------------------------------------------------------------------- */
/*  Search (cursor-paginated)                                                 */
/* -------------------------------------------------------------------------- */

/** Rows read per page at most, matching or not. Bounds the cost of sparse filters and `q`. */
export const SEARCH_SCAN_LIMIT = 1000;

/**
 * Last row read: its `date` and `_creationTime`, plus the rows already read at
 * exactly that position (`_creationTime` is not guaranteed unique). `seen` holds
 * their ids, so deleting or moving one of them between pages can't make the
 * next page skip another; past `MAX_TIE_IDS` (cursor size cap) it degrades to
 * a count.
 */
export type SearchPosition = { date: string; creationTime: number; seen: string[] | number };

const MAX_TIE_IDS = 6;
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function encodeSearchCursor(position: SearchPosition): string {
  return btoa(JSON.stringify([position.date, position.creationTime, position.seen]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeSearchCursor(cursor: string): SearchPosition {
  try {
    const value: unknown = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === "string" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[1]) &&
      ((Number.isSafeInteger(value[2]) && value[2] > MAX_TIE_IDS) ||
        (Array.isArray(value[2]) &&
          value[2].length >= 1 &&
          value[2].length <= MAX_TIE_IDS &&
          value[2].every((id: unknown) => typeof id === "string" && CURSOR_ID_RE.test(id))))
    ) {
      return { date: value[0], creationTime: value[1], seen: value[2] };
    }
  } catch {
    // fall through
  }
  throw new Error("Invalid cursor");
}

/**
 * Search a user's transactions, newest first (`date` desc, then creation
 * order desc), with an opaque keyset cursor.
 *
 * - Uses the most selective index for the filters (account > category >
 *   type > user); the date range is always part of the index range, and the
 *   remaining filters and the `q` text match (case-insensitive substring of
 *   description, note or payee) run on the scanned rows.
 * - Each page reads at most `SEARCH_SCAN_LIMIT` rows. When filters are sparse
 *   the page can come back short (even empty) with a non-null `nextCursor`;
 *   the cursor always resumes right after the last row read, so no row is
 *   skipped or repeated. Rows sharing a `_creationTime` are told apart by
 *   the ids already read at that position. `nextCursor` is null only when the range is exhausted.
 */
export async function searchTransactions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: {
    dateFrom?: string;
    dateTo?: string;
    accountId?: Id<"accounts">;
    categoryId?: Id<"categories">;
    type?: TransactionType;
    q?: string;
    cursor?: string;
    limit: number;
    scanLimit?: number;
  },
) {
  const after = args.cursor ? decodeSearchCursor(args.cursor) : null;
  const scanLimit = args.scanLimit ?? SEARCH_SCAN_LIMIT;
  const needle = args.q?.toLowerCase();

  // Index range for one date segment: `eqDate` (rows on the cursor's date
  // created at or before it) or `[dateFrom, below)` / `[dateFrom, dateTo]`.
  type Segment = { eqDate: string; atOrBefore: number } | { below?: string };
  const query = (segment: Segment) => {
    // The four indexes share the shape [userId, <filter>?, date, _creationTime];
    // the builder type differs per index, so the range is applied untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const range = (q: any) => {
      if ("eqDate" in segment) return q.eq("date", segment.eqDate).lte("_creationTime", segment.atOrBefore);
      let r = q;
      if (args.dateFrom) r = r.gte("date", args.dateFrom);
      if (segment.below !== undefined) r = r.lt("date", segment.below);
      else if (args.dateTo) r = r.lte("date", args.dateTo);
      return r;
    };
    const table = ctx.db.query("transactions");
    if (args.accountId) {
      const accountId = args.accountId;
      return table.withIndex("by_userId_and_accountId_and_date", (q) => range(q.eq("userId", userId).eq("accountId", accountId))).order("desc");
    }
    if (args.categoryId) {
      const categoryId = args.categoryId;
      return table.withIndex("by_userId_and_categoryId_and_date", (q) => range(q.eq("userId", userId).eq("categoryId", categoryId))).order("desc");
    }
    if (args.type) {
      const type = args.type;
      return table.withIndex("by_userId_and_type_and_date", (q) => range(q.eq("userId", userId).eq("type", type))).order("desc");
    }
    return table.withIndex("by_userId_and_date", (q) => range(q.eq("userId", userId))).order("desc");
  };

  const segments: Segment[] = [];
  if (after) {
    const inRange =
      (!args.dateFrom || after.date >= args.dateFrom) && (!args.dateTo || after.date <= args.dateTo);
    if (inRange) segments.push({ eqDate: after.date, atOrBefore: after.creationTime });
    // Rows strictly older than the cursor date, clipped to dateTo.
    const below = args.dateTo && args.dateTo < after.date ? undefined : after.date;
    segments.push(below === undefined ? {} : { below });
  } else {
    segments.push({});
  }

  const matches = (tx: Doc<"transactions">) =>
    tx.userId === userId &&
    (!args.accountId || tx.accountId === args.accountId) &&
    (!args.categoryId || tx.categoryId === args.categoryId) &&
    (!args.type || tx.type === args.type) &&
    (!needle ||
      [tx.description, tx.note, tx.payee].some((field) => field?.toLowerCase().includes(needle)));

  return await collectSearchPage(
    segments.map((segment) => () => query(segment)),
    after,
    { limit: args.limit, scanLimit, matches },
  );
}

/**
 * Read rows in index order from consecutive sources and build one page.
 * Pure over its inputs (exported for tests): the cursor encodes the last row
 * read, and rows already read at the cursor's exact position are skipped.
 */
export async function collectSearchPage<R extends { _id: string; date: string; _creationTime: number }>(
  sources: Array<() => AsyncIterable<R>>,
  after: SearchPosition | null,
  options: { limit: number; scanLimit: number; matches: (row: R) => boolean },
): Promise<{ items: R[]; nextCursor: string | null }> {
  const { limit, scanLimit, matches } = options;
  const items: R[] = [];
  let last: SearchPosition | null = after;
  const seenAtCursor = Array.isArray(after?.seen) ? new Set(after.seen) : null;
  let countToSkip = typeof after?.seen === "number" ? after.seen : 0;
  let scanned = 0;
  for (const source of sources) {
    for await (const row of source()) {
      if (after && row.date === after.date && row._creationTime === after.creationTime) {
        if (seenAtCursor?.has(row._id)) continue;
        if (countToSkip > 0) {
          countToSkip--;
          continue;
        }
      }
      if (scanned >= scanLimit || (items.length === limit && matches(row))) {
        return { items, nextCursor: encodeSearchCursor(last!) };
      }
      scanned++;
      if (matches(row)) items.push(row);
      const prior = last && row.date === last.date && row._creationTime === last.creationTime ? last.seen : null;
      let seen: string[] | number = [row._id];
      if (typeof prior === "number") seen = prior + 1;
      else if (prior) seen = prior.length < MAX_TIE_IDS ? [...prior, row._id] : prior.length + 1;
      last = { date: row.date, creationTime: row._creationTime, seen };
    }
  }
  return { items, nextCursor: null };
}
