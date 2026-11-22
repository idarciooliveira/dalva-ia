interface AccountPickerHintProps {
  loading: boolean;
  error: boolean;
  /** No account to pick. */
  empty: boolean;
  /** Accounts of the right type left out for their currency. */
  otherCurrency: number;
  currency: string;
  /** What the picker lists, e.g. "savings or bank account". */
  noun: string;
}

/**
 * Below the account picker of a goal or debt: why it is empty or shorter than
 * the accounts page. Goals and debts take only accounts in the base currency.
 */
export function AccountPickerHint({ loading, error, empty, otherCurrency, currency, noun }: AccountPickerHintProps) {
  if (loading) return null;
  let text: string | null = null;
  if (error) text = "Couldn't load your accounts. Close and try again.";
  else if (empty) text = `No ${noun} in ${currency}, your base currency, yet.`;
  else if (otherCurrency > 0) text = `Only accounts in ${currency}, your base currency, are listed.`;
  if (!text) return null;
  return <p className="mt-1.5 px-2 text-xs text-muted-foreground">{text}</p>;
}
