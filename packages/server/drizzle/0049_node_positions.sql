-- Where each page or folder sits in its folder's own order (#400): a
-- fractional index, compared byte by byte, so the "C" collation. Null lists
-- it by name. A change to it is a change to `nodes`, so `nodes_tree_changed`
-- tells the people who see the space.
ALTER TABLE "nodes" ADD COLUMN "position" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_position_shape" CHECK ("nodes"."position" is null or "nodes"."position" ~ '^[A-Za-z][0-9A-Za-z]{1,99}$');
