import { Coins, ArrowRight } from "lucide-react";
import { CURRENCIES } from "@/lib/currencies";
import { CurrencyFlag } from "@/components/currency-flag";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StepHeader } from "./step-header";

export function CurrencyStep({
  currency,
  onCurrencyChange,
  onNext,
  isSubmitting,
}: {
  currency: string;
  onCurrencyChange: (value: string) => void;
  onNext: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="space-y-6">
      <StepHeader
        icon={Coins}
        title="Welcome to DALVA"
        subtitle="Let's set up your finances. First, choose your base currency."
      />

      <div className="space-y-2">
        <Label htmlFor="currency">Base currency</Label>
        <Select value={currency} onValueChange={onCurrencyChange}>
          <SelectTrigger id="currency" className="w-full">
            <SelectValue placeholder="Select a currency" />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                <CurrencyFlag country={c.country} /> {c.name} ({c.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          This will be used across all your accounts and reports.
        </p>
      </div>

      <Button
        variant="accent"
        className="w-full"
        onClick={onNext}
        disabled={isSubmitting}
      >
        {isSubmitting ? "Saving..." : "Continue"}
        {!isSubmitting && <ArrowRight className="size-4" />}
      </Button>
    </div>
  );
}
