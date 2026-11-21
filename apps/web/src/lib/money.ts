import { currencyExponent } from "@mpf/finance-contract";

/*
 * Money from the API is `{ amountMinor, currency }` in ISO 4217 minor units
 * (USD cents, JPY yen, KWD fils). Format and parse through these helpers only;
 * `formatCurrency(cents)` in format.ts is the Convex-era helper (value × 100 for
 * every currency) kept for the pages that move in PRs 10-11.
 */

/** Fraction digits of the currency's minor unit, 2 for an unknown or malformed code. */
export function fractionDigits(currency: string): number {
  try {
    return currencyExponent(currency);
  } catch {
    return 2;
  }
}

/** Integer minor units → "$1,234.56" / "¥1,235" / "KWD 1.235". */
export function formatMinor(amountMinor: number, currency: string): string {
  const digits = fractionDigits(currency);
  const value = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    // Intl rejects codes it doesn't know; still show the amount.
    return `${currency} ${value.toFixed(digits)}`;
  }
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * A plain decimal from a number input ("12.5", "-20", "") → minor units, or null
 * when it isn't a number, has more decimals than the currency allows, or doesn't
 * fit a safe integer. Empty means zero. Never rounds: the API would refuse it.
 */
export function parseDecimalInput(input: string, currency: string): number | null {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) return null;
  const [, sign, whole = "", fraction = ""] = match;
  const digits = fractionDigits(currency);
  if (fraction.length > digits) return null;
  if (whole === "" && fraction === "") return sign ? null : 0;
  const minor = BigInt((whole || "0") + fraction.padEnd(digits, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(minor);
  return sign === "-" && value !== 0 ? -value : value;
}

/** "0.00" / "0" / "0.000": what an empty decimal field shows for the currency. */
export function decimalPlaceholder(digits: number): string {
  return digits > 0 ? `0.${"0".repeat(digits)}` : "0";
}

/** The same in the masked `CurrencyInput` (pt-BR): "0,00" / "0" / "0,000". */
export function maskPlaceholder(digits: number): string {
  return decimalPlaceholder(digits).replace(".", ",");
}
