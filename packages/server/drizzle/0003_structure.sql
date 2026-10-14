CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" text NOT NULL,
	"node_id" text,
	"identity_id" text NOT NULL,
	"role" text NOT NULL,
	"can_publish" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "grants_role" CHECK ("grants"."role" in ('reader', 'editor', 'owner')),
	CONSTRAINT "grants_owner_is_space_wide" CHECK ("grants"."role" <> 'owner' or ("grants"."node_id" is null and "grants"."can_publish"))
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" text NOT NULL,
	"key_version" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"box_public_key" text NOT NULL,
	"sign_public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "identities_id_key_version_pk" PRIMARY KEY("id","key_version"),
	CONSTRAINT "identities_id_shape" CHECK ("identities"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "identities_agent_prefix" CHECK (("identities"."kind" = 'agent') = ("identities"."id" like 'agent-%'))
);
--> statement-breakpoint
CREATE TABLE "key_envelopes" (
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"recipient_identity_id" text NOT NULL,
	"recipient_key_version" integer NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_envelopes_subject_kind_subject_id_recipient_identity_id_recipient_key_version_pk" PRIMARY KEY("subject_kind","subject_id","recipient_identity_id","recipient_key_version")
);
--> statement-breakpoint
CREATE TABLE "metadata_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"based_on" text,
	"author_identity_id" text NOT NULL,
	"author_key_version" integer NOT NULL,
	"sealed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_revisions_one_successor" UNIQUE NULLS NOT DISTINCT("subject_kind","subject_id","based_on"),
	CONSTRAINT "metadata_revisions_id_shape" CHECK ("metadata_revisions"."id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"parent_id" text,
	"kind" text NOT NULL,
	"permission_version" bigint DEFAULT 1 NOT NULL,
	"metadata_head" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_space_id" UNIQUE("space_id","id"),
	CONSTRAINT "nodes_id_shape" CHECK ("nodes"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "nodes_page_has_no_metadata" CHECK ("nodes"."kind" = 'folder' or "nodes"."metadata_head" is null)
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"permission_version" bigint DEFAULT 1 NOT NULL,
	"metadata_head" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_id_shape" CHECK ("spaces"."id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "vault_wrappers" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"wrapper" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_envelopes" ADD CONSTRAINT "key_envelopes_recipient_identity_id_recipient_key_version_identities_id_key_version_fk" FOREIGN KEY ("recipient_identity_id","recipient_key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_revisions" ADD CONSTRAINT "metadata_revisions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_space_id_parent_id_nodes_space_id_id_fk" FOREIGN KEY ("space_id","parent_id") REFERENCES "public"."nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_wrappers" ADD CONSTRAINT "vault_wrappers_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_identity_idx" ON "grants" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "grants_space_idx" ON "grants" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_one_live_human_per_account" ON "identities" USING btree ("account_id") WHERE "identities"."kind" = 'human' and "identities"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "identities_account_idx" ON "identities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "metadata_revisions_space_idx" ON "metadata_revisions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "nodes_space_parent_idx" ON "nodes" USING btree ("space_id","parent_id");
--> statement-breakpoint
-- Signed records are immutable: a new version is a new row, never an edit.
CREATE FUNCTION "wikistow_forbid_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER "metadata_revisions_immutable" BEFORE UPDATE ON "metadata_revisions"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "key_envelopes_immutable" BEFORE UPDATE ON "key_envelopes"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
-- An identity's keys never change; rotation adds a new key version instead.
CREATE TRIGGER "identities_keys_immutable"
  BEFORE UPDATE OF "id", "key_version", "kind", "box_public_key", "sign_public_key", "account_id" ON "identities"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
-- An identity ID belongs to one account forever. Without this, someone could
-- register another person's ID at a new key version and inherit their grants.
CREATE FUNCTION "wikistow_identity_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "identities" WHERE "id" = NEW."id" AND "account_id" <> NEW."account_id") THEN
    RAISE EXCEPTION 'identity % belongs to another account', NEW."id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "identities_one_owner" BEFORE INSERT ON "identities"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_identity_owner"();
