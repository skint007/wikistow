CREATE TABLE "identity_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_kind" text;
--> statement-breakpoint
UPDATE "audit_events" SET "actor_kind" = CASE WHEN "actor_account_id" IS NULL THEN 'operator' ELSE 'account' END;
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "actor_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "kind" text DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_kind" CHECK ("audit_events"."actor_kind" in ('account', 'operator'));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_kind" CHECK ("invitations"."kind" in ('account', 'bootstrap'));
--> statement-breakpoint
-- Before deletion existed, only bootstrap links had no issuer and the admin role.
UPDATE "invitations" SET "kind" = 'bootstrap' WHERE "created_by" IS NULL AND "role" = 'admin';
--> statement-breakpoint
INSERT INTO "identity_reservations" ("id", "account_id")
  SELECT DISTINCT "id", "account_id" FROM "identities";
--> statement-breakpoint
-- An ID's owner outlives its keys and account. The upsert serializes competing claims.
CREATE OR REPLACE FUNCTION "wikistow_identity_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved_owner uuid;
BEGIN
  INSERT INTO "identity_reservations" ("id", "account_id") VALUES (NEW."id", NEW."account_id")
    ON CONFLICT ("id") DO NOTHING;
  SELECT "account_id" INTO reserved_owner FROM "identity_reservations" WHERE "id" = NEW."id";
  IF reserved_owner <> NEW."account_id" THEN
    RAISE EXCEPTION 'identity % belongs to another account', NEW."id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "identity_reservations_immutable" BEFORE UPDATE ON "identity_reservations"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "identity_reservations_permanent" BEFORE DELETE ON "identity_reservations"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
-- A deleted issuer cannot leave usable invitations, whatever their role.
CREATE FUNCTION "wikistow_delete_issuer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "invitations" SET "revoked_at" = now()
    WHERE "created_by" = OLD."id" AND "accepted_at" IS NULL AND "revoked_at" IS NULL;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "users_revoke_invitations" BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_delete_issuer"();
