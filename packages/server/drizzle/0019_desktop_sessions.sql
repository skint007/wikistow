CREATE TABLE "desktop_handoffs" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sessions_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "desktop_handoffs" ADD CONSTRAINT "desktop_handoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_handoffs" ADD CONSTRAINT "desktop_handoffs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_handoffs_expires_idx" ON "desktop_handoffs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "desktop_handoffs_session_idx" ON "desktop_handoffs" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind" CHECK ("sessions"."kind" in ('browser', 'desktop'));