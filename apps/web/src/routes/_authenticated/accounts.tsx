import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Account } from "@/lib/api/types";
import { useState } from "react";
import { Plus, Wallet, Archive } from "lucide-react";

import { AccountRow } from "@/components/accounts/account-row";
import { AccountFormDialog } from "@/components/accounts/account-form-dialog";
import { AdjustBalanceDialog } from "@/components/accounts/adjust-balance-dialog";
import { AccountsListSkeleton } from "@/components/accounts/accounts-list-skeleton";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/error-state";
import { accountsQuery } from "@/lib/api/queries";

export const Route = createFileRoute("/_authenticated/accounts")({
  component: AccountsPage,
});

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

function AccountsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-200 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        <AccountsContent />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Accounts content                                                          */
/* -------------------------------------------------------------------------- */

function AccountsContent() {
  const [showArchived, setShowArchived] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [adjustAccount, setAdjustAccount] = useState<Account | null>(null);

  const accountsResult = useQuery({
    ...accountsQuery({ includeArchived: showArchived }),
    placeholderData: keepPreviousData,
  });

  if (accountsResult.isPending) {
    return <AccountsListSkeleton />;
  }

  const sortedAccounts = [...(accountsResult.data?.items ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <>
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">
            Accounts
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your financial accounts, balances, and settings.
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            variant={showArchived ? "secondary" : "outline"}
            size="default"
            onClick={() => setShowArchived(!showArchived)}
            aria-pressed={showArchived}
            className="relative"
          >
            <Archive className="mr-1.5 size-4" />
            Archived
            {showArchived && (
              <span aria-hidden="true" className="ml-1.5 inline-flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
                1
              </span>
            )}
          </Button>
          <Button
            variant="accent"
            size="default"
            className="flex-1 sm:flex-none"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="mr-1.5 size-4" />
            Add account
          </Button>
        </div>
      </div>

      {/* List */}
      {accountsResult.isError && !accountsResult.data ? (
        <ErrorState
          error={accountsResult.error}
          fallback="Couldn't load your accounts."
          onRetry={() => void accountsResult.refetch()}
        />
      ) : sortedAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 sm:py-16">
          <Wallet className="mb-3 size-10 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">
            No accounts yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add your first account to start tracking your finances.
          </p>
        </div>
      ) : (
        <div role="list" aria-label="Accounts" className="space-y-3">
          {sortedAccounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onEdit={() => setEditAccount(account)}
              onAdjustBalance={() => setAdjustAccount(account)}
            />
          ))}
        </div>
      )}

      {/* Create Account Dialog */}
      <AccountFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        account={null}
      />

      {/* Edit Account Dialog */}
      <AccountFormDialog
        open={editAccount !== null}
        onOpenChange={(open) => {
          if (!open) setEditAccount(null);
        }}
        account={editAccount}
      />

      {/* Adjust Balance Dialog: the live row, so the delta is taken from the current balance */}
      <AdjustBalanceDialog
        open={adjustAccount !== null}
        onOpenChange={(open) => {
          if (!open) setAdjustAccount(null);
        }}
        account={sortedAccounts.find((a) => a.id === adjustAccount?.id) ?? adjustAccount}
      />
    </>
  );
}
