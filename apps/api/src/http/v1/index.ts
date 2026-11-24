import type { Operations, ServiceOperations } from "../operation";
import { accountOperations } from "./accounts";
import { agentHistoryOperations, agentMessageOperations, agentPendingActionOperations, agentSessionOperations } from "./agent";
import { categoryOperations, subcategoryOperations } from "./categories";
import { chatHistoryOperations, chatLinkOperations, type ChatLinkSettings } from "./chatLinks";
import { debtOperations, debtPaymentOperations } from "./debts";
import { goalContributionOperations, goalOperations } from "./goals";
import { profileOperations } from "./profile";
import { reportOperations } from "./reports";
import { transactionOperations } from "./transactions";
import { transferOperations } from "./transfers";
import { agentEventServiceOperations, channelIdentityServiceOperations, channelLinkServiceOperations } from "./service";

/** Server settings some operations read (from the config). */
export type OperationSettings = ChatLinkSettings;

/**
 * Every implemented `/api/v1` user route. Add a group here when its PR ports
 * it; the type requires every operation of the group's contract routes.
 */
export const createOperations = (settings: OperationSettings = {}) =>
  ({
  accounts: accountOperations,
  profile: profileOperations,
  categories: categoryOperations,
  subcategories: subcategoryOperations,
  transactions: transactionOperations,
  transfers: transferOperations,
  reports: reportOperations,
  goals: goalOperations,
  goalContributions: goalContributionOperations,
  debts: debtOperations,
  debtPayments: debtPaymentOperations,
  chatLinks: chatLinkOperations(settings),
  chatHistory: chatHistoryOperations,
  agentSessions: agentSessionOperations,
  agentMessages: agentMessageOperations,
  agentPendingActions: agentPendingActionOperations,
  agentHistory: agentHistoryOperations,
  }) satisfies Operations;

/** The user routes with default settings (no bot username). */
export const operations = createOperations();

/** Every implemented service route (the agent's service key). */
export const serviceOperations = {
  channelLinks: channelLinkServiceOperations,
  channelIdentities: channelIdentityServiceOperations,
  agentEvents: agentEventServiceOperations,
} satisfies ServiceOperations;
