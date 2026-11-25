export const CURRENCIES = [
  { code: "AOA", name: "Angolan Kwanza", symbol: "Kz", country: "AO" },
  { code: "USD", name: "US Dollar", symbol: "$", country: "US" },
  { code: "EUR", name: "Euro", symbol: "\u20AC", country: "EU" },
  { code: "GBP", name: "British Pound", symbol: "\u00A3", country: "GB" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", country: "BR" },
  { code: "JPY", name: "Japanese Yen", symbol: "\u00A5", country: "JP" },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$", country: "CA" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", country: "AU" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", country: "CH" },
  { code: "INR", name: "Indian Rupee", symbol: "\u20B9", country: "IN" },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$", country: "MX" },
  { code: "CNY", name: "Chinese Yuan", symbol: "\u00A5", country: "CN" },
  { code: "KRW", name: "South Korean Won", symbol: "\u20A9", country: "KR" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr", country: "SE" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr", country: "NO" },
  { code: "PLN", name: "Polish Zloty", symbol: "z\u0142", country: "PL" },
  { code: "TRY", name: "Turkish Lira", symbol: "\u20BA", country: "TR" },
  { code: "ZAR", name: "South African Rand", symbol: "R", country: "ZA" },
  { code: "ARS", name: "Argentine Peso", symbol: "$", country: "AR" },
  { code: "COP", name: "Colombian Peso", symbol: "$", country: "CO" },
  { code: "NGN", name: "Nigerian Naira", symbol: "\u20A6", country: "NG" },
] as const;

/**
 * Get the display symbol for a currency code.
 * Falls back to the code itself if not found.
 */
export function getCurrencySymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? code;
}
