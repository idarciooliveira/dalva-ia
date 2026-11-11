import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** `ConvexError` code for deleting an account that other records still reference. */
export const ACCOUNT_IN_USE = "ACCOUNT_IN_USE";

export type AccountType = Doc<"accounts">["type"];

/**
 * List all accounts for a user.
 * Excludes archived accounts by default.
 */
export async function listAccounts(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { includeArchived?: boolean },
) {
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100);

  if (args.includeArchived) return accounts;

  return accounts.filter((a) => !a.archived);
}

/**
 * Get a single account by ID.
 * Validates ownership — throws "Account not found" if the account
 * doesn't exist or doesn't belong to the user.
 */
export async function getAccount(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { id: Id<"accounts"> },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }
  return account;
}

/**
 * Create a new financial account for a user.
 */
export async function createAccount(
  ctx: MutationCtx,
  userId: string,
  args: {
    name: string;
    type: AccountType;
    balance: number; // in minor units (cents)
    currency: string; // ISO 4217
    theme?: string; // visual theme id
  },
) {
  return await ctx.db.insert("accounts", {
    userId,
    name: args.name,
    type: args.type,
    balance: args.balance,
    currency: args.currency,
    ...(args.theme ? { theme: args.theme } : {}),
  });
}

/**
 * Update an existing account's editable fields.
 */
export async function updateAccount(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"accounts">;
    name?: string;
    type?: AccountType;
    theme?: string;
    icon?: string;
    description?: string;
  },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  const { id, ...fields } = args;
  // Only patch fields that were actually provided
  const patch: Record<string, string> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.type !== undefined) patch.type = fields.type;
  if (fields.theme !== undefined) patch.theme = fields.theme;
  if (fields.icon !== undefined) patch.icon = fields.icon;
  if (fields.description !== undefined) patch.description = fields.description;

  await ctx.db.patch(args.id, patch);
}

/**
 * Archive an account (soft-delete).
 */
export async function archiveAccount(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"accounts"> },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  await ctx.db.patch(args.id, { archived: true });
}

/**
 * Restore an archived account.
 */
export async function restoreAccount(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"accounts"> },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  await ctx.db.patch(args.id, { archived: false });
}

/**
 * Permanently delete an account. Only allowed while nothing references it.
 */
export async function deleteAccount(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"accounts"> },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  // Transfer legs, goal contributions and debt payments all hang off a
  // transaction on this account, so one indexed lookup covers them.
  const referenced =
    (await ctx.db
      .query("transactions")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.id))
      .first()) ??
    (await ctx.db
      .query("savingsGoals")
      .withIndex("by_linkedAccountId", (q) => q.eq("linkedAccountId", args.id))
      .first()) ??
    (await ctx.db
      .query("debts")
      .withIndex("by_linkedAccountId", (q) => q.eq("linkedAccountId", args.id))
      .first());
  if (referenced) {
    throw new ConvexError({
      code: ACCOUNT_IN_USE,
      message:
        "Account has transactions, goals or debts linked to it. Archive it instead of deleting",
    });
  }

  await ctx.db.delete(args.id);
}

/**
 * Adjust an account's balance by a delta (positive or negative, in cents).
 * Used for manual balance corrections / reconciliation.
 */
export async function adjustBalance(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"accounts">;
    amount: number; // delta in cents (positive = add, negative = subtract)
    date?: string;
    note?: string;
  },
) {
  const account = await ctx.db.get(args.id);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }

  await ctx.db.insert("transactions", {
    userId,
    type: "adjustment",
    amount: args.amount,
    accountId: args.id,
    date: args.date ?? new Date().toISOString().slice(0, 10),
    description: "Balance adjustment",
    ...(args.note ? { note: args.note } : {}),
  });

  await ctx.db.patch(args.id, { balance: account.balance + args.amount });
}
