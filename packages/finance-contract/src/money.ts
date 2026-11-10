/**
 * Decimal <-> minor-unit conversion.
 *
 * Everything here works on digit strings and BigInt. No floats are involved,
 * so `parseDecimalAmount("1.005", "USD")` is exactly 101, never 100.
 */

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** ISO 4217 minor-unit exponents that differ from the default of 2. */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimals
  CLF: 4, UYW: 4,
};

const CURRENCY_RE = /^[A-Z]{3}$/;

/** Number of decimal places of the currency's minor unit (JPY 0, USD 2, KWD 3). */
export function currencyExponent(currency: string): number {
  if (!CURRENCY_RE.test(currency)) {
    throw new MoneyError(`Invalid currency code: ${JSON.stringify(currency)}`);
  }
  return EXPONENT_OVERRIDES[currency] ?? 2;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a plain decimal string ("12.34", "-5", "+0.5") into integer minor
 * units for `currency`.
 *
 * - Only `.` is accepted as separator; no grouping, exponents or symbols.
 * - Extra fraction digits are rounded half away from zero.
 * - Throws `MoneyError` on malformed input or if the result is not a safe integer.
 */
export function parseDecimalAmount(input: string, currency: string): number {
  const exponent = currencyExponent(currency);
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) {
    throw new MoneyError(`Invalid decimal amount: ${JSON.stringify(input)}`);
  }

  const sign = match[1];
  const whole = match[2]!;
  const fraction = match[3] ?? "";

  let minor = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, "0"));
  const firstDropped = fraction.charAt(exponent);
  if (firstDropped !== "" && firstDropped >= "5") minor += 1n;

  if (minor > MAX_SAFE) {
    throw new MoneyError(`Amount out of range: ${JSON.stringify(input)}`);
  }

  const value = Number(minor);
  return sign === "-" && value !== 0 ? -value : value;
}

/** Format integer minor units as a plain decimal string ("1234" USD -> "12.34"). */
export function formatMinorAmount(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Amount must be a safe integer of minor units: ${amountMinor}`);
  }

  const digits = BigInt(Math.abs(amountMinor)).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${amountMinor < 0 ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`;
}

/** Convenience: decimal string -> `{ amountMinor, currency }`. */
export function moneyFromDecimal(input: string, currency: string) {
  return { amountMinor: parseDecimalAmount(input, currency), currency };
}
