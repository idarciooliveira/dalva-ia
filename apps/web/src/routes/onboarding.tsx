import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useAuthGuard } from "@/hooks/use-auth-guard";
import { createAccountDraft, type AccountDraft } from "@/lib/accounts";
import { useApiMutation } from "@/lib/api/mutations";
import { defaultCategoriesQuery } from "@/lib/api/queries";
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

  // A profile exists when the user reloads after the first step.
  return <OnboardingWizard initialCurrency={auth.profile.baseCurrency ?? "USD"} />;
}

/* -------------------------------------------------------------------------- */
/*  Wizard                                                                    */
/* -------------------------------------------------------------------------- */

function OnboardingWizard({ initialCurrency }: { initialCurrency: string }) {
  const [step, setStep] = useState(1);
  const [currency, setCurrency] = useState(initialCurrency);
  const [accounts, setAccounts] = useState<AccountDraft[]>([
    createAccountDraft(),
  ]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoriesInitialized, setCategoriesInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drafts already saved, with what was sent: a retry after a partial failure, or
  // Back then Continue, doesn't create them again unless they were edited.
  const createdDrafts = useRef(new Map<string, string>());

  const router = useRouter();
  const queryClient = useQueryClient();

  // Mutations
  const { mutateAsync: createProfile, isPending: isCreatingProfile } =
    useApiMutation("profile", "create");
  const { mutateAsync: createAccount, isPending: isCreatingAccount } =
    useApiMutation("accounts", "create");
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
      const inputs = [];
      for (const acct of validAccounts) {
        const amountMinor = parseDecimalInput(acct.balance, currency);
        if (amountMinor === null) {
          setError(`Enter a valid opening balance for ${acct.name.trim()}.`);
          return;
        }
        inputs.push({
          draftId: acct.id,
          input: {
            name: acct.name.trim(),
            type: acct.type,
            balance: { amountMinor, currency },
            ...(acct.theme !== "default" ? { theme: acct.theme } : {}),
          },
        });
      }
      for (const { draftId, input } of inputs) {
        const sent = fingerprint(input);
        if (createdDrafts.current.get(draftId) === sent) continue;
        await createAccount(input);
        createdDrafts.current.set(draftId, sent);
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

  const isSubmitting =
    isCreatingProfile ||
    isCreatingAccount ||
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
