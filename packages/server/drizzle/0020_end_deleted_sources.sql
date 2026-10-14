-- Deleting a page now ends its publications. End those left live by pages
-- deleted before: each whose source page is gone, or is a later page made
-- with its ID, or is an opening, which an open no longer takes as a source.
-- A publication belongs to a page with a version, in its source's space,
-- made by the time the publication was, and that still has the version a
-- copy was last sent from. When in doubt it ends. An opening that never got
-- a version goes, with its row and its uploads' rows, and the attachment
-- sweep removes their files. A copy with versions stays, ended, as when the
-- source's publisher ends it.
DELETE FROM "nodes" WHERE "id" IN (
  SELECT p."destination_page_id" FROM "publications" p
  WHERE p."detached_at" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "page_heads" h WHERE h."page_id" = p."destination_page_id")
    AND NOT EXISTS (
      SELECT 1 FROM "nodes" s
      WHERE s."id" = p."source_page_id" AND s."space_id" = p."source_space_id" AND s."kind" = 'page'
        AND s."created_at" <= p."created_at"
        AND EXISTS (SELECT 1 FROM "page_heads" sh WHERE sh."page_id" = s."id")
        AND (p."last_source_revision_id" IS NULL OR EXISTS (SELECT 1 FROM "revisions" r
          WHERE r."id" = p."last_source_revision_id" AND r."page_id" = s."id"))));
--> statement-breakpoint
UPDATE "publications" p SET "detached_at" = now()
WHERE p."detached_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "nodes" s
    WHERE s."id" = p."source_page_id" AND s."space_id" = p."source_space_id" AND s."kind" = 'page'
      AND s."created_at" <= p."created_at"
      AND EXISTS (SELECT 1 FROM "page_heads" sh WHERE sh."page_id" = s."id")
      AND (p."last_source_revision_id" IS NULL OR EXISTS (SELECT 1 FROM "revisions" r
        WHERE r."id" = p."last_source_revision_id" AND r."page_id" = s."id")));
