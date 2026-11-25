/**
 * A transfer is two `transfer` rows sharing `transfer_group_id`; either leg's
 * id addresses it. Goal-contribution transfers answer `conflict` on
 * `update`/`delete` (change them through the goal).
 */
import { z } from "zod";

import type { Tx } from "../db/tx";
import { notFound } from "../domain/errors";
import * as transfers from "../domain/transfers";
import { transferDto } from "./dto";
import { financeWrite, router, webRead } from "./init";
import {
  byId,
  deleted,
  descriptionField,
  hasChangesBesidesId,
  idSchema,
  isoDateSchema,
  moneySchema,
  NO_CHANGES,
  noteField,
  positiveMoneySchema,
  responseDate,
} from "./schemas";

/** Both legs as one transfer. */
export const transferSchema = z.object({
  outgoingId: z.string(),
  incomingId: z.string(),
  transferGroupId: z.string().optional(),
  amount: moneySchema,
  fromAccountId: z.string(),
  toAccountId: z.string(),
  fromAccountName: z.string(),
  toAccountName: z.string(),
  date: responseDate,
  description: z.string().optional(),
  note: z.string().optional(),
});
const transferResult = z.object({ transfer: transferSchema });

const SAME_ACCOUNT = "Cannot transfer to the same account";

export const transferCreateInput = z
  .strictObject({
    amount: positiveMoneySchema,
    fromAccountId: idSchema,
    toAccountId: idSchema,
    date: isoDateSchema,
    description: descriptionField.optional(),
    note: noteField.optional(),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, { message: SAME_ACCOUNT, path: ["toAccountId"] });

/** `null` clears `description` and `note` on both legs. */
export const transferUpdateInput = z
  .strictObject({
    id: idSchema,
    amount: positiveMoneySchema.optional(),
    fromAccountId: idSchema.optional(),
    toAccountId: idSchema.optional(),
    date: isoDateSchema.optional(),
    description: descriptionField.nullable().optional(),
    note: noteField.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (!hasChangesBesidesId(v)) ctx.addIssue({ code: "custom", message: NO_CHANGES });
    if (v.fromAccountId && v.fromAccountId === v.toAccountId) {
      ctx.addIssue({ code: "custom", message: SAME_ACCOUNT, path: ["toAccountId"] });
    }
  });

export const transferDeleteInput = byId;

async function transferResponse(tx: Tx, userId: string, id: string) {
  const transfer = await transfers.getTransfer(tx, userId, id);
  // The amount is labelled with the source account's currency.
  if (!transfer.fromAccount) throw notFound("Account");
  return { transfer: transferDto({ ...transfer, fromAccount: transfer.fromAccount }) };
}

export const transfersRouter = router({
  /** Web only. Rows that are not transfer legs, and legs whose pair is missing, are `not_found`. */
  get: webRead
    .input(byId)
    .output(transferResult)
    .query(async ({ ctx, input }) => await transferResponse(ctx.tx, ctx.user.userId, input.id)),

  create: financeWrite
    .input(transferCreateInput)
    .output(transferResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const id = await transfers.createTransfer(tx, user.userId, input);
      return await transferResponse(tx, user.userId, id);
    }),

  /** Moving a transfer to accounts in another currency needs a new amount (the domain checks it). */
  update: financeWrite
    .input(transferUpdateInput)
    .output(transferResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { id, ...changes } = input;
      const outgoingId = await transfers.updateTransfer(tx, user.userId, id, changes);
      return await transferResponse(tx, user.userId, outgoingId);
    }),

  delete: financeWrite
    .input(transferDeleteInput)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await transfers.deleteTransfer(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
