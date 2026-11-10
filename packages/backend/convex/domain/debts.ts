import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type DebtType =
  | "credit_card"
  | "loan"
  | "mortgage"
  | "student_loan"
  | "personal_loan"
  | "other";

export async function requireOwnedDebt(
  ctx: QueryCtx | MutationCtx,
  debtId: Id<"debts">,
  userId: string,
) {
  const debt = await ctx.db.get(debtId);
  if (!debt || debt.userId !== userId) {
    throw new Error("Debt not found");
  }
  return debt;
}

export async function requireOwnedAccount(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  userId: string,
) {
  const account = await ctx.db.get(accountId);
  if (!account || account.userId !== userId) {
    throw new Error("Account not found");
  }
  return account;
}

function validateDebtAmounts(originalAmount: number, currentBalance: number) {
  if (originalAmount <= 0) {
    throw new Error("Original amount must be positive");
  }
  if (currentBalance < 0) {
    throw new Error("Current balance cannot be negative");
  }
  if (currentBalance > originalAmount) {
    throw new Error("Current balance cannot exceed original amount");
  }
}

function compareDebtDates(a: { dueDate?: string; createdAt: string }, b: { dueDate?: string; createdAt: string }) {
  if (a.dueDate && b.dueDate) {
    return a.dueDate.localeCompare(b.dueDate);
  }

  // Debts without a due date should come after dated debts, while retaining
  // a deterministic order for debts in the same group.
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return a.createdAt.localeCompare(b.createdAt);
}

function sortDebts<T extends { currentBalance: number; dueDate?: string; createdAt: string }>(debts: T[]) {
  return [...debts].sort((a, b) => {
    const aCompleted = a.currentBalance === 0;
    const bCompleted = b.currentBalance === 0;

    if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
    return compareDebtDates(a, b);
  });
}

export async function listDebts(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { includeArchived?: boolean },
) {
  const debts = await ctx.db
    .query("debts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100);

  const visibleDebts = args.includeArchived
    ? debts
    : debts.filter((debt) => !debt.archived);

  return sortDebts(visibleDebts);
}

export async function getDebt(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { id: Id<"debts"> },
) {
  return requireOwnedDebt(ctx, args.id, userId);
}

export async function createDebt(
  ctx: MutationCtx,
  userId: string,
  args: {
    name: string;
    debtType: DebtType;
    lender?: string;
    originalAmount: number;
    currentBalance: number;
    interestRate?: number;
    minimumPayment?: number;
    dueDate?: string;
    linkedAccountId?: Id<"accounts">;
  },
) {
  validateDebtAmounts(args.originalAmount, args.currentBalance);

  if (args.linkedAccountId) {
    await requireOwnedAccount(ctx, args.linkedAccountId, userId);
  }

  return await ctx.db.insert("debts", {
    userId,
    name: args.name,
    debtType: args.debtType,
    originalAmount: args.originalAmount,
    currentBalance: args.currentBalance,
    createdAt: new Date().toISOString().slice(0, 10),
    ...(args.lender ? { lender: args.lender } : {}),
    ...(args.interestRate !== undefined
      ? { interestRate: args.interestRate }
      : {}),
    ...(args.minimumPayment !== undefined
      ? { minimumPayment: args.minimumPayment }
      : {}),
    ...(args.dueDate ? { dueDate: args.dueDate } : {}),
    ...(args.linkedAccountId ? { linkedAccountId: args.linkedAccountId } : {}),
  });
}

export async function updateDebt(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"debts">;
    name?: string;
    debtType?: DebtType;
    lender?: string;
    originalAmount?: number;
    currentBalance?: number;
    interestRate?: number;
    minimumPayment?: number;
    dueDate?: string;
    linkedAccountId?: Id<"accounts">;
  },
) {
  const debt = await requireOwnedDebt(ctx, args.id, userId);
  const nextOriginalAmount = args.originalAmount ?? debt.originalAmount;
  const nextCurrentBalance = args.currentBalance ?? debt.currentBalance;
  validateDebtAmounts(nextOriginalAmount, nextCurrentBalance);

  if (args.linkedAccountId) {
    await requireOwnedAccount(ctx, args.linkedAccountId, userId);
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.debtType !== undefined) patch.debtType = args.debtType;
  if (args.lender !== undefined) patch.lender = args.lender;
  if (args.originalAmount !== undefined) patch.originalAmount = args.originalAmount;
  if (args.currentBalance !== undefined) patch.currentBalance = args.currentBalance;
  if (args.interestRate !== undefined) patch.interestRate = args.interestRate;
  if (args.minimumPayment !== undefined) patch.minimumPayment = args.minimumPayment;
  if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
  if (args.linkedAccountId !== undefined) patch.linkedAccountId = args.linkedAccountId;

  await ctx.db.patch(args.id, patch);
}

export async function archiveDebt(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"debts"> },
) {
  await requireOwnedDebt(ctx, args.id, userId);
  await ctx.db.patch(args.id, { archived: true });
}

export async function restoreDebt(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"debts"> },
) {
  await requireOwnedDebt(ctx, args.id, userId);
  await ctx.db.patch(args.id, { archived: false });
}

export async function deleteDebt(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"debts"> },
) {
  await requireOwnedDebt(ctx, args.id, userId);

  const payments = await ctx.db
    .query("debtPayments")
    .withIndex("by_debtId", (q) => q.eq("debtId", args.id))
    .take(500);

  for (const payment of payments) {
    const sourceTx = await ctx.db.get(payment.sourceTransactionId);
    if (sourceTx) {
      const sourceAccount = await ctx.db.get(sourceTx.accountId);
      if (sourceAccount) {
        await ctx.db.patch(sourceTx.accountId, {
          balance: sourceAccount.balance + sourceTx.amount,
        });
      }
      await ctx.db.delete(sourceTx._id);
    }

    if (payment.liabilityTransactionId) {
      const liabilityTx = await ctx.db.get(payment.liabilityTransactionId);
      if (liabilityTx) {
        const liabilityAccount = await ctx.db.get(liabilityTx.accountId);
        if (liabilityAccount) {
          await ctx.db.patch(liabilityTx.accountId, {
            balance: liabilityAccount.balance - liabilityTx.amount,
          });
        }
        await ctx.db.delete(liabilityTx._id);
      }
    }

    await ctx.db.delete(payment._id);
  }

  await ctx.db.delete(args.id);
}

export async function getDebtSummary(
  ctx: QueryCtx | MutationCtx,
  userId: string,
) {
  const debts = (await ctx.db
    .query("debts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100))
    .filter((debt) => !debt.archived);

  const payments = await ctx.db
    .query("debtPayments")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .order("desc")
    .take(50);

  const totalOriginal = debts.reduce((sum, debt) => sum + debt.originalAmount, 0);
  const totalRemaining = debts.reduce((sum, debt) => sum + debt.currentBalance, 0);
  const recentPayment = payments[0]?.amount ?? 0;
  const currency = "USD";

  return {
    totalOriginal,
    totalRemaining,
    recentPayment,
    currency,
    debts: [...debts]
      .sort((a, b) => b.currentBalance - a.currentBalance)
      .slice(0, 5)
      .map((debt) => ({
        id: debt._id,
        name: debt.name,
        creditor: debt.lender ?? "Unknown lender",
        originalAmount: debt.originalAmount,
        currentBalance: debt.currentBalance,
        percentPaid:
          debt.originalAmount === 0
            ? 0
            : Math.round(
                ((debt.originalAmount - debt.currentBalance) / debt.originalAmount) * 100,
              ),
      })),
  };
}

