import type { Operations, ServiceOperations } from "../operation";
import { accountOperations } from "./accounts";
import { agentHistoryOperations, agentMessageOperations, agentPendingActionOperations, agentSessionOperations } from "./agent";
import { categoryOperations, subcategoryOperations } from "./categories";
import { chatHistoryOperations, chatLinkOperations } from "./chatLinks";
import { profileOperations } from "./profile";
import { reportOperations } from "./reports";
import { transactionOperations } from "./transactions";
import { transferOperations } from "./transfers";
import { agentEventServiceOperations, channelIdentityServiceOperations, channelLinkServiceOperations } from "./service";

/**
 * Every implemented `/api/v1` user route. Add a group here when its PR ports
 * it; the type requires every operation of the group's contract routes.
 */
export const operations = {
  accounts: accountOperations,
  profile: profileOperations,
  categories: categoryOperations,
  subcategories: subcategoryOperations,
  transactions: transactionOperations,
  transfers: transferOperations,
  reports: reportOperations,
  chatLinks: chatLinkOperations,
  chatHistory: chatHistoryOperations,
  agentSessions: agentSessionOperations,
  agentMessages: agentMessageOperations,
  agentPendingActions: agentPendingActionOperations,
  agentHistory: agentHistoryOperations,
} satisfies Operations;

/** Every implemented service route (the agent's service key). */
export const serviceOperations = {
  channelLinks: channelLinkServiceOperations,
  channelIdentities: channelIdentityServiceOperations,
  agentEvents: agentEventServiceOperations,
} satisfies ServiceOperations;
