-- The first account now comes from the setup page. Links from the old
-- bootstrap-admin command still open are withdrawn, so none stays listed or
-- holds its address.
UPDATE "invitations" SET "revoked_at" = now()
  WHERE "kind" = 'bootstrap' AND "accepted_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_kind";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "kind";
