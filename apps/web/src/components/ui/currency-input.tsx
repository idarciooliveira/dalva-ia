import { forwardRef, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

const DEFAULT_LOCALE = "pt-BR";

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function isNegative(value: string): boolean {
  return (value.match(/-/g)?.length ?? 0) % 2 === 1;
}

export function formatCurrencyInput(
  value: string,
  locale: string = DEFAULT_LOCALE,
  fractionDigits: number = 2,
  allowNegative: boolean = false,
): string {
  const negative = allowNegative && isNegative(value);
  const digits = normalizeDigits(value);
  if (!digits) return negative ? "-" : "";

  const minor = Number(digits);
  if (Number.isNaN(minor)) return "";

  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minor / 10 ** fractionDigits);
  return negative ? `-${formatted}` : formatted;
}

export function parseCurrencyInput(value: string): number {
  const digits = normalizeDigits(value);
  if (!digits) return isNegative(value) ? Number.NaN : 0;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return Number.NaN;
  return isNegative(value) ? -minor : minor;
}

interface CurrencyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  locale?: string;
  fractionDigits?: number;
  allowNegative?: boolean;
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    { value, onValueChange, locale = DEFAULT_LOCALE, fractionDigits = 2, allowNegative = false, className, ...props },
    ref,
  ) {
    const formattedValue = useMemo(
      () => formatCurrencyInput(value, locale, fractionDigits, allowNegative),
      [locale, value, fractionDigits, allowNegative],
    );
    const [displayValue, setDisplayValue] = useState(formattedValue);

    useEffect(() => {
      setDisplayValue(formattedValue);
    }, [formattedValue]);

    return (
      <input
        {...props}
        ref={ref}
        type="text"
        inputMode={allowNegative ? "text" : "numeric"}
        value={displayValue}
        onChange={(event) => {
          const nextValue = formatCurrencyInput(event.target.value, locale, fractionDigits, allowNegative);
          setDisplayValue(nextValue);
          onValueChange(nextValue);
        }}
        className={cn(className)}
      />
    );
  },
);
