/**
 * Realistic Finance API data (contract shapes, minor units) for the agent's
 * tests and the eval. Base currency AOA; one USD account so reports across
 * currencies can be exercised.
 */

type Json = Record<string, any>;

const aoa = (major: number) => ({ amountMinor: Math.round(major * 100), currency: "AOA" });
const usd = (major: number) => ({ amountMinor: Math.round(major * 100), currency: "USD" });

export const accounts: Json[] = [
  { id: "acc_bai", name: "BAI Conta Ordem", type: "bank", balance: aoa(845_320.5) },
  { id: "acc_cash", name: "Carteira", type: "cash", balance: aoa(32_000) },
  { id: "acc_poup", name: "Poupança BFA", type: "savings", balance: aoa(1_250_000) },
  { id: "acc_visa", name: "Visa BIC", type: "credit_card", balance: aoa(-185_400) },
  { id: "acc_usd", name: "Wise USD", type: "e_wallet", balance: usd(1_240.75) },
  { id: "acc_old", name: "Conta antiga", type: "bank", balance: aoa(0), archived: true },
];

export const categories: Json[] = [
  { id: "cat_food", name: "Alimentação", type: "expense", isDefault: true },
  { id: "cat_transport", name: "Transporte", type: "expense", isDefault: true },
  { id: "cat_home", name: "Casa", type: "expense", isDefault: true },
  { id: "cat_fun", name: "Lazer", type: "expense", isDefault: true },
  { id: "cat_health", name: "Saúde", type: "expense", isDefault: true },
  { id: "cat_salary", name: "Salário", type: "income", isDefault: true },
  { id: "cat_freelance", name: "Freelance", type: "income", isDefault: false },
];

export const subcategories: Json[] = [
  { id: "sub_market", categoryId: "cat_food", name: "Supermercado", archived: false, sortOrder: 1 },
  { id: "sub_rest", categoryId: "cat_food", name: "Restaurantes", archived: false, sortOrder: 2 },
  { id: "sub_fuel", categoryId: "cat_transport", name: "Combustível", archived: false, sortOrder: 1 },
  { id: "sub_taxi", categoryId: "cat_transport", name: "Táxi / Yango", archived: false, sortOrder: 2 },
  { id: "sub_rent", categoryId: "cat_home", name: "Renda", archived: false, sortOrder: 1 },
];

export const transactions: Json[] = [
  { id: "tx_1", type: "expense", amount: aoa(18_450), accountId: "acc_bai", categoryId: "cat_food", subcategoryId: "sub_market", date: "2026-11-10", description: "Kero Talatona" },
  { id: "tx_2", type: "expense", amount: aoa(6_500), accountId: "acc_cash", categoryId: "cat_transport", subcategoryId: "sub_taxi", date: "2026-11-09", description: "Yango" },
  { id: "tx_3", type: "expense", amount: aoa(24_000), accountId: "acc_visa", categoryId: "cat_food", subcategoryId: "sub_rest", date: "2026-11-08", description: "Jantar Ilha" },
  { id: "tx_4", type: "income", amount: aoa(650_000), accountId: "acc_bai", categoryId: "cat_salary", date: "2026-11-05", description: "Salário Novembro" },
  { id: "tx_5", type: "expense", amount: aoa(150_000), accountId: "acc_bai", categoryId: "cat_home", subcategoryId: "sub_rent", date: "2026-11-03", description: "Renda" },
  { id: "tx_6", type: "expense", amount: aoa(30_000), accountId: "acc_bai", categoryId: "cat_transport", subcategoryId: "sub_fuel", date: "2026-11-02", description: "Pumangol" },
  { id: "tx_7", type: "expense", amount: usd(12.99), accountId: "acc_usd", categoryId: "cat_fun", date: "2026-11-01", description: "Spotify" },
  { id: "tx_8", type: "expense", amount: aoa(9_800), accountId: "acc_cash", categoryId: "cat_health", date: "2026-10-28", description: "Farmácia" },
];

export const transactionSummary = (month: string): Json => ({
  month,
  totalIncome: aoa(650_000),
  totalExpenses: aoa(228_950),
  totalAdjustments: aoa(0),
  recentTransactions: transactions.filter((tx) => tx.amount.currency === "AOA").slice(0, 3),
});

