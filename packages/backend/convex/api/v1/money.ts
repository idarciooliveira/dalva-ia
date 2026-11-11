import { currencyExponent, type Money } from "@mpf/finance-contract";

/**
 * The app stores every currency as value × 100, whatever its ISO exponent.
 * The contract speaks ISO 4217 minor units. This module is the only place
 * that converts between the two.
 *
 * - 2-decimal currencies (USD, EUR, AOA, ...) pass through unchanged.
 * - Scaling up multiplies exactly.
 * - Scaling down rounds half away from zero (KWD 1.235 -> app 124 -> ...);
 *   request amounts go through `minorToAppExact`, which refuses instead.
 */
export const APP_EXPONENT = 2;

export class MoneyRangeError extends Error {
  override name = "MoneyRangeError";
}

/** An amount with more precision than the app's x100 storage (e.g. 12.345 KWD). */
export class MoneyPrecisionError extends Error {
  override name = "MoneyPrecisionError";
}

function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

/** Integer division by `divisor`, rounding half away from zero. */
function divideRounded(value: number, divisor: number): number {
  const abs = Math.abs(value);
  const quotient = Math.floor(abs / divisor);
  const remainder = abs - quotient * divisor;
  const rounded = remainder * 2 >= divisor ? quotient + 1 : quotient;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

function rescale(value: number, fromExponent: number, toExponent: number): number {
  const integer = Number.isInteger(value) ? value : roundHalfAwayFromZero(value);
  const result =
    toExponent >= fromExponent
      ? integer * 10 ** (toExponent - fromExponent)
      : divideRounded(integer, 10 ** (fromExponent - toExponent));
  if (!Number.isSafeInteger(result)) {
    throw new MoneyRangeError(`Amount out of range: ${value}`);
  }
  return result === 0 ? 0 : result;
}

/** App amount (value × 100) -> ISO minor units of `currency`. */
export function appToMinor(appAmount: number, currency: string): number {
  return rescale(appAmount, APP_EXPONENT, currencyExponent(currency));
}

/** ISO minor units of `currency` -> app amount (value × 100). */
export function minorToApp(amountMinor: number, currency: string): number {
  return rescale(amountMinor, currencyExponent(currency), APP_EXPONENT);
}

/**
 * Request amounts: ISO minor units -> app amount, exactly or not at all. What
 * a client sends is what gets stored; an amount the x100 storage can't hold
 * (12.345 KWD) throws `MoneyPrecisionError` instead of being rounded.
 */
export function minorToAppExact(amountMinor: number, currency: string): number {
  const app = minorToApp(amountMinor, currency);
  if (appToMinor(app, currency) !== amountMinor) {
    throw new MoneyPrecisionError(`${currency} amounts can have at most ${APP_EXPONENT} decimal places`);
  }
  return app;
}

export function toMoney(appAmount: number, currency: string): Money {
  return { amountMinor: appToMinor(appAmount, currency), currency };
}
