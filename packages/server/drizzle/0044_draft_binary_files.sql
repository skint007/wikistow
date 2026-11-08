ALTER TABLE "plugin_draft_files" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_draft_files" ADD COLUMN "data" "bytea";--> statement-breakpoint
ALTER TABLE "plugin_draft_files" ADD CONSTRAINT "plugin_draft_files_text_or_data" CHECK (("plugin_draft_files"."text" is null) <> ("plugin_draft_files"."data" is null));