import { useQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { api } from "@mpf/backend/convex/_generated/api";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetDescription,
} from "@/components/ui/sheet";

export interface TransactionFilters {
  dateFrom: string;
  dateTo: string;
  accountId: string; // "" = all
  categoryId: string; // "" = all
  type: "" | "income" | "expense" | "adjustment" | "transfer"; // "" = all
}

export const defaultFilters: TransactionFilters = {
  dateFrom: "",
  dateTo: "",
  accountId: "",
  categoryId: "",
  type: "",
};

/** Count how many filters are actively set */
function activeFilterCount(filters: TransactionFilters): number {
  let count = 0;
  if (filters.dateFrom) count++;
  if (filters.dateTo) count++;
  if (filters.accountId) count++;
  if (filters.categoryId) count++;
  if (filters.type) count++;
  return count;
}

/* -------------------------------------------------------------------------- */
/*  Filter trigger button                                                     */
/* -------------------------------------------------------------------------- */

interface TransactionFilterButtonProps {
  filters: TransactionFilters;
  onClick: () => void;
}

export function TransactionFilterButton({
  filters,
  onClick,
}: TransactionFilterButtonProps) {
  const count = activeFilterCount(filters);

  return (
    <Button
      variant="outline"
      size="default"
      onClick={onClick}
      className="relative"
    >
      <SlidersHorizontal className="mr-1.5 size-4" />
      Filters
      {count > 0 && (
        <span className="ml-1.5 inline-flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
          {count}
        </span>
      )}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Filter sheet                                                              */
/* -------------------------------------------------------------------------- */

interface TransactionFiltersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: TransactionFilters;
  onChange: (filters: TransactionFilters) => void;
}

export function TransactionFiltersSheet({
  open,
  onOpenChange,
  filters,
  onChange,
}: TransactionFiltersSheetProps) {
  const { data: accounts } = useQuery(
    convexQuery(api.accounts.listAccounts, {}),
  );
  const { data: categories } = useQuery(
    convexQuery(api.categories.listCategories, {}),
  );

  function update(partial: Partial<TransactionFilters>) {
    onChange({ ...filters, ...partial });
  }

  function clearAll() {
    onChange(defaultFilters);
  }

  const hasActiveFilters = activeFilterCount(filters) > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Filter transactions</SheetTitle>
          <SheetDescription>
            Narrow down your transaction list.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          {/* Date range */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Date range
            </p>
            <div className="space-y-2">
              <div className="space-y-1.5">
                <Label htmlFor="filter-date-from" className="text-xs">
                  From
                </Label>
                <Input
                  id="filter-date-from"
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => update({ dateFrom: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-date-to" className="text-xs">
                  To
                </Label>
                <Input
                  id="filter-date-to"
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => update({ dateTo: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Account */}
          <div className="space-y-1.5">
            <Label className="text-xs">Account</Label>
            <Select
              value={filters.accountId || "__all__"}
              onValueChange={(v) =>
                update({ accountId: v === "__all__" ? "" : v })
              }
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All accounts</SelectItem>
                {(accounts ?? []).map((a) => (
                  <SelectItem key={a._id} value={a._id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select
              value={filters.categoryId || "__all__"}
              onValueChange={(v) =>
                update({ categoryId: v === "__all__" ? "" : v })
              }
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All categories</SelectItem>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c._id} value={c._id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Type */}
          <div className="space-y-1.5">
            <Label className="text-xs">Type</Label>
            <Select
              value={filters.type || "__all__"}
              onValueChange={(v) =>
                update({
                  type:
                    v === "__all__" ? "" : (v as TransactionFilters["type"]),
                })
              }
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All</SelectItem>
                <SelectItem value="income">Income</SelectItem>
                <SelectItem value="expense">Expense</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
                <SelectItem value="adjustment">Adjustment</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <SheetFooter>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Clear all filters
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
