import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * List contributions for a specific savings goal.
 * Validates goal ownership.
 */
export async function listContributions(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { goalId: Id<"savingsGoals"> },
) {
  // Validate goal ownership
  const goal = await ctx.db.get(args.goalId);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  return await ctx.db
    .query("goalContributions")
    .withIndex("by_goalId", (q) => q.eq("goalId", args.goalId))
    .take(500);
}

/**
 * Add a contribution to a savings goal.
 *
 * - For virtual goals: simply records the contribution and updates currentAmount.
 * - For linked goals: creates a transfer from `fromAccountId` to the goal's
 *   linked account, then records the contribution with the transfer's
 *   outgoing transaction ID.
 */
export async function addContribution(
  ctx: MutationCtx,
  userId: string,
  args: {
    goalId: Id<"savingsGoals">;
    amount: number; // in minor units (cents)
    date: string; // ISO date
    note?: string;
    fromAccountId?: Id<"accounts">; // required for linked goals
  },
) {
  if (args.amount <= 0) throw new Error("Amount must be positive");

  // Validate goal ownership
  const goal = await ctx.db.get(args.goalId);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  let transactionId: string | undefined;

  if (!goal.isVirtual && goal.linkedAccountId) {
    // Linked goal: create a transfer
    if (!args.fromAccountId) {
      throw new Error(
        "Source account is required for account-linked goal contributions",
      );
    }

    // Validate source account ownership
    const fromAccount = await ctx.db.get(args.fromAccountId);
    if (!fromAccount || fromAccount.userId !== userId) {
      throw new Error("Account not found");
    }

    // Validate destination (linked) account
    const toAccount = await ctx.db.get(goal.linkedAccountId);
    if (!toAccount || toAccount.userId !== userId) {
      throw new Error("Linked account not found");
    }

    if (args.fromAccountId === goal.linkedAccountId) {
      throw new Error("Cannot transfer to the same account");
    }

    // Generate a shared transfer group ID
    const transferGroupId = crypto.randomUUID();

    // Create outgoing transaction (source, debit)
    const outgoingId = await ctx.db.insert("transactions", {
      userId,
      type: "transfer",
      amount: args.amount,
      accountId: args.fromAccountId,
      destinationAccountId: goal.linkedAccountId,
      transferGroupId,
      date: args.date,
      description: `Savings: ${goal.name}`,
      ...(args.note ? { note: args.note } : {}),
    });

    // Create incoming transaction (destination, credit)
    const incomingId = await ctx.db.insert("transactions", {
      userId,
      type: "transfer",
      amount: args.amount,
      accountId: goal.linkedAccountId,
      transferGroupId,
      linkedTransactionId: outgoingId,
      date: args.date,
      description: `Savings: ${goal.name}`,
      ...(args.note ? { note: args.note } : {}),
    });

    // Link outgoing → incoming
    await ctx.db.patch(outgoingId, { linkedTransactionId: incomingId });

    // Update account balances
    await ctx.db.patch(args.fromAccountId, {
      balance: fromAccount.balance - args.amount,
    });
    await ctx.db.patch(goal.linkedAccountId, {
      balance: toAccount.balance + args.amount,
    });

    transactionId = outgoingId;
  }

  // Record the contribution
  const contributionId = await ctx.db.insert("goalContributions", {
    userId,
    goalId: args.goalId,
    amount: args.amount,
    date: args.date,
    ...(args.note ? { note: args.note } : {}),
    ...(transactionId ? { transactionId: transactionId as any } : {}),
  });

  // Update goal's currentAmount
  await ctx.db.patch(args.goalId, {
    currentAmount: goal.currentAmount + args.amount,
  });

  return contributionId;
}

/**
 * Remove a contribution from a savings goal.
 *
 * - Decreases the goal's currentAmount.
 * - For linked goals: also deletes the associated transfer and reverses
 *   the balance effects on both accounts.
 */
export async function removeContribution(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"goalContributions"> },
) {
  const contribution = await ctx.db.get(args.id);
  if (!contribution || contribution.userId !== userId) {
    throw new Error("Contribution not found");
  }

  // Get the goal
  const goal = await ctx.db.get(contribution.goalId);
  if (!goal) throw new Error("Goal not found");

  // If there's a linked transaction, reverse the transfer
  if (contribution.transactionId) {
    const tx = await ctx.db.get(contribution.transactionId);
    if (tx && tx.type === "transfer") {
      // Find the paired transaction
      const linkedId = tx.linkedTransactionId;
      const linkedTx = linkedId ? await ctx.db.get(linkedId) : null;

      // Determine outgoing (has destinationAccountId) vs incoming
      const outgoing = tx.destinationAccountId ? tx : linkedTx;
      const incoming = tx.destinationAccountId ? linkedTx : tx;

      // Reverse balances
      if (outgoing) {
        const fromAccount = await ctx.db.get(outgoing.accountId);
        if (fromAccount) {
          await ctx.db.patch(outgoing.accountId, {
            balance: fromAccount.balance + outgoing.amount,
          });
        }
      }

      if (incoming && incoming._id !== outgoing?._id) {
        const toAccount = await ctx.db.get(incoming.accountId);
        if (toAccount) {
          await ctx.db.patch(incoming.accountId, {
            balance: toAccount.balance - incoming.amount,
          });
        }
      }

      // Delete both transfer transactions
      if (outgoing) await ctx.db.delete(outgoing._id);
      if (incoming && incoming._id !== outgoing?._id) {
        await ctx.db.delete(incoming._id);
      }
    }
  }

  // Update goal's currentAmount
  const newAmount = Math.max(0, goal.currentAmount - contribution.amount);
  await ctx.db.patch(contribution.goalId, { currentAmount: newAmount });

  // Delete the contribution
  await ctx.db.delete(args.id);
}

