CREATE TYPE "public"."agent_action_status" AS ENUM('pending', 'confirmed', 'cancelled', 'expired', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_event_status" AS ENUM('received', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_message_role" AS ENUM('user', 'assistant', 'tool', 'system');--> statement-breakpoint
CREATE TABLE "agent_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel" "channel" NOT NULL,
	"event_id" text NOT NULL,
	"status" "agent_event_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "agent_message_role" NOT NULL,
	"content" text NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_key" text,
	"operation" text NOT NULL,
	"input" text NOT NULL,
	"summary" text NOT NULL,
	"status" "agent_action_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"chat_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_id_user_id_key" UNIQUE("id","user_id")
);
--> statement-breakpoint
-- Target of agent_sessions_identity_id_fk: must exist before it (drizzle-kit emits it last).
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_id_user_id_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."agent_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pending_actions" ADD CONSTRAINT "agent_pending_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pending_actions" ADD CONSTRAINT "agent_pending_actions_session_id_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."agent_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_identity_id_fk" FOREIGN KEY ("identity_id","user_id") REFERENCES "public"."channel_identities"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbound_events_channel_event_id_key" ON "agent_inbound_events" USING btree ("channel","event_id");--> statement-breakpoint
CREATE INDEX "agent_inbound_events_channel_status_updated_at_idx" ON "agent_inbound_events" USING btree ("channel","status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_inbound_events_updated_at_idx" ON "agent_inbound_events" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_session_id_seq_key" ON "agent_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "agent_pending_actions_session_id_status_idx" ON "agent_pending_actions" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "agent_pending_actions_user_id_client_key_idx" ON "agent_pending_actions" USING btree ("user_id","client_key");--> statement-breakpoint
CREATE INDEX "agent_pending_actions_pending_expires_at_idx" ON "agent_pending_actions" USING btree ("expires_at") WHERE "agent_pending_actions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_pending_actions_updated_at_idx" ON "agent_pending_actions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_active_chat_idx" ON "agent_sessions" USING btree ("user_id","channel","chat_id") WHERE "agent_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "agent_sessions_user_id_idx" ON "agent_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_identity_id_idx" ON "agent_sessions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_last_activity_at_idx" ON "agent_sessions" USING btree ("last_activity_at");