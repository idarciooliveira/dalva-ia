/**
 * Realistic Finance API data (contract shapes, minor units) for the agent's
 * tests and the eval. Base currency AOA; one USD account so reports across
 * currencies can be exercised.
 */

type Json = Record<string, any>;

const aoa = (major: number) => ({ amountMinor: Math.round(major * 100), currency: "AOA" });
const usd = (major: number) => ({ amountMinor: Math.round(major * 100), currency: "USD" });

const accounts: Json[] = [
  { id: "00000001-0000-4000-8000-000000000001", name: "BAI Conta Ordem", type: "bank", balance: aoa(845_320.5) },
  { id: "00000001-0000-4000-8000-000000000003", name: "Carteira", type: "cash", balance: aoa(32_000) },
  { id: "00000001-0000-4000-8000-000000000002", name: "Poupança BFA", type: "savings", balance: aoa(1_250_000) },
  { id: "00000001-0000-4000-8000-000000000007", name: "Visa BIC", type: "credit_card", balance: aoa(-185_400) },
  { id: "00000001-0000-4000-8000-000000000004", name: "Wise USD", type: "e_wallet", balance: usd(1_240.75) },
  { id: "00000001-0000-4000-8000-000000000008", name: "Conta antiga", type: "bank", balance: aoa(0), archived: true },
];

const categories: Json[] = [
  { id: "00000002-0000-4000-8000-000000000001", name: "Alimentação", type: "expense", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000002", name: "Transporte", type: "expense", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000005", name: "Casa", type: "expense", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000003", name: "Lazer", type: "expense", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000008", name: "Saúde", type: "expense", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000004", name: "Salário", type: "income", isDefault: true },
  { id: "00000002-0000-4000-8000-000000000007", name: "Freelance", type: "income", isDefault: false },
];

const subcategories: Json[] = [
  { id: "00000003-0000-4000-8000-000000000004", categoryId: "00000002-0000-4000-8000-000000000001", name: "Supermercado", archived: false, sortOrder: 1 },
  { id: "00000003-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000001", name: "Restaurantes", archived: false, sortOrder: 2 },
  { id: "00000003-0000-4000-8000-000000000002", categoryId: "00000002-0000-4000-8000-000000000002", name: "Combustível", archived: false, sortOrder: 1 },
  { id: "00000003-0000-4000-8000-000000000003", categoryId: "00000002-0000-4000-8000-000000000002", name: "Táxi / Yango", archived: false, sortOrder: 2 },
  { id: "00000003-0000-4000-8000-000000000005", categoryId: "00000002-0000-4000-8000-000000000005", name: "Renda", archived: false, sortOrder: 1 },
];

const transactions: Json[] = [
  { id: "00000004-0000-4000-8000-000000000001", type: "expense", amount: aoa(18_450), accountId: "00000001-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000001", subcategoryId: "00000003-0000-4000-8000-000000000004", date: "2026-11-10", description: "Kero Talatona" },
  { id: "00000004-0000-4000-8000-000000000005", type: "expense", amount: aoa(6_500), accountId: "00000001-0000-4000-8000-000000000003", categoryId: "00000002-0000-4000-8000-000000000002", subcategoryId: "00000003-0000-4000-8000-000000000003", date: "2026-11-09", description: "Yango" },
  { id: "00000004-0000-4000-8000-000000000015", type: "expense", amount: aoa(24_000), accountId: "00000001-0000-4000-8000-000000000007", categoryId: "00000002-0000-4000-8000-000000000001", subcategoryId: "00000003-0000-4000-8000-000000000001", date: "2026-11-08", description: "Jantar Ilha" },
  { id: "00000004-0000-4000-8000-000000000014", type: "income", amount: aoa(650_000), accountId: "00000001-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000004", date: "2026-11-05", description: "Salário Novembro" },
  { id: "00000004-0000-4000-8000-000000000013", type: "expense", amount: aoa(150_000), accountId: "00000001-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000005", subcategoryId: "00000003-0000-4000-8000-000000000005", date: "2026-11-03", description: "Renda" },
  { id: "00000004-0000-4000-8000-000000000012", type: "expense", amount: aoa(30_000), accountId: "00000001-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000002", subcategoryId: "00000003-0000-4000-8000-000000000002", date: "2026-11-02", description: "Pumangol" },
  { id: "00000004-0000-4000-8000-000000000011", type: "expense", amount: usd(12.99), accountId: "00000001-0000-4000-8000-000000000004", categoryId: "00000002-0000-4000-8000-000000000003", date: "2026-11-01", description: "Spotify" },
  { id: "00000004-0000-4000-8000-000000000010", type: "expense", amount: aoa(9_800), accountId: "00000001-0000-4000-8000-000000000003", categoryId: "00000002-0000-4000-8000-000000000008", date: "2026-10-28", description: "Farmácia" },
];

/**
 * Rows only reachable by id (not in searches): a transfer's two legs, and rows
 * owned by a goal contribution and a debt payment.
 */
const managedTransactions: Array<{ transaction: Json; managedBy: string }> = [
  {
    transaction: { id: "00000004-0000-4000-8000-000000000004", type: "transfer", amount: aoa(20_000), accountId: "00000001-0000-4000-8000-000000000001", destinationAccountId: "00000001-0000-4000-8000-000000000002", linkedTransactionId: "00000004-0000-4000-8000-000000000002", transferGroupId: "tg_1", date: "2026-11-07" },
    managedBy: "transfer",
  },
  {
    transaction: { id: "00000004-0000-4000-8000-000000000002", type: "transfer", amount: aoa(20_000), accountId: "00000001-0000-4000-8000-000000000002", linkedTransactionId: "00000004-0000-4000-8000-000000000004", transferGroupId: "tg_1", date: "2026-11-07" },
    managedBy: "transfer",
  },
  {
    transaction: { id: "00000004-0000-4000-8000-000000000006", type: "transfer", amount: aoa(50_000), accountId: "00000001-0000-4000-8000-000000000001", destinationAccountId: "00000001-0000-4000-8000-000000000002", linkedTransactionId: "00000004-0000-4000-8000-000000000009", transferGroupId: "tg_2", date: "2026-11-06" },
    managedBy: "goal_contribution",
  },
  {
    transaction: { id: "00000004-0000-4000-8000-000000000007", type: "expense", amount: aoa(95_000), accountId: "00000001-0000-4000-8000-000000000001", date: "2026-11-04" },
    managedBy: "debt_payment",
  },
];

const transactionSummary = (month: string): Json => ({
  month,
  totalIncome: aoa(650_000),
  totalExpenses: aoa(228_950),
  totalAdjustments: aoa(0),
  recentTransactions: transactions.filter((tx) => tx.amount.currency === "AOA").slice(0, 3),
});

const spendingByCategory = (month: string): Json => ({
  month,
  total: aoa(228_950),
  categories: [
    { categoryId: "00000002-0000-4000-8000-000000000005", name: "Casa", amount: aoa(150_000) },
    { categoryId: "00000002-0000-4000-8000-000000000001", name: "Alimentação", amount: aoa(42_450) },
    { categoryId: "00000002-0000-4000-8000-000000000002", name: "Transporte", amount: aoa(36_500) },
  ],
});

const cashflow = (month: string, trendMonths: number): Json => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const trend = Array.from({ length: trendMonths }, (_, i) => {
    const date = new Date(Date.UTC(year, m - 1 - (trendMonths - 1 - i), 1));
    const label = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { month: label, income: aoa(650_000), expenses: aoa(380_000 + i * 10_000) };
  });
  return { currentMonth: { income: aoa(650_000), expenses: aoa(228_950), net: aoa(421_050) }, trend };
};

