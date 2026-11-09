ALTER TABLE "plugin_drafts" ADD COLUMN "workshop" text;--> statement-breakpoint
ALTER TABLE "plugin_drafts" ADD COLUMN "workshop_revision" integer DEFAULT 0 NOT NULL;