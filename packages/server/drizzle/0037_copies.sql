CREATE TABLE "copies" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"brings_published" boolean NOT NULL,
	"opened_by" uuid NOT NULL,
	"opener_id" text NOT NULL,
	"source_space_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"source_permission_version" bigint NOT NULL,
	"destination_space_id" text NOT NULL,
	"destination_parent_id" text,
	"permission_version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copies_id_shape" CHECK ("copies"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "copies_move_elsewhere" CHECK ("copies"."kind" = 'copy' or "copies"."source_space_id" <> "copies"."destination_space_id")
);
--> statement-breakpoint
CREATE TABLE "copy_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"copy_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_parent_id" text,
	"draft_from" text,
	"published_from" text,
	"metadata_from" text
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "copy_id" text;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_source_space_id_spaces_id_fk" FOREIGN KEY ("source_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_destination_space_id_spaces_id_fk" FOREIGN KEY ("destination_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_nodes" ADD CONSTRAINT "copy_nodes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_nodes" ADD CONSTRAINT "copy_nodes_copy_id_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copies_touched_at_idx" ON "copies" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "copy_nodes_copy_idx" ON "copy_nodes" USING btree ("copy_id");--> statement-breakpoint
CREATE INDEX "nodes_copy_idx" ON "nodes" USING btree ("copy_id") WHERE "nodes"."copy_id" is not null;--> statement-breakpoint
-- Hand-added, over 0035's version: a copy's hidden nodes are in no tree, so
-- making them, giving them records and removing them names no space. Showing them (`copy_id` set
-- to null) names their space, as does a page's heads row once shown.
CREATE OR REPLACE FUNCTION "wikistow_tree_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed record;
  space text;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  IF TG_TABLE_NAME = 'spaces' THEN
    space := changed."id";
  ELSIF TG_TABLE_NAME IN ('page_heads', 'public_links') THEN
    SELECT "space_id" INTO space FROM "nodes"
      WHERE "id" = changed."page_id" AND "copy_id" IS NULL;
  ELSIF TG_TABLE_NAME = 'nodes' THEN
    -- Nested: a record has only its own table's fields.
    IF changed."copy_id" IS NULL THEN space := changed."space_id"; END IF;
  ELSE
    space := changed."space_id";
  END IF;
  IF space IS NOT NULL THEN
    PERFORM pg_notify('wikistow_tree', space);
  END IF;
  RETURN NULL;
END $$;
