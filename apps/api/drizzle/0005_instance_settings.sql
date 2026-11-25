CREATE TYPE "public"."ai_provider" AS ENUM('gateway', 'openrouter');--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_user_id" uuid,
	"telegram_bot_token_sealed" text,
	"telegram_bot_token_hint" text,
	"telegram_bot_id" bigint,
	"telegram_bot_username" text,
	"telegram_webhook_secret_sealed" text,
	"telegram_updated_at" timestamp with time zone,
	"ai_provider" "ai_provider",
	"ai_model" text,
	"ai_api_key_sealed" text,
	"ai_api_key_hint" text,
	"ai_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("instance_settings"."id" = 1),
	CONSTRAINT "instance_settings_telegram_complete" CHECK (("instance_settings"."telegram_bot_token_sealed" is null) = ("instance_settings"."telegram_bot_username" is null) and ("instance_settings"."telegram_bot_token_sealed" is null) = ("instance_settings"."telegram_webhook_secret_sealed" is null)),
	CONSTRAINT "instance_settings_ai_complete" CHECK (("instance_settings"."ai_provider" is null) = ("instance_settings"."ai_model" is null) and ("instance_settings"."ai_provider" is null) = ("instance_settings"."ai_api_key_sealed" is null))
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The instance owner of an existing database: its earliest user (none yet on a fresh one).
INSERT INTO "instance_settings" ("id", "owner_user_id") SELECT 1, (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1);
