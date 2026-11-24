import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Transaction } from "@/lib/api/types";
import { useEffect, useMemo, useState } from "react";
import { Plus, ArrowLeftRight, Search } from "lucide-react";

import { TransactionRow } from "@/components/transactions/transaction-row";
import { TransactionFormDialog } from "@/components/transactions/transaction-form-dialog";
import { TransferFormDialog } from "@/components/transactions/transfer-form-dialog";
import {
  TransactionFilterButton,
  TransactionFiltersSheet,
  defaultFilters,
  hasInvalidDateRange,
  type TransactionFilters,
} from "@/components/transactions/transaction-filters";
import { TransactionsListSkeleton } from "@/components/transactions/transactions-list-skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState, FormError } from "@/components/error-state";
import { accountsQuery, categoriesQuery } from "@/lib/api/queries";
import { transactionsSearchQuery, type TransactionSearch } from "@/lib/api/ledger";
import { apiErrorMessage } from "@/lib/api/errors";
import { namesById } from "@/lib/dashboard-data";

export const Route = createFileRoute("/_authenticated/transactions")({
  component: TransactionsPage,
});

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

function TransactionsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-200 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        <TransactionsContent />
      </div>
    </div>
  );
}

/**
 * The search box. It owns what is typed, so a keystroke re-renders only the box;
 * the page gets the text once typing pauses. Remount it (`key`) to clear it.
 */
function SearchBox({ onSearch }: { onSearch: (q: string) => void }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text), 300);
    return () => clearTimeout(timer);
  }, [text, onSearch]);
  return (
    <div className="relative mb-4">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search description, payee or note"
        aria-label="Search transactions"
        maxLength={200}
        className="h-10 pl-9"
      />
    </div>
  );
}

function toSearch(filters: TransactionFilters, q: string): TransactionSearch {
  return {
    ...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
    ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(q.trim() ? { q: q.trim().slice(0, 200) } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Transactions content                                                      */
/* -------------------------------------------------------------------------- */

function TransactionsContent() {
  const [filters, setFilters] = useState<TransactionFilters>(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [q, setQ] = useState("");
  /** Bumped to clear the search box. */
  const [searchKey, setSearchKey] = useState(0);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // The record stays set while its dialog closes, so the dialog doesn't flip to create mode as it animates out.
  const [editTransaction, setEditTransaction] = useState<Transaction | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTransferId, setEditTransferId] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const invalidRange = hasInvalidDateRange(filters);
  const search = toSearch(filters, q);
  const isFiltered = Object.keys(search).length > 0;

  const result = useInfiniteQuery({
    ...transactionsSearchQuery(search),
    enabled: !invalidRange,
    placeholderData: keepPreviousData,
  });

  // Names for the rows, archived accounts and categories included.
  const accountsResult = useQuery(accountsQuery({ includeArchived: true }));
  const categoriesResult = useQuery(categoriesQuery({ includeArchived: true }));
  const accountNames = useMemo(() => namesById(accountsResult.data?.items), [accountsResult.data]);
  const categoryNames = useMemo(() => namesById(categoriesResult.data?.items), [categoriesResult.data]);

  const transactions = result.data?.pages.flatMap((page) => page.items) ?? [];

  function clearFilters() {
    setFilters(defaultFilters);
    setQ("");
    setSearchKey((k) => k + 1);
  }

  let body: React.ReactNode;
  if (invalidRange) {
    body = (
      <EmptyState title="Check the date range" detail="The start date is after the end date.">
        <Button variant="outline" size="sm" onClick={() => setFiltersOpen(true)}>
          Edit filters
        </Button>
      </EmptyState>
    );
  } else if (result.isPending || (result.isPlaceholderData && transactions.length === 0)) {
    // The previous search's empty result isn't this one's answer.
    body = <TransactionsListSkeleton />;
  } else if (result.isError && transactions.length === 0) {
    body = (
      <ErrorState
        error={result.error}
        fallback="Couldn't load your transactions. Try again."
        onRetry={() => void result.refetch()}
      />
    );
  } else if (transactions.length === 0) {
    body = isFiltered ? (
      <EmptyState title="No matching transactions" detail="Try other filters or search terms.">
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      </EmptyState>
    ) : (
      <EmptyState title="No transactions yet" detail="Add your first transaction to start tracking your finances." />
    );
  } else {
    body = (
      <>
        <div
          role="list"
          aria-label="Transactions"
          aria-busy={result.isFetching || undefined}
          className={result.isPlaceholderData ? "space-y-3 opacity-60 transition-opacity" : "space-y-3"}
        >
          {transactions.map((tx) => (
            <TransactionRow
              key={tx.id}
              transaction={tx}
              accountNames={accountNames}
              categoryNames={categoryNames}
              onEdit={() => {
                setEditTransaction(tx);
                setEditOpen(true);
              }}
              onEditTransfer={() => {
                setEditTransferId(tx.id);
                setTransferOpen(true);
              }}
            />
          ))}
        </div>
        {result.isRefetchError && (
          <FormError
            className="text-center"
            message={apiErrorMessage(result.error, "Couldn't refresh your transactions. Showing the last loaded list.")}
          />
        )}
        {result.isFetchNextPageError && (
          <FormError className="text-center" message={apiErrorMessage(result.error, "Couldn't load more transactions. Try again.")} />
        )}
        {result.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              disabled={result.isFetchingNextPage || result.isPlaceholderData}
              onClick={() => void result.fetchNextPage()}
            >
              {result.isFetchingNextPage ? "Loading..." : "Load more"}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Transactions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Record and manage your income and expenses.</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <TransactionFilterButton filters={filters} onClick={() => setFiltersOpen(true)} />
          <Button variant="accent" className="flex-1 sm:flex-none" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Add transaction
          </Button>
        </div>
      </div>

      <SearchBox key={searchKey} onSearch={setQ} />

      {body}

      {/* Filters Sheet */}
      <TransactionFiltersSheet open={filtersOpen} onOpenChange={setFiltersOpen} filters={filters} onChange={setFilters} />

      {/* Create Dialog */}
      <TransactionFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} transaction={null} />

      {/* Edit Dialog (income / expense) */}
      <TransactionFormDialog open={editOpen} onOpenChange={setEditOpen} transaction={editTransaction} />

      {/* Edit Transfer Dialog */}
      <TransferFormDialog open={transferOpen} onOpenChange={setTransferOpen} transferId={editTransferId} />
    </>
  );
}

function EmptyState({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 sm:py-16">
      <ArrowLeftRight className="mb-3 size-10 text-muted-foreground/50" aria-hidden="true" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
