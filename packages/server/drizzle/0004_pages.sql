CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"page_id" text NOT NULL,
	"audience" text NOT NULL,
	"size" bigint NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "revision_blobs" (
	"revision_id" text NOT NULL,
	"blob_hash" text NOT NULL,
	CONSTRAINT "revision_blobs_revision_id_blob_hash_pk" PRIMARY KEY("revision_id","blob_hash")
);
--> statement-breakpoint
CREATE TABLE "page_heads" (
	"page_id" text PRIMARY KEY NOT NULL,
	"draft_head" text,
	"published_head" text,
	"draft_count" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"space_id" text NOT NULL,
	"audience" text NOT NULL,
	"based_on" text,
	"author_identity_id" text NOT NULL,
	"author_key_version" integer NOT NULL,
	"author_account_id" uuid,
	"sealed" jsonb NOT NULL,
	"payload_size" integer NOT NULL,
	"draft_seq" integer,
	"published_seq" integer,
	"restored_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revisions_draft_seq" UNIQUE("page_id","draft_seq"),
	CONSTRAINT "revisions_published_seq" UNIQUE("page_id","published_seq"),
	CONSTRAINT "revisions_id_shape" CHECK ("revisions"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "revisions_one_sequence" CHECK (("revisions"."audience" = 'draft' and "revisions"."draft_seq" is not null and "revisions"."published_seq" is null)
       or ("revisions"."audience" = 'published' and "revisions"."published_seq" is not null and "revisions"."draft_seq" is null))
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_blobs" ADD CONSTRAINT "revision_blobs_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_blobs" ADD CONSTRAINT "revision_blobs_blob_hash_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "public"."blobs"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_heads" ADD CONSTRAINT "page_heads_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_author_account_id_users_id_fk" FOREIGN KEY ("author_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blobs_page_idx" ON "blobs" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "blobs_uploaded_by_idx" ON "blobs" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "revision_blobs_blob_idx" ON "revision_blobs" USING btree ("blob_hash");--> statement-breakpoint
CREATE INDEX "revisions_page_idx" ON "revisions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "revisions_author_account_idx" ON "revisions" USING btree ("author_account_id");--> statement-breakpoint
-- Everything signed or structural is immutable. author_account_id may still be
-- cleared, so deleting an account later doesn't need to rewrite history.
CREATE TRIGGER "revisions_immutable"
  BEFORE UPDATE OF "id", "page_id", "space_id", "audience", "based_on", "author_identity_id",
    "author_key_version", "sealed", "payload_size", "draft_seq", "published_seq", "restored_from"
  ON "revisions"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
--> statement-breakpoint
-- A blob's labels and size never change, and a committed blob never goes back
-- to staged. uploaded_by may still be cleared when an account is deleted.
CREATE FUNCTION "wikistow_blob_labels"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."hash" IS DISTINCT FROM OLD."hash"
    OR NEW."space_id" IS DISTINCT FROM OLD."space_id"
    OR NEW."page_id" IS DISTINCT FROM OLD."page_id"
    OR NEW."audience" IS DISTINCT FROM OLD."audience"
    OR NEW."size" IS DISTINCT FROM OLD."size"
    OR (OLD."state" = 'committed' AND NEW."state" <> 'committed') THEN
    RAISE EXCEPTION 'blob labels are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "blobs_labels" BEFORE UPDATE ON "blobs"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_blob_labels"();
