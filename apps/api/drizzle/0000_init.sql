CREATE TYPE "public"."account_type" AS ENUM('bank', 'savings', 'credit_card', 'cash', 'e_wallet', 'loan', 'investment');--> statement-breakpoint
CREATE TYPE "public"."category_type" AS ENUM('income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('telegram');--> statement-breakpoint
CREATE TYPE "public"."channel_scope" AS ENUM('finance:read', 'finance:write');--> statement-breakpoint
CREATE TYPE "public"."debt_type" AS ENUM('credit_card', 'loan', 'mortgage', 'student_loan', 'personal_loan', 'other');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('income', 'expense', 'adjustment', 'transfer');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"balance" bigint NOT NULL,
	"currency" text NOT NULL,
	"theme" text,
	"icon" text,
	"description" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "category_type" NOT NULL,
	"icon" text,
	"color" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"scopes" "channel_scope"[] NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"debt_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"principal_amount" bigint NOT NULL,
	"interest_amount" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"from_account_id" uuid,
	"source_transaction_id" uuid,
	"liability_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"debt_type" "debt_type" NOT NULL,
	"lender" text,
	"original_amount" bigint NOT NULL,
	"current_balance" bigint NOT NULL,
	"interest_rate" double precision,
	"minimum_payment" bigint,
	"due_date" date,
	"linked_account_id" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"created_on" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_contributions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_amount" bigint NOT NULL,
	"current_amount" bigint DEFAULT 0 NOT NULL,
	"target_date" date,
	"linked_account_id" uuid,
	"is_virtual" boolean NOT NULL,
	"icon" text,
	"color" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_on" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subcategories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"amount" bigint NOT NULL,
	"account_id" uuid,
	"category_id" uuid,
	"subcategory_id" uuid,
	"date" date NOT NULL,
	"description" text,
	"note" text,
	"payee" text,
	"tags" text[],
	"destination_account_id" uuid,
	"linked_transaction_id" uuid,
	"transfer_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"base_currency" text NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_source_transaction_id_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_liability_transaction_id_transactions_id_fk" FOREIGN KEY ("liability_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_subcategory_id_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_linked_transaction_id_transactions_id_fk" FOREIGN KEY ("linked_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_keys_user_id_key_key" ON "api_idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "categories_user_id_idx" ON "categories" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "categories_user_id_type_idx" ON "categories" USING btree ("user_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_active_external_key" ON "channel_identities" USING btree ("channel","external_user_id") WHERE "channel_identities"."unlinked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_active_user_key" ON "channel_identities" USING btree ("user_id","channel") WHERE "channel_identities"."unlinked_at" is null;--> statement-breakpoint
CREATE INDEX "channel_identities_user_id_idx" ON "channel_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_link_codes_code_hash_key" ON "channel_link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_link_codes_user_id_channel_key" ON "channel_link_codes" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "channel_link_codes_expires_at_idx" ON "channel_link_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "debt_payments_user_id_idx" ON "debt_payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "debt_payments_debt_id_idx" ON "debt_payments" USING btree ("debt_id","created_at");--> statement-breakpoint
CREATE INDEX "debt_payments_source_transaction_id_idx" ON "debt_payments" USING btree ("source_transaction_id");--> statement-breakpoint
CREATE INDEX "debt_payments_liability_transaction_id_idx" ON "debt_payments" USING btree ("liability_transaction_id");--> statement-breakpoint
CREATE INDEX "debt_payments_from_account_id_idx" ON "debt_payments" USING btree ("from_account_id");--> statement-breakpoint
CREATE INDEX "debts_user_id_idx" ON "debts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "debts_linked_account_id_idx" ON "debts" USING btree ("linked_account_id");--> statement-breakpoint
CREATE INDEX "goal_contributions_user_id_idx" ON "goal_contributions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "goal_contributions_goal_id_idx" ON "goal_contributions" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "goal_contributions_transaction_id_idx" ON "goal_contributions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "savings_goals_user_id_idx" ON "savings_goals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "savings_goals_linked_account_id_idx" ON "savings_goals" USING btree ("linked_account_id");--> statement-breakpoint
CREATE INDEX "subcategories_category_id_idx" ON "subcategories" USING btree ("category_id","created_at");--> statement-breakpoint
CREATE INDEX "subcategories_user_id_idx" ON "subcategories" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_user_id_date_idx" ON "transactions" USING btree ("user_id","date","created_at","id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_account_id_date_idx" ON "transactions" USING btree ("user_id","account_id","date","created_at","id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_category_id_date_idx" ON "transactions" USING btree ("user_id","category_id","date","created_at","id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_type_date_idx" ON "transactions" USING btree ("user_id","type","date","created_at","id");--> statement-breakpoint
CREATE INDEX "transactions_account_id_idx" ON "transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "transactions_category_id_idx" ON "transactions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transactions_transfer_group_id_idx" ON "transactions" USING btree ("transfer_group_id");--> statement-breakpoint
CREATE INDEX "transactions_subcategory_id_idx" ON "transactions" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX "transactions_destination_account_id_idx" ON "transactions" USING btree ("destination_account_id");--> statement-breakpoint
CREATE INDEX "transactions_linked_transaction_id_idx" ON "transactions" USING btree ("linked_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles" USING btree ("user_id");