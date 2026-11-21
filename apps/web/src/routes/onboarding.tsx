import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { formatMinorAmount } from "@mpf/finance-contract";
import type { Account, RouteInput, UserRoutes } from "@mpf/finance-contract";

import { useAuthGuard } from "@/hooks/use-auth-guard";
import { createAccountDraft, type AccountDraft } from "@/lib/accounts";
import { useApiMutation } from "@/lib/api/mutations";
import { accountsQuery, defaultCategoriesQuery } from "@/lib/api/queries";
import { queryKeys } from "@/lib/api/keys";
import { apiErrorMessage } from "@/lib/api/errors";
import { fingerprint } from "@/lib/api/idempotency";
import { parseDecimalInput } from "@/lib/money";
import { FormError, FullPageError } from "@/components/error-state";
import { StepIndicator } from "@/components/onboarding/step-indicator";
import { CurrencyStep } from "@/components/onboarding/currency-step";
import { AccountsStep } from "@/components/onboarding/accounts-step";
import { CategoriesStep } from "@/components/onboarding/categories-step";
import { OnboardingSkeleton } from "@/components/onboarding/onboarding-skeleton";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

const TOTAL_STEPS = 3;

/* -------------------------------------------------------------------------- */
/*  Page wrapper                                                              */
/* -------------------------------------------------------------------------- */

function OnboardingPage() {
  const auth = useAuthGuard({ redirectIfOnboarded: true });

  if (auth.status === "error") {
    return <FullPageError error={auth.error} onRetry={auth.retry} />;
  }
  if (auth.status !== "ready") {
    return <OnboardingSkeleton />;
  }

  // A profile exists when the user comes back after the first step (reload, new tab).
  const baseCurrency = auth.profile.baseCurrency;
  return <OnboardingWizard initialCurrency={baseCurrency ?? "USD"} resumed={baseCurrency !== undefined} />;
}

type AccountInput = RouteInput<UserRoutes["accounts"]["create"]>;
/** What onboarding last saved for a draft, so a later Continue only sends the difference. */
type SavedAccount = { accountId: string; input: AccountInput };

function accountInput(name: string, type: AccountInput["type"], amountMinor: number, currency: string, theme?: string) {
  return {
    name,
    type,
    balance: { amountMinor, currency },
    ...(theme && theme !== "default" ? { theme } : {}),
  } satisfies AccountInput;
}