const netWorth: Json = {
  hasData: true,
  totalAssets: aoa(2_127_320.5),
  totalDebts: aoa(2_185_400),
  netWorth: aoa(-58_079.5),
};

const goals: Json[] = [
  { id: "00000005-0000-4000-8000-000000000001", name: "Carro", targetAmount: aoa(4_000_000), currentAmount: aoa(1_250_000), targetDate: "2027-12-31", linkedAccountId: "00000001-0000-4000-8000-000000000002", isVirtual: false, createdAt: "2026-01-10" },
  { id: "00000005-0000-4000-8000-000000000002", name: "Viagem a Lisboa", targetAmount: aoa(900_000), currentAmount: aoa(310_000), targetDate: "2027-07-01", isVirtual: true, createdAt: "2026-03-02" },
];

const debts: Json[] = [
  { id: "00000006-0000-4000-8000-000000000001", name: "Crédito automóvel", debtType: "loan", lender: "BFA", originalAmount: aoa(3_000_000), currentBalance: aoa(2_000_000), interestRate: 14, minimumPayment: aoa(95_000), dueDate: "2026-11-25", createdAt: "2025-06-01" },
  { id: "00000006-0000-4000-8000-000000000002", name: "Visa BIC", debtType: "credit_card", lender: "BIC", originalAmount: aoa(185_400), currentBalance: aoa(185_400), createdAt: "2026-09-01" },
];

const debtSummary: Json = {
  totalOriginal: aoa(3_185_400),
  totalRemaining: aoa(2_185_400),
  recentPayment: aoa(95_000),
  debts: [
    { id: "00000006-0000-4000-8000-000000000001", name: "Crédito automóvel", creditor: "BFA", originalAmount: aoa(3_000_000), currentBalance: aoa(2_000_000), percentPaid: 33 },
    { id: "00000006-0000-4000-8000-000000000002", name: "Visa BIC", creditor: "BIC", originalAmount: aoa(185_400), currentBalance: aoa(185_400), percentPaid: 0 },
  ],
};

/** Filters like the backend does (enough for the agent's tests and the eval). */
function searchTransactions(query: Json): Json {
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
  for (const transaction of transactions) fake.reads.set(`/transactions/${transaction.id}`, { transaction });
  for (const managed of managedTransactions) fake.reads.set(`/transactions/${managed.transaction.id}`, managed);
  for (const goal of goals) fake.reads.set(`/goals/${goal.id}`, { goal });
  for (const debt of debts) fake.reads.set(`/debts/${debt.id}`, { debt });
}
