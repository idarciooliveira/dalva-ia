import { formatMinorAmount } from "@mpf/finance-contract";

/** `1234567` USD -> `12,345.67 USD`; `-5000` JPY -> `-5,000 JPY`. */
export function formatMoney(amountMinor: number, currency: string): string {
  const plain = formatMinorAmount(amountMinor, currency);
  const negative = plain.startsWith("-");
  const [whole = "0", fraction] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""} ${currency}`;
}
