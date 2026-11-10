import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as debtsDomain from "./domain/debts";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const debtTypeValidator = v.union(
  v.literal("credit_card"),
  v.literal("loan"),
  v.literal("mortgage"),
  v.literal("student_loan"),
  v.literal("personal_loan"),
  v.literal("other"),
);

export const listDebts = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await debtsDomain.listDebts(ctx, userId, args);
  },
});

export const getDebt = query({
  args: { id: v.id("debts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await debtsDomain.getDebt(ctx, userId, args);
  },
});

export const createDebt = mutation({
  args: {
    name: v.string(),
    debtType: debtTypeValidator,
    lender: v.optional(v.string()),
    originalAmount: v.number(),
    currentBalance: v.number(),
    interestRate: v.optional(v.number()),
    minimumPayment: v.optional(v.number()),
    dueDate: v.optional(v.string()),
    linkedAccountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await debtsDomain.createDebt(ctx, userId, args);
  },
});

export const updateDebt = mutation({
  args: {
    id: v.id("debts"),
    name: v.optional(v.string()),
    debtType: v.optional(debtTypeValidator),
    lender: v.optional(v.string()),
    originalAmount: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    interestRate: v.optional(v.number()),
    minimumPayment: v.optional(v.number()),
    dueDate: v.optional(v.string()),
    linkedAccountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await debtsDomain.updateDebt(ctx, userId, args);
  },
});

export const archiveDebt = mutation({
  args: { id: v.id("debts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await debtsDomain.archiveDebt(ctx, userId, args);
  },
});

export const restoreDebt = mutation({
  args: { id: v.id("debts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await debtsDomain.restoreDebt(ctx, userId, args);
  },
});

export const deleteDebt = mutation({
  args: { id: v.id("debts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await debtsDomain.deleteDebt(ctx, userId, args);
  },
});

export const getDebtSummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) {
      return {
        debts: [],
        totalOriginal: 0,
        totalRemaining: 0,
        recentPayment: 0,
        currency: "USD",
      };
    }

    return await debtsDomain.getDebtSummary(ctx, userId);
  },
});