export const spendingByCategory = (month: string): Json => ({
  month,
  total: aoa(228_950),
  categories: [
    { categoryId: "cat_home", name: "Casa", amount: aoa(150_000) },
    { categoryId: "cat_food", name: "Alimentação", amount: aoa(42_450) },
    { categoryId: "cat_transport", name: "Transporte", amount: aoa(36_500) },
  ],
});

export const cashflow = (month: string, trendMonths: number): Json => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const trend = Array.from({ length: trendMonths }, (_, i) => {
    const date = new Date(Date.UTC(year, m - 1 - (trendMonths - 1 - i), 1));
    const label = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { month: label, income: aoa(650_000), expenses: aoa(380_000 + i * 10_000) };
  });
  return { currentMonth: { income: aoa(650_000), expenses: aoa(228_950), net: aoa(421_050) }, trend };
};

export const netWorth: Json = {
  hasData: true,
  totalAssets: aoa(2_127_320.5),
  totalDebts: aoa(2_185_400),
  netWorth: aoa(-58_079.5),
};

export const goals: Json[] = [
  { id: "goal_car", name: "Carro", targetAmount: aoa(4_000_000), currentAmount: aoa(1_250_000), targetDate: "2027-12-31", linkedAccountId: "acc_poup", isVirtual: false, createdAt: "2026-01-10" },
  { id: "goal_trip", name: "Viagem a Lisboa", targetAmount: aoa(900_000), currentAmount: aoa(310_000), targetDate: "2027-07-01", isVirtual: true, createdAt: "2026-03-02" },
];

export const debts: Json[] = [
  { id: "debt_car", name: "Crédito automóvel", debtType: "loan", lender: "BFA", originalAmount: aoa(3_000_000), currentBalance: aoa(2_000_000), interestRate: 14, minimumPayment: aoa(95_000), dueDate: "2026-11-25", createdAt: "2025-06-01" },
  { id: "debt_visa", name: "Visa BIC", debtType: "credit_card", lender: "BIC", originalAmount: aoa(185_400), currentBalance: aoa(185_400), createdAt: "2026-09-01" },
];

export const debtSummary: Json = {
  totalOriginal: aoa(3_185_400),
  totalRemaining: aoa(2_185_400),
  recentPayment: aoa(95_000),
  debts: [
    { id: "debt_car", name: "Crédito automóvel", creditor: "BFA", originalAmount: aoa(3_000_000), currentBalance: aoa(2_000_000), percentPaid: 33 },
    { id: "debt_visa", name: "Visa BIC", creditor: "BIC", originalAmount: aoa(185_400), currentBalance: aoa(185_400), percentPaid: 0 },
  ],
};

/** Filters like the backend does (enough for the agent's tests and the eval). */
export function searchTransactions(query: Json): Json {
  const limit = Number(query.limit ?? 25);
  const items = transactions.filter(
    (tx) =>
      (!query.type || tx.type === query.type) &&
      (!query.accountId || tx.accountId === query.accountId) &&
      (!query.categoryId || tx.categoryId === query.categoryId) &&
      (!query.dateFrom || tx.date >= query.dateFrom) &&
      (!query.dateTo || tx.date <= query.dateTo) &&
      (!query.q || String(tx.description ?? "").toLowerCase().includes(String(query.q).toLowerCase())),
  );
  return { items: items.slice(0, limit), nextCursor: items.length > limit ? "next" : null };
}

/** Install every read route on a `fakeFinance()` (or anything with the same `accounts` + `reads`). */
export function seedFinance(fake: { accounts: Json[]; reads: Map<string, Json | ((query: Json) => Json)> }): void {
  fake.accounts.push(...accounts);
  fake.reads.set("/categories", { items: categories });
  fake.reads.set("/subcategories", { items: subcategories });
  fake.reads.set("/transactions", searchTransactions);
  fake.reads.set("/reports/transaction-summary", (q) => transactionSummary(String(q.month)));
  fake.reads.set("/reports/spending-by-category", (q) => spendingByCategory(String(q.month)));
  fake.reads.set("/reports/cashflow", (q) => cashflow(String(q.month), Number(q.trendMonths ?? 6)));
  fake.reads.set("/reports/net-worth", netWorth);
  fake.reads.set("/goals", { items: goals });
  fake.reads.set("/debts", { items: debts });
  fake.reads.set("/reports/debt-summary", debtSummary);
}
