import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Create a transfer between two accounts.
 *
 * This creates two linked "transfer" transactions:
 * - An outgoing transaction on the source account (debit)
 * - An incoming transaction on the destination account (credit)
 *
 * Both share the same `transferGroupId` and reference each other
 * via `linkedTransactionId`.
 */
export async function createTransfer(
  ctx: MutationCtx,
  userId: string,
  args: {
    amount: number;
    fromAccountId: Id<"accounts">;
    toAccountId: Id<"accounts">;
    date: string;
    description?: string;
    note?: string;
  },
) {
  if (args.amount <= 0) throw new Error("Amount must be positive");
  if (args.fromAccountId === args.toAccountId) {
    throw new Error("Cannot transfer to the same account");
  }

  // Validate source account ownership
  const fromAccount = await ctx.db.get(args.fromAccountId);
  if (!fromAccount || fromAccount.userId !== userId) {
    throw new Error("Account not found");
  }

  // Validate destination account ownership
  const toAccount = await ctx.db.get(args.toAccountId);
  if (!toAccount || toAccount.userId !== userId) {
    throw new Error("Account not found");
  }

  // Generate a shared group ID
  const transferGroupId = crypto.randomUUID();

  // Create outgoing transaction (source, debit)
  const outgoingId = await ctx.db.insert("transactions", {
    userId,
    type: "transfer",
    amount: args.amount,
    accountId: args.fromAccountId,
    destinationAccountId: args.toAccountId,
    transferGroupId,
    date: args.date,
    ...(args.description ? { description: args.description } : {}),
    ...(args.note ? { note: args.note } : {}),
  });

  // Create incoming transaction (destination, credit)
  const incomingId = await ctx.db.insert("transactions", {
    userId,
    type: "transfer",
    amount: args.amount,
    accountId: args.toAccountId,
    transferGroupId,
    linkedTransactionId: outgoingId,
    date: args.date,
    ...(args.description ? { description: args.description } : {}),
    ...(args.note ? { note: args.note } : {}),
  });

  // Link outgoing → incoming
  await ctx.db.patch(outgoingId, { linkedTransactionId: incomingId });

  // Update balances: debit source, credit destination
  await ctx.db.patch(args.fromAccountId, {
    balance: fromAccount.balance - args.amount,
  });
  await ctx.db.patch(args.toAccountId, {
    balance: toAccount.balance + args.amount,
  });

  return { outgoingId, incomingId, transferGroupId };
}

/**
 * Delete a transfer (both sides) and reverse balance effects.
 *
 * Can be called with either the outgoing or incoming transaction ID.
 */
export async function deleteTransfer(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"transactions"> },
) {
  const tx = await ctx.db.get(args.id);
  if (!tx || tx.userId !== userId) {
    throw new Error("Transaction not found");
  }
  if (tx.type !== "transfer") {
    throw new Error("Transaction is not a transfer");
  }

  // Find the paired transaction
  const linkedId = tx.linkedTransactionId;
  const linkedTx = linkedId ? await ctx.db.get(linkedId) : null;

  // Determine which is outgoing (has destinationAccountId) vs incoming
  let outgoing = tx.destinationAccountId ? tx : linkedTx;
  let incoming = tx.destinationAccountId ? linkedTx : tx;

  // If we only have one side somehow, treat the current tx as the reference
  if (!outgoing) outgoing = tx;
  if (!incoming && linkedTx) incoming = linkedTx;

  // Reverse balance on source (outgoing side): add back the amount
  const fromAccount = await ctx.db.get(outgoing.accountId);
  if (fromAccount) {
    await ctx.db.patch(outgoing.accountId, {
      balance: fromAccount.balance + outgoing.amount,
    });
  }

  // Reverse balance on destination (incoming side): subtract the amount
  if (incoming && incoming._id !== outgoing._id) {
    const toAccount = await ctx.db.get(incoming.accountId);
    if (toAccount) {
      await ctx.db.patch(incoming.accountId, {
        balance: toAccount.balance - incoming.amount,
      });
    }
  }

  // Delete both transactions
  await ctx.db.delete(outgoing._id);
  if (incoming && incoming._id !== outgoing._id) {
    await ctx.db.delete(incoming._id);
  }
}

/**
 * Update a transfer. Updates both sides and adjusts balances.
 *
 * Can be called with either the outgoing or incoming transaction ID.
 * Supports updating: amount, fromAccountId, toAccountId, date, description, note.
 */
