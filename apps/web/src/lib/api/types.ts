/** API records as the web app uses them, derived from the router's outputs. */
import type { RouterOutputs } from "./trpc";

export type Account = RouterOutputs["accounts"]["get"]["account"];
export type Profile = NonNullable<RouterOutputs["profile"]["get"]["profile"]>;
export type Category = RouterOutputs["categories"]["create"]["category"];
export type Subcategory = RouterOutputs["subcategories"]["create"]["subcategory"];
export type Transaction = RouterOutputs["transactions"]["get"]["transaction"];
/** A `transactions.search` row: a transaction plus what owns it, if anything. */
export type TransactionListItem = RouterOutputs["transactions"]["search"]["items"][number];
export type TransactionManagedBy = NonNullable<TransactionListItem["managedBy"]>;
export type Transfer = RouterOutputs["transfers"]["get"]["transfer"];
export type Goal = RouterOutputs["goals"]["get"]["goal"];
export type GoalContribution = RouterOutputs["goalContributions"]["add"]["contribution"];
export type Debt = RouterOutputs["debts"]["get"]["debt"];
export type DebtType = Debt["debtType"];
export type DebtPayment = RouterOutputs["debtPayments"]["record"]["payment"];
export type ChatLink = RouterOutputs["chatLinks"]["list"]["items"][number];
/** The instance settings as the owner sees them. */
export type InstanceSettings = Extract<RouterOutputs["instance"]["get"], { owner: true }>;
export type TelegramBotState = InstanceSettings["telegram"];
export type AiProviderState = InstanceSettings["ai"];
export type AiProvider = Extract<AiProviderState, { provider: string }>["provider"];
export type TelegramWebhookStatus = RouterOutputs["instance"]["telegramStatus"];
