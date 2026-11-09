CREATE TABLE "plugin_draft_builds" (
	"draft_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "plugin_draft_builds_draft_id_account_id_pk" PRIMARY KEY("draft_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_draft_shares" (
	"draft_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_draft_shares_draft_id_account_id_pk" PRIMARY KEY("draft_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_draft_workshops" (
	"draft_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"workshop" text,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plugin_draft_workshops_draft_id_account_id_pk" PRIMARY KEY("draft_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_draft_builds" ADD CONSTRAINT "plugin_draft_builds_draft_id_plugin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."plugin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_builds" ADD CONSTRAINT "plugin_draft_builds_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_shares" ADD CONSTRAINT "plugin_draft_shares_draft_id_plugin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."plugin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_shares" ADD CONSTRAINT "plugin_draft_shares_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_workshops" ADD CONSTRAINT "plugin_draft_workshops_draft_id_plugin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."plugin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_workshops" ADD CONSTRAINT "plugin_draft_workshops_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_draft_shares_account_idx" ON "plugin_draft_shares" USING btree ("account_id");--> statement-breakpoint
-- The owner's kept workshop and last build become theirs in the new tables.
INSERT INTO "plugin_draft_workshops" ("draft_id", "account_id", "workshop", "revision")
	SELECT "id", "owner_id", "workshop", "workshop_revision" FROM "plugin_drafts"
	WHERE "workshop" IS NOT NULL OR "workshop_revision" > 0;--> statement-breakpoint
INSERT INTO "plugin_draft_builds" ("draft_id", "account_id", "hash")
	SELECT "id", "owner_id", "build_hash" FROM "plugin_drafts" WHERE "build_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" DROP CONSTRAINT "plugin_draft_build_files_draft_id_plugin_drafts_id_fk";--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" DROP CONSTRAINT "plugin_draft_build_files_draft_id_path_pk";--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" ADD COLUMN "account_id" uuid;--> statement-breakpoint
UPDATE "plugin_draft_build_files" SET "account_id" = "plugin_drafts"."owner_id"
	FROM "plugin_drafts" WHERE "plugin_drafts"."id" = "plugin_draft_build_files"."draft_id";--> statement-breakpoint
-- Files of a build no draft names any more, which nothing served.
DELETE FROM "plugin_draft_build_files" WHERE NOT EXISTS (
	SELECT 1 FROM "plugin_draft_builds" WHERE "plugin_draft_builds"."draft_id" = "plugin_draft_build_files"."draft_id"
		AND "plugin_draft_builds"."account_id" = "plugin_draft_build_files"."account_id");--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" ADD CONSTRAINT "plugin_draft_build_files_draft_id_account_id_path_pk" PRIMARY KEY("draft_id","account_id","path");--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" ADD CONSTRAINT "plugin_draft_build_files_build_fk" FOREIGN KEY ("draft_id","account_id") REFERENCES "public"."plugin_draft_builds"("draft_id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_drafts" DROP COLUMN "build_hash";--> statement-breakpoint
ALTER TABLE "plugin_drafts" DROP COLUMN "workshop";--> statement-breakpoint
ALTER TABLE "plugin_drafts" DROP COLUMN "workshop_revision";
