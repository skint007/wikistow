CREATE TABLE "public_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text NOT NULL,
	"rendering" jsonb NOT NULL,
	"reader_version" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_files" (
	"copy_id" uuid NOT NULL,
	"attachment_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" bigint NOT NULL,
	"bytes" "bytea",
	"left_out" boolean DEFAULT false NOT NULL,
	CONSTRAINT "public_files_copy_id_attachment_id_pk" PRIMARY KEY("copy_id","attachment_id"),
	CONSTRAINT "public_files_size" CHECK ("public_files"."bytes" is null or octet_length("public_files"."bytes") <= "public_files"."size"),
	CONSTRAINT "public_files_left_out" CHECK (not "public_files"."left_out" or "public_files"."bytes" is null)
);
--> statement-breakpoint
ALTER TABLE "public_files" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
--> statement-breakpoint
CREATE TABLE "public_links" (
	"page_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"shared_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_links_id_unique" UNIQUE("id"),
	CONSTRAINT "public_links_id_shape" CHECK ("public_links"."id" ~ '^[A-Za-z0-9_-]{22}$')
);
--> statement-breakpoint
CREATE TABLE "public_targets" (
	"copy_id" uuid NOT NULL,
	"key" text NOT NULL,
	"target_page_id" text NOT NULL,
	CONSTRAINT "public_targets_copy_id_key_pk" PRIMARY KEY("copy_id","key")
);
--> statement-breakpoint
ALTER TABLE "public_copies" ADD CONSTRAINT "public_copies_page_id_public_links_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."public_links"("page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_copies" ADD CONSTRAINT "public_copies_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_files" ADD CONSTRAINT "public_files_copy_id_public_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."public_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_links" ADD CONSTRAINT "public_links_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_links" ADD CONSTRAINT "public_links_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_targets" ADD CONSTRAINT "public_targets_copy_id_public_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."public_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_targets" ADD CONSTRAINT "public_targets_target_page_id_public_links_page_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."public_links"("page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "public_copies_one_live" ON "public_copies" USING btree ("page_id") WHERE "public_copies"."live";--> statement-breakpoint
CREATE INDEX "public_copies_page_idx" ON "public_copies" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "public_copies_uploaded_by_idx" ON "public_copies" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "public_links_shared_by_idx" ON "public_links" USING btree ("shared_by");--> statement-breakpoint
CREATE INDEX "public_targets_target_idx" ON "public_targets" USING btree ("target_page_id");--> statement-breakpoint
-- As 0034's, with public links too: the tree marks a page with a link, so
-- turning one on or off names the page's space, as a change to its heads does.
CREATE OR REPLACE FUNCTION "wikistow_tree_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed record;
  space text;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  IF TG_TABLE_NAME = 'spaces' THEN
    space := changed."id";
  ELSIF TG_TABLE_NAME IN ('page_heads', 'public_links') THEN
    SELECT "space_id" INTO space FROM "nodes" WHERE "id" = changed."page_id";
  ELSE
    space := changed."space_id";
  END IF;
  IF space IS NOT NULL THEN
    PERFORM pg_notify('wikistow_tree', space);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A link turned on or off. One that goes with its page is told by the page's own delete.
CREATE TRIGGER "public_links_tree_changed" AFTER INSERT OR DELETE ON "public_links"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_tree_changed"();
