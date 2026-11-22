import { Wallet, ArrowRight, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getCategoryIcon } from "@/lib/category-icons";
import { ErrorState } from "@/components/error-state";
import { StepHeader } from "./step-header";

interface DefaultCategory {
  name: string;
  type: "income" | "expense";
  icon: string;
  color: string;
}

export function CategoriesStep({
  defaultCategories,
  loadError = null,
  onRetryLoad,
  selectedCategories,
  onSelectedChange,
  onFinish,
  onBack,
  isSubmitting,
}: {
  defaultCategories: DefaultCategory[];
  /** The default list couldn't be loaded. */
  loadError?: unknown;
  onRetryLoad?: () => void;
  selectedCategories: string[];
  onSelectedChange: (names: string[]) => void;
  onFinish: () => void;
  onBack: () => void;
  isSubmitting: boolean;
}) {
  const incomeCategories = defaultCategories.filter((c) => c.type === "income");
  const expenseCategories = defaultCategories.filter(
    (c) => c.type === "expense",
  );

  function toggleCategory(name: string) {
    if (selectedCategories.includes(name)) {
      onSelectedChange(selectedCategories.filter((n) => n !== name));
    } else {
      onSelectedChange([...selectedCategories, name]);
    }
  }

  function selectAll() {
    onSelectedChange(defaultCategories.map((c) => c.name));
  }

  function deselectAll() {
    onSelectedChange([]);
  }

  const allSelected = selectedCategories.length === defaultCategories.length;

  return (
    <div className="space-y-6">
      <StepHeader
        icon={Wallet}
        title="Choose your categories"
        subtitle="We'll start you with these defaults. You can customize later."
      />

      {loadError != null && (
        <ErrorState error={loadError} fallback="Couldn't load the categories." onRetry={onRetryLoad} />
      )}

      {/* Select all / deselect all */}
      {defaultCategories.length > 0 && (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={allSelected ? deselectAll : selectAll}
          className="text-xs font-medium text-primary underline-offset-4 hover:underline dark:text-primary"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>
      )}

      {/* Income */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Income
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {incomeCategories.map((c) => (
            <CategoryCheckbox
              key={c.name}
              name={c.name}
              icon={c.icon}
              color={c.color}
              checked={selectedCategories.includes(c.name)}
              onToggle={() => toggleCategory(c.name)}
            />
          ))}
        </div>
      </div>

      {/* Expense */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Expenses
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {expenseCategories.map((c) => (
            <CategoryCheckbox
              key={c.name}
              name={c.name}
              icon={c.icon}
              color={c.color}
              checked={selectedCategories.includes(c.name)}
              onToggle={() => toggleCategory(c.name)}
            />
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={onBack} disabled={isSubmitting}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button
          variant="accent"
          className="flex-1"
          onClick={onFinish}
          disabled={isSubmitting || selectedCategories.length === 0}
        >
          {isSubmitting ? "Setting up..." : "Get started"}
          {!isSubmitting && <ArrowRight className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Category checkbox                                                         */
/* -------------------------------------------------------------------------- */

function CategoryCheckbox({
  name,
  icon,
  color,
  checked,
  onToggle,
}: {
  name: string;
  icon: string;
  color: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const Icon = getCategoryIcon(icon);

  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50 has-data-[state=checked]:border-primary/30 has-data-[state=checked]:bg-primary/5">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <div
        className="flex size-6 items-center justify-center rounded-md"
        style={{ backgroundColor: color + "20" }}
      >
        <Icon className="size-3.5" style={{ color }} />
      </div>
      <span className="text-sm font-medium text-foreground">{name}</span>
    </label>
  );
}