export async function updateTransfer(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"transactions">;
    amount?: number;
    fromAccountId?: Id<"accounts">;
    toAccountId?: Id<"accounts">;
    date?: string;
    description?: string;
    note?: string;
  },
) {
  const tx = await ctx.db.get(args.id);
  if (!tx || tx.userId !== userId) {
    throw new Error("Transaction not found");
  }
  if (tx.type !== "transfer") {
    throw new Error("Transaction is not a transfer");
  }

  // Find the paired transaction
  const linkedId = tx.linkedTransactionId;
  const linkedTx = linkedId ? await ctx.db.get(linkedId) : null;
  if (!linkedTx) throw new Error("Linked transfer transaction not found");

  // Determine which is outgoing (has destinationAccountId) vs incoming
  const outgoing = tx.destinationAccountId ? tx : linkedTx;
  const incoming = tx.destinationAccountId ? linkedTx : tx;

  // Determine old values
  const oldAmount = outgoing.amount;
  const oldFromAccountId = outgoing.accountId;
  const oldToAccountId = incoming.accountId;

  // Determine new values
  const newAmount = args.amount ?? oldAmount;
  const newFromAccountId = args.fromAccountId ?? oldFromAccountId;
  const newToAccountId = args.toAccountId ?? oldToAccountId;

  if (newFromAccountId === newToAccountId) {
    throw new Error("Cannot transfer to the same account");
  }

  // Validate new account ownership
  if (args.fromAccountId) {
    const acct = await ctx.db.get(args.fromAccountId);
    if (!acct || acct.userId !== userId) throw new Error("Account not found");
  }
  if (args.toAccountId) {
    const acct = await ctx.db.get(args.toAccountId);
    if (!acct || acct.userId !== userId) throw new Error("Account not found");
  }

  // --- Reverse old balances ---
  const oldFromAcct = await ctx.db.get(oldFromAccountId);
  if (oldFromAcct) {
    await ctx.db.patch(oldFromAccountId, {
      balance: oldFromAcct.balance + oldAmount,
    });
  }

  const oldToAcct = await ctx.db.get(oldToAccountId);
  if (oldToAcct) {
    await ctx.db.patch(oldToAccountId, {
      balance: oldToAcct.balance - oldAmount,
    });
  }

  // --- Apply new balances ---
  // Re-fetch accounts since they may have been updated above
  const newFromAcct = await ctx.db.get(newFromAccountId);
  if (newFromAcct) {
    await ctx.db.patch(newFromAccountId, {
      balance: newFromAcct.balance - newAmount,
    });
  }

  const newToAcct = await ctx.db.get(newToAccountId);
  if (newToAcct) {
    await ctx.db.patch(newToAccountId, {
      balance: newToAcct.balance + newAmount,
    });
  }

  // --- Update outgoing transaction ---
  const outgoingPatch: Record<string, unknown> = {};
  if (args.amount !== undefined) outgoingPatch.amount = args.amount;
  if (args.fromAccountId !== undefined) outgoingPatch.accountId = args.fromAccountId;
  if (args.toAccountId !== undefined) outgoingPatch.destinationAccountId = args.toAccountId;
  if (args.date !== undefined) outgoingPatch.date = args.date;
  if (args.description !== undefined) outgoingPatch.description = args.description;
  if (args.note !== undefined) outgoingPatch.note = args.note;
  if (Object.keys(outgoingPatch).length > 0) {
    await ctx.db.patch(outgoing._id, outgoingPatch);
  }

  // --- Update incoming transaction ---
  const incomingPatch: Record<string, unknown> = {};
  if (args.amount !== undefined) incomingPatch.amount = args.amount;
  if (args.toAccountId !== undefined) incomingPatch.accountId = args.toAccountId;
  if (args.date !== undefined) incomingPatch.date = args.date;
  if (args.description !== undefined) incomingPatch.description = args.description;
  if (args.note !== undefined) incomingPatch.note = args.note;
  if (Object.keys(incomingPatch).length > 0) {
    await ctx.db.patch(incoming._id, incomingPatch);
  }
}

/**
 * Get transfer details. Given either side's transaction ID, returns a unified
 * view of the transfer with account names.
 */
export async function getTransfer(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { id: Id<"transactions"> },
) {
  const tx = await ctx.db.get(args.id);
  if (!tx || tx.userId !== userId) return null;
  if (tx.type !== "transfer") return null;

  // Find the paired transaction
  const linkedId = tx.linkedTransactionId;
  const linkedTx = linkedId ? await ctx.db.get(linkedId) : null;

  // Determine which is outgoing (has destinationAccountId) vs incoming
  const outgoing = tx.destinationAccountId ? tx : linkedTx;
  const incoming = tx.destinationAccountId ? linkedTx : tx;

  if (!outgoing || !incoming) return null;

  // Resolve account names
  const fromAccount = await ctx.db.get(outgoing.accountId);
  const toAccount = await ctx.db.get(incoming.accountId);

  return {
    outgoingId: outgoing._id,
    incomingId: incoming._id,
    transferGroupId: outgoing.transferGroupId,
    amount: outgoing.amount,
    fromAccountId: outgoing.accountId,
    toAccountId: incoming.accountId,
    fromAccountName: fromAccount?.name ?? "Unknown",
    toAccountName: toAccount?.name ?? "Unknown",
    date: outgoing.date,
    description: outgoing.description,
    note: outgoing.note,
  };
}

