import { currencyExponent } from "@mpf/shared";

export function fractionDigits(currency: string): number {
  try {
    return currencyExponent(currency);
  } catch {
    return 2;
  }
}

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

export function decimalPlaceholder(digits: number): string {
  return digits > 0 ? `0.${"0".repeat(digits)}` : "0";
}

export function maskPlaceholder(digits: number): string {
  return decimalPlaceholder(digits).replace(".", ",");
}
