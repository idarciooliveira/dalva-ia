import { accountsRouter } from "./accounts";
import { agentHistoryRouter, agentMessagesRouter, agentPendingActionsRouter, agentSessionsRouter } from "./agent";
import { categoriesRouter, subcategoriesRouter } from "./categories";
import { chatHistoryRouter, chatLinksRouter } from "./chatLinks";
import { debtPaymentsRouter, debtsRouter } from "./debts";
import { goalContributionsRouter, goalsRouter } from "./goals";
import { router } from "./init";
import { profileRouter } from "./profile";
import { reportsRouter } from "./reports";
import { agentEventsRouter, channelIdentitiesRouter, channelLinksRouter } from "./service";
import { transactionsRouter } from "./transactions";
import { transfersRouter } from "./transfers";

/**
 * The whole API. Procedure paths (`transactions.create`) are also the
 * operation names pending actions store.
 */
export const appRouter = router({
  accounts: accountsRouter,
  profile: profileRouter,
  categories: categoriesRouter,
  subcategories: subcategoriesRouter,
  transactions: transactionsRouter,
  transfers: transfersRouter,
  reports: reportsRouter,
  goals: goalsRouter,
  goalContributions: goalContributionsRouter,
  debts: debtsRouter,
  debtPayments: debtPaymentsRouter,
  chatLinks: chatLinksRouter,
  chatHistory: chatHistoryRouter,
  agentSessions: agentSessionsRouter,
  agentMessages: agentMessagesRouter,
  agentPendingActions: agentPendingActionsRouter,
  agentHistory: agentHistoryRouter,
  channelLinks: channelLinksRouter,
  channelIdentities: channelIdentitiesRouter,
  agentEvents: agentEventsRouter,
});

/** What clients import, type-only: `import type { AppRouter } from "@mpf/api/trpc"`. */
export type AppRouter = typeof appRouter;
export type { ApiErrorCode, ApiErrorData } from "./errors";
