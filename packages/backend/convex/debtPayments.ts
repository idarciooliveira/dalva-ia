import { requireUserId } from "./lib/auth";
import * as debtPaymentsDomain from "./domain/debtPayments";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

export const listDebtPayments = query({
  args: { debtId: v.id("debts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await debtPaymentsDomain.listDebtPayments(ctx, userId, args);
  },
});

export const recordDebtPayment = mutation({
  args: {
    debtId: v.id("debts"),
    amount: v.number(),
    principalAmount: v.optional(v.number()),
    interestAmount: v.optional(v.number()),
    date: v.string(),
    note: v.optional(v.string()),
    fromAccountId: v.id("accounts"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await debtPaymentsDomain.recordDebtPayment(ctx, userId, args);
  },
});

export const removeDebtPayment = mutation({
  args: { id: v.id("debtPayments") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await debtPaymentsDomain.removeDebtPayment(ctx, userId, args);
  },
});
