import { trpc, type RouterInputs } from "./trpc";

/** Query options for the pages' reads: `useQuery(accountsQuery({ includeArchived: true }))`. */

export const profileQuery = () => trpc.profile.get.queryOptions();

export const accountsQuery = (input: RouterInputs["accounts"]["list"] = {}) => trpc.accounts.list.queryOptions(input);

export const categoriesQuery = (input: RouterInputs["categories"]["list"] = {}) => trpc.categories.list.queryOptions(input);

export const subcategoriesQuery = (input: RouterInputs["subcategories"]["list"] = {}) => trpc.subcategories.list.queryOptions(input);

/** A constant list served by the API. */
export const defaultCategoriesQuery = () => trpc.categories.defaults.queryOptions(undefined, { staleTime: Infinity });

export const goalsQuery = (input: RouterInputs["goals"]["list"] = {}) => trpc.goals.list.queryOptions(input);

export const goalContributionsQuery = (goalId: string) => trpc.goalContributions.list.queryOptions({ goalId });

export const debtsQuery = (input: RouterInputs["debts"]["list"] = {}) => trpc.debts.list.queryOptions(input);

export const debtPaymentsQuery = (debtId: string) => trpc.debtPayments.list.queryOptions({ debtId });

export const debtSummaryQuery = () => trpc.reports.debtSummary.queryOptions();

export const chatLinksQuery = () => trpc.chatLinks.list.queryOptions();
