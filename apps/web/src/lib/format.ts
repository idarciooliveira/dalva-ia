/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/*  Shared across dashboard components, transaction lists, etc.               */
/* -------------------------------------------------------------------------- */

/**
 * Format cents to a currency string.
 * E.g. 248500 → "$2,485.00"
 */
export function formatCurrency(
  cents: number,
  currency: string = "USD",
): string {
  const value = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}


/**
 * Format a date string (ISO) to a short readable format.
 * E.g. "2026-04-05" → "Apr 5"
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
