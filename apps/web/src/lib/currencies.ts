export const CURRENCIES = [
  { code: "USD", name: "US Dollar", symbol: "$", flag: "\u{1F1FA}\u{1F1F8}" },
  { code: "EUR", name: "Euro", symbol: "\u20AC", flag: "\u{1F1EA}\u{1F1FA}" },
  { code: "GBP", name: "British Pound", symbol: "\u00A3", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", flag: "\u{1F1E7}\u{1F1F7}" },
  { code: "AOA", name: "Angolan Kwanza", symbol: "Kz", flag: "\u{1F1E6}\u{1F1F4}" },
  { code: "JPY", name: "Japanese Yen", symbol: "\u00A5", flag: "\u{1F1EF}\u{1F1F5}" },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$", flag: "\u{1F1E8}\u{1F1E6}" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", flag: "\u{1F1E6}\u{1F1FA}" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", flag: "\u{1F1E8}\u{1F1ED}" },
  { code: "INR", name: "Indian Rupee", symbol: "\u20B9", flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$", flag: "\u{1F1F2}\u{1F1FD}" },
  { code: "CNY", name: "Chinese Yuan", symbol: "\u00A5", flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "KRW", name: "South Korean Won", symbol: "\u20A9", flag: "\u{1F1F0}\u{1F1F7}" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr", flag: "\u{1F1F8}\u{1F1EA}" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr", flag: "\u{1F1F3}\u{1F1F4}" },
  { code: "PLN", name: "Polish Zloty", symbol: "z\u0142", flag: "\u{1F1F5}\u{1F1F1}" },
  { code: "TRY", name: "Turkish Lira", symbol: "\u20BA", flag: "\u{1F1F9}\u{1F1F7}" },
  { code: "ZAR", name: "South African Rand", symbol: "R", flag: "\u{1F1FF}\u{1F1E6}" },
  { code: "ARS", name: "Argentine Peso", symbol: "$", flag: "\u{1F1E6}\u{1F1F7}" },
  { code: "COP", name: "Colombian Peso", symbol: "$", flag: "\u{1F1E8}\u{1F1F4}" },
  { code: "NGN", name: "Nigerian Naira", symbol: "\u20A6", flag: "\u{1F1F3}\u{1F1EC}" },
] as const;

/**
 * Get the display symbol for a currency code.
 * Falls back to the code itself if not found.
 */
export function getCurrencySymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? code;
}