/** Drafts for accounts a resumed onboarding already created. */
function draftsFrom(accounts: Account[]): Array<{ draft: AccountDraft; saved: SavedAccount }> {
  return accounts.map((account) => {
    const { amountMinor, currency } = account.balance;
    return {
      draft: createAccountDraft({
        name: account.name,
        type: account.type,
        balance: formatMinorAmount(amountMinor, currency),
        theme: account.theme ?? "default",
      }),
      saved: {
        accountId: account.id,
        input: accountInput(account.name, account.type, amountMinor, currency, account.theme),
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Wizard                                                                    */
/* -------------------------------------------------------------------------- */

function OnboardingWizard({ initialCurrency, resumed }: { initialCurrency: string; resumed: boolean }) {
  const [step, setStep] = useState(1);
  const [currency, setCurrency] = useState(initialCurrency);
  const [accounts, setAccounts] = useState<AccountDraft[]>([
    createAccountDraft(),
  ]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoriesInitialized, setCategoriesInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Accounts already saved, per draft: Continue again (after Back, a partial failure
  // or a reload) updates, recreates or deletes them instead of creating duplicates.
  const savedAccounts = useRef(new Map<string, SavedAccount>());
  const [resumeSeeded, setResumeSeeded] = useState(!resumed);

  const router = useRouter();
  const queryClient = useQueryClient();

  // Mutations
  const { mutateAsync: createProfile, isPending: isCreatingProfile } =
    useApiMutation("profile", "create");
  const { mutateAsync: createAccount, isPending: isCreatingAccount } =
    useApiMutation("accounts", "create");
  const { mutateAsync: updateAccount, isPending: isUpdatingAccount } =
    useApiMutation("accounts", "update");
  const { mutateAsync: deleteAccount, isPending: isDeletingAccount } =
    useApiMutation("accounts", "delete");

  // Resumed onboarding: show the accounts created last time as the drafts.
  const existingAccounts = useQuery({ ...accountsQuery(), enabled: resumed });
  useEffect(() => {
    if (resumeSeeded || !existingAccounts.data) return;
    const resumedDrafts = draftsFrom(existingAccounts.data.items);
    if (resumedDrafts.length > 0) {
      setAccounts(resumedDrafts.map((d) => d.draft));
      for (const { draft, saved } of resumedDrafts) savedAccounts.current.set(draft.id, saved);
    }
    setResumeSeeded(true);
  }, [resumeSeeded, existingAccounts.data]);
  const { mutateAsync: seedCategories, isPending: isSeedingCategories } =
    useApiMutation("categories", "seedDefaults");
  const { mutateAsync: completeOnboarding, isPending: isCompleting } =
    useApiMutation("profile", "completeOnboarding");

  // Fetch default category list
  const defaultsResult = useQuery(defaultCategoriesQuery());
  const defaultCategories = defaultsResult.data?.items;

  // Initialize selected categories once defaults load
  useEffect(() => {
    if (defaultCategories && !categoriesInitialized) {
      setSelectedCategories(defaultCategories.map((c) => c.name));
      setCategoriesInitialized(true);
    }
  }, [defaultCategories, categoriesInitialized]);

  async function run(action: () => Promise<void>, fallback: string) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
    }
  }

  /* Step 1: Currency -> create profile */
  function handleCurrencyNext() {
    return run(async () => {
      await createProfile({ baseCurrency: currency });
      setStep(2);
    }, "Couldn't save your currency. Try again.");
  }

  /* Step 2: Accounts -> create accounts */
  function handleAccountsNext() {
    return run(async () => {
      const validAccounts = accounts.filter((a) => a.name.trim().length > 0);
      const inputs: Array<{ draftId: string; input: AccountInput }> = [];
      for (const acct of validAccounts) {
        const amountMinor = parseDecimalInput(acct.balance, currency);
        if (amountMinor === null) {
          setError(`Enter a valid opening balance for ${acct.name.trim()}.`);
          return;
        }
        inputs.push({ draftId: acct.id, input: accountInput(acct.name.trim(), acct.type, amountMinor, currency, acct.theme) });
      }

      const saved = savedAccounts.current;
      // Drafts removed (or emptied) since they were saved: their accounts go too.
      const kept = new Set(inputs.map((i) => i.draftId));
      for (const [draftId, { accountId }] of [...saved]) {
        if (kept.has(draftId)) continue;
        await deleteAccount({ id: accountId });
        saved.delete(draftId);
      }
      for (const { draftId, input } of inputs) {
        const previous = saved.get(draftId);
        if (previous && fingerprint(previous.input) === fingerprint(input)) continue;
        const balanceChanged =
          previous !== undefined &&
          (previous.input.balance.amountMinor !== input.balance.amountMinor ||
            previous.input.balance.currency !== input.balance.currency);
        if (previous && !balanceChanged) {
          await updateAccount({ id: previous.accountId, name: input.name, type: input.type, theme: input.theme ?? "default" });
          saved.set(draftId, { accountId: previous.accountId, input });
          continue;
        }
        // New, or a balance/currency change: an opening balance can't be edited, and the
        // account has no transactions yet, so it is recreated.
        if (previous) {
          await deleteAccount({ id: previous.accountId });
          saved.delete(draftId);
        }
        const { account } = await createAccount(input);
        saved.set(draftId, { accountId: account.id, input });
      }
      setStep(3);
    }, "Couldn't create your accounts. Try again.");
  }

  /* Step 3: Categories -> seed + complete */
  function handleFinish() {
    return run(async () => {
      await seedCategories({ selectedNames: selectedCategories });
      const { profile } = await completeOnboarding({});
      // The dashboard's guard reads this: it must already say onboarded.
      queryClient.setQueryData(queryKeys.profile(), { profile });
      await router.navigate({ to: "/dashboard" });
    }, "Couldn't finish setting up. Try again.");
  }

  function goToStep(next: number) {
    setError(null);
    setStep(next);
  }

  if (!resumeSeeded) {
    if (existingAccounts.isError) {
      return <FullPageError error={existingAccounts.error} onRetry={() => void existingAccounts.refetch()} />;
    }
    return <OnboardingSkeleton />;
  }

  const isSubmitting =
    isCreatingProfile ||
    isCreatingAccount ||
    isUpdatingAccount ||
    isDeletingAccount ||
    isSeedingCategories ||
    isCompleting;

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-xl">
        {/* Logo */}
        <Link to="/" className="mb-6 block text-center">
          <span className="font-heading text-2xl font-semibold text-foreground">
            DALVA
          </span>
        </Link>

        {/* Progress indicator */}
        <StepIndicator currentStep={step} totalSteps={TOTAL_STEPS} />

        {/* Card */}
        <div className="mt-6 rounded-2xl border border-border bg-card p-8 shadow-sm">
          <FormError message={error} className="mt-0 mb-4" />
          {step === 1 && (
            <CurrencyStep
              currency={currency}
              onCurrencyChange={setCurrency}
              onNext={handleCurrencyNext}
              isSubmitting={isSubmitting}
            />
          )}
          {step === 2 && (
            <AccountsStep
              accounts={accounts}
              onAccountsChange={setAccounts}
              currency={currency}
              onNext={handleAccountsNext}
              onBack={() => goToStep(1)}
              isSubmitting={isSubmitting}
            />
          )}
          {step === 3 && (
            <CategoriesStep
              defaultCategories={defaultCategories ?? []}
              loadError={defaultsResult.isError ? defaultsResult.error : null}
              onRetryLoad={() => void defaultsResult.refetch()}
              selectedCategories={selectedCategories}
              onSelectedChange={setSelectedCategories}
              onFinish={handleFinish}
              onBack={() => goToStep(2)}
              isSubmitting={isSubmitting}
            />
          )}
        </div>
      </div>
    </div>
  );
}
