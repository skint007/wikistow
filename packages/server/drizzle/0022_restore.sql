-- If not there already: restore.sh adds them after restoring a backup taken before them.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "restored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "backup_taken_at" timestamp with time zone;
