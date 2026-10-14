ALTER TABLE "revisions" ADD COLUMN "source_revision_id" text;--> statement-breakpoint
CREATE INDEX "revisions_source_revision_idx" ON "revisions" USING btree ("source_revision_id") WHERE "revisions"."source_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "revisions_unnamed_copy_idx" ON "revisions" USING btree ("page_id") WHERE "revisions"."audience" = 'published' and "revisions"."based_on" is null and "revisions"."source_revision_id" is null;--> statement-breakpoint
-- Each publication's latest copy came from its last source version. Earlier
-- copies name theirs only inside ciphertext, so their source keeps every draft.
UPDATE revisions c SET source_revision_id = p.last_source_revision_id
FROM publications p
WHERE p.last_source_revision_id IS NOT NULL AND c.id = (
  SELECT l.id FROM revisions l
  WHERE l.page_id = p.destination_page_id AND l.audience = 'published' AND l.based_on IS NULL
  ORDER BY l.published_seq DESC LIMIT 1);
