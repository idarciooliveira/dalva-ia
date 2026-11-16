-- Foreign keys between domain rows are checked at commit, not per statement.
-- Code ported from Convex writes and deletes linked rows in any order inside
-- one transaction (a transfer's legs point at each other; a debt payment is
-- deleted after its transactions), and an import can load tables in any order.
-- Drizzle can't declare DEFERRABLE, so it is set here; test/schema.test.ts
-- fails if a later migration recreates one of these keys without it.
-- On the ON DELETE SET NULL keys only the existence check is deferred; Postgres
-- always runs the SET NULL action immediately.
ALTER TABLE "debt_payments" ALTER CONSTRAINT "debt_payments_debt_id_debts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "debt_payments" ALTER CONSTRAINT "debt_payments_from_account_id_accounts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "debt_payments" ALTER CONSTRAINT "debt_payments_source_transaction_id_transactions_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "debt_payments" ALTER CONSTRAINT "debt_payments_liability_transaction_id_transactions_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "debts" ALTER CONSTRAINT "debts_linked_account_id_accounts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "goal_contributions" ALTER CONSTRAINT "goal_contributions_goal_id_savings_goals_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "goal_contributions" ALTER CONSTRAINT "goal_contributions_transaction_id_transactions_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "savings_goals" ALTER CONSTRAINT "savings_goals_linked_account_id_accounts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "subcategories" ALTER CONSTRAINT "subcategories_category_id_categories_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transactions" ALTER CONSTRAINT "transactions_account_id_accounts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transactions" ALTER CONSTRAINT "transactions_category_id_categories_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transactions" ALTER CONSTRAINT "transactions_subcategory_id_subcategories_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transactions" ALTER CONSTRAINT "transactions_destination_account_id_accounts_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "transactions" ALTER CONSTRAINT "transactions_linked_transaction_id_transactions_id_fk" DEFERRABLE INITIALLY DEFERRED;
