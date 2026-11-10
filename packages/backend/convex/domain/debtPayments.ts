import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireOwnedAccount, requireOwnedDebt } from "./debts";

export async function listDebtPayments(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { debtId: Id<"debts"> },
) {
  await requireOwnedDebt(ctx, args.debtId, userId);

  return await ctx.db
    .query("debtPayments")
    .withIndex("by_debtId", (q) => q.eq("debtId", args.debtId))
    .order("desc")
    .take(500);
}

export async function recordDebtPayment(
  ctx: MutationCtx,
  userId: string,
  args: {
    debtId: Id<"debts">;
    amount: number;
    principalAmount?: number;
    interestAmount?: number;
    date: string;
    note?: string;
    fromAccountId: Id<"accounts">;
  },
) {
  if (args.amount <= 0) throw new Error("Amount must be positive");

  const debt = await requireOwnedDebt(ctx, args.debtId, userId);
  const fromAccount = await requireOwnedAccount(ctx, args.fromAccountId, userId);

  const principalAmount = args.principalAmount ?? args.amount;
  const interestAmount = args.interestAmount ?? 0;

  if (principalAmount < 0 || interestAmount < 0) {
    throw new Error("Principal and interest cannot be negative");
  }
  if (principalAmount + interestAmount !== args.amount) {
    throw new Error("Principal and interest must add up to the payment amount");
  }
  if (principalAmount > debt.currentBalance) {
    throw new Error("Principal amount cannot exceed the remaining balance");
  }

  const sourceTransactionId = await ctx.db.insert("transactions", {
    userId,
    type: "expense",
    amount: args.amount,
    accountId: args.fromAccountId,
    date: args.date,
    description: `Debt payment: ${debt.name}`,
    ...(args.note ? { note: args.note } : {}),
  });

  await ctx.db.patch(args.fromAccountId, {
    balance: fromAccount.balance - args.amount,
  });

  let liabilityTransactionId;
  if (debt.linkedAccountId && principalAmount > 0) {
    const liabilityAccount = await requireOwnedAccount(
      ctx,
      debt.linkedAccountId,
      userId,
    );

    liabilityTransactionId = await ctx.db.insert("transactions", {
      userId,
      type: "adjustment",
      amount: -principalAmount,
      accountId: debt.linkedAccountId,
      date: args.date,
      description: `Debt principal payment: ${debt.name}`,
      ...(args.note ? { note: args.note } : {}),
    });

    await ctx.db.patch(debt.linkedAccountId, {
      balance: liabilityAccount.balance - principalAmount,
    });
  }

  const paymentId = await ctx.db.insert("debtPayments", {
    userId,
    debtId: args.debtId,
    amount: args.amount,
    principalAmount,
    interestAmount,
    date: args.date,
    fromAccountId: args.fromAccountId,
    sourceTransactionId,
    ...(args.note ? { note: args.note } : {}),
    ...(liabilityTransactionId ? { liabilityTransactionId } : {}),
  });

  await ctx.db.patch(args.debtId, {
    currentBalance: debt.currentBalance - principalAmount,
  });

  return paymentId;
}

export async function removeDebtPayment(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"debtPayments"> },
) {
  const payment = await ctx.db.get(args.id);
  if (!payment || payment.userId !== userId) {
    throw new Error("Debt payment not found");
  }

  const debt = await requireOwnedDebt(ctx, payment.debtId, userId);

  const sourceTx = await ctx.db.get(payment.sourceTransactionId);
  if (sourceTx) {
    const sourceAccount = await requireOwnedAccount(ctx, sourceTx.accountId, userId);
    await ctx.db.patch(sourceTx.accountId, {
      balance: sourceAccount.balance + sourceTx.amount,
    });
    await ctx.db.delete(sourceTx._id);
  }

  if (payment.liabilityTransactionId) {
    const liabilityTx = await ctx.db.get(payment.liabilityTransactionId);
    if (liabilityTx) {
      const liabilityAccount = await requireOwnedAccount(
        ctx,
        liabilityTx.accountId,
        userId,
      );
      await ctx.db.patch(liabilityTx.accountId, {
        balance: liabilityAccount.balance - liabilityTx.amount,
      });
      await ctx.db.delete(liabilityTx._id);
    }
  }

  await ctx.db.patch(payment.debtId, {
    currentBalance: debt.currentBalance + payment.principalAmount,
  });

  await ctx.db.delete(args.id);
}

