import { forwardRef, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

const DEFAULT_LOCALE = "pt-BR";

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Each "-" typed toggles the sign, wherever the caret is: "1,00-" is negative, "-1,00-" positive. */
function isNegative(value: string): boolean {
  return (value.match(/-/g)?.length ?? 0) % 2 === 1;
}

/**
 * Digit mask: every typed digit shifts in from the right ("1", "0,01", "0,12",
 * "1,23"). `fractionDigits` is the currency's minor-unit exponent, so the digits
 * are the amount in minor units. With `allowNegative`, typing "-" anywhere toggles the sign.
 */
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

/** Convex-era pages: the digits as cents. Use `parseCurrencyInput` with the API. */
export function parseCurrencyInputToCents(value: string): number {
  const digits = normalizeDigits(value);
  if (!digits) return 0;

  const cents = Number(digits);
  return Number.isNaN(cents) ? Number.NaN : cents;
}

/**
 * The masked value as signed integer minor units, at the `fractionDigits` it was
 * typed with. Empty is 0; NaN for a lone "-" or when it doesn't fit a safe integer.
 */
export function parseCurrencyInput(value: string): number {
  const digits = normalizeDigits(value);
  // A sign alone is not an amount.
  if (!digits) return isNegative(value) ? Number.NaN : 0;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return Number.NaN;
  return isNegative(value) ? -minor : minor;
}

interface CurrencyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  locale?: string;
  /** The currency's minor-unit exponent (2 for USD, 0 for JPY). Default 2. */
  fractionDigits?: number;
  /** Allow a sign: typing "-" anywhere toggles it (balances can be negative). */
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
