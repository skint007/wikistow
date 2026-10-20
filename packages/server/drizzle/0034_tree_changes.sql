-- Once a change to a space's tree commits, name the space on the
-- "wikistow_tree" channel: its ID only, never what changed. The server tells
-- the people who see that space, whose apps load its tree again (see
-- `listenForTreeChanges`). Postgres sends each space once per transaction, and
-- nothing for one that rolls back.
CREATE FUNCTION "wikistow_tree_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed record;
  space text;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  IF TG_TABLE_NAME = 'spaces' THEN
    space := changed."id";
  ELSIF TG_TABLE_NAME = 'page_heads' THEN
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
-- The space's name and look.
CREATE TRIGGER "spaces_tree_changed" AFTER UPDATE OR DELETE ON "spaces"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_tree_changed"();
--> statement-breakpoint
-- Folders and pages made, moved, renamed or deleted.
CREATE TRIGGER "nodes_tree_changed" AFTER INSERT OR UPDATE OR DELETE ON "nodes"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_tree_changed"();
--> statement-breakpoint
-- A page's title and status come from its latest draft and published version.
-- A publication into another space adds its row only with its first version.
CREATE TRIGGER "page_heads_tree_changed" AFTER INSERT OR UPDATE OF "draft_head", "published_head" ON "page_heads"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_tree_changed"();
--> statement-breakpoint
-- Shares the tree marks.
CREATE TRIGGER "shares_tree_changed" AFTER INSERT OR UPDATE OR DELETE ON "shares"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_tree_changed"();
