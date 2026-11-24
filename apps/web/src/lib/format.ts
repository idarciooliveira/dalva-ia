/*  Formatting helpers                                                        */
/*  Shared across dashboard components, transaction lists, etc.               */
/* -------------------------------------------------------------------------- */

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

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
