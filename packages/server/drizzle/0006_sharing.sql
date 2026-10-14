CREATE TABLE "owner_statements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "owner_statements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"space_id" text NOT NULL,
	"owner_identity_id" text NOT NULL,
	"owner_key_version" integer NOT NULL,
	"signer_identity_id" text NOT NULL,
	"signer_key_version" integer NOT NULL,
	"statement" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statements_once" UNIQUE("space_id","owner_identity_id","owner_key_version","signer_identity_id","signer_key_version")
);
--> statement-breakpoint
CREATE TABLE "space_owners" (
	"space_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "space_owners_space_id_identity_id_pk" PRIMARY KEY("space_id","identity_id"),
	CONSTRAINT "space_owners_human" CHECK ("space_owners"."identity_id" not like 'agent-%')
);
--> statement-breakpoint
CREATE TABLE "folder_key_envelopes" (
	"share_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"recipient_identity_id" text NOT NULL,
	"recipient_key_version" integer NOT NULL,
	"space_id" text NOT NULL,
	"sealer_identity_id" text NOT NULL,
	"drafts" boolean NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_key_envelopes_share_id_key_version_recipient_identity_id_recipient_key_version_pk" PRIMARY KEY("share_id","key_version","recipient_identity_id","recipient_key_version")
);
--> statement-breakpoint
CREATE TABLE "metadata_wraps" (
	"metadata_revision_id" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"wrap" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_wraps" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"wrap" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_members" (
	"share_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"role" text NOT NULL,
	"can_publish" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_members_share_id_identity_id_pk" PRIMARY KEY("share_id","identity_id"),
	CONSTRAINT "share_members_role" CHECK ("share_members"."role" in ('reader', 'editor')),
	CONSTRAINT "share_members_readers_never_publish" CHECK ("share_members"."role" <> 'reader' or not "share_members"."can_publish"),
	CONSTRAINT "share_members_human" CHECK ("share_members"."identity_id" not like 'agent-%')
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"root_id" text,
	"current_key_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_one_per_root" UNIQUE NULLS NOT DISTINCT("space_id","root_id"),
	CONSTRAINT "shares_id_shape" CHECK ("shares"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "shares_key_version" CHECK ("shares"."current_key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Milestone 1 made only owner grants, one per space. They carry over as
-- the space's owners; nothing else in that table gave access.
INSERT INTO "space_owners" ("space_id", "identity_id", "added_by", "created_at")
  SELECT "space_id", "identity_id", "created_by", "created_at" FROM "grants"
  WHERE "role" = 'owner' AND "state" = 'active' AND "revoked_at" IS NULL
    AND "identity_id" NOT LIKE 'agent-%'
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE "grants" CASCADE;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_owners" ADD CONSTRAINT "space_owners_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_owners" ADD CONSTRAINT "space_owners_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_key_envelopes" ADD CONSTRAINT "folder_key_envelopes_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_key_envelopes" ADD CONSTRAINT "folder_key_envelopes_recipient_identity_id_recipient_key_version_identities_id_key_version_fk" FOREIGN KEY ("recipient_identity_id","recipient_key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_wraps" ADD CONSTRAINT "metadata_wraps_metadata_revision_id_metadata_revisions_id_fk" FOREIGN KEY ("metadata_revision_id") REFERENCES "public"."metadata_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_wraps" ADD CONSTRAINT "metadata_wraps_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_wraps" ADD CONSTRAINT "revision_wraps_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_wraps" ADD CONSTRAINT "revision_wraps_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_members" ADD CONSTRAINT "share_members_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_members" ADD CONSTRAINT "share_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_members" ADD CONSTRAINT "share_members_identity_id_key_version_identities_id_key_version_fk" FOREIGN KEY ("identity_id","key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_space_id_root_id_nodes_space_id_id_fk" FOREIGN KEY ("space_id","root_id") REFERENCES "public"."nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_statements_space_idx" ON "owner_statements" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "space_owners_identity_idx" ON "space_owners" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "folder_key_envelopes_recipient_idx" ON "folder_key_envelopes" USING btree ("space_id","recipient_identity_id","recipient_key_version");--> statement-breakpoint
CREATE INDEX "metadata_wraps_share_idx" ON "metadata_wraps" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "revision_wraps_share_idx" ON "revision_wraps" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "share_members_identity_idx" ON "share_members" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "revisions_space_author_idx" ON "revisions" USING btree ("space_id","author_identity_id");--> statement-breakpoint
-- Every space keeps at least one current owner. Checked at commit, so a
-- space and its first owner can be added together, and an owner removed
-- and another added in one transaction.
CREATE FUNCTION "wikistow_space_has_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  space text;
BEGIN
  IF TG_TABLE_NAME = 'spaces' THEN
    space := NEW."id";
  ELSE
    space := OLD."space_id";
  END IF;
  IF EXISTS (SELECT 1 FROM "spaces" WHERE "id" = space)
    AND NOT EXISTS (
      SELECT 1 FROM "space_owners" WHERE "space_id" = space AND "removed_at" IS NULL
    ) THEN
    RAISE EXCEPTION 'space % would have no owner', space;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "spaces_have_owner" AFTER INSERT ON "spaces"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "wikistow_space_has_owner"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "space_owners_keep_one" AFTER UPDATE OR DELETE ON "space_owners"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "wikistow_space_has_owner"();
--> statement-breakpoint
-- Signed statements and envelopes are stored as signed. An envelope is
-- replaced by deleting it and storing the new one, never edited.
CREATE TRIGGER "owner_statements_immutable" BEFORE UPDATE ON "owner_statements"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "folder_key_envelopes_immutable" BEFORE UPDATE ON "folder_key_envelopes"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
-- A share stays in its space at its root, and its key version only moves up
-- by one, as a rotation does.
CREATE FUNCTION "wikistow_share_versions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."space_id" <> OLD."space_id"
    OR NEW."root_id" IS DISTINCT FROM OLD."root_id"
    OR NEW."created_at" <> OLD."created_at"
    OR NEW."current_key_version" NOT IN (OLD."current_key_version", OLD."current_key_version" + 1) THEN
    RAISE EXCEPTION 'share % only moves to its next key version', OLD."id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "shares_versions" BEFORE UPDATE ON "shares"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_share_versions"();
