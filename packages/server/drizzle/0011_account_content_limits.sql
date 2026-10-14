ALTER TABLE "nodes" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_created_by_kind_idx" ON "nodes" USING btree ("created_by","kind");--> statement-breakpoint
CREATE INDEX "spaces_created_by_idx" ON "spaces" USING btree ("created_by");--> statement-breakpoint
-- Attribute existing nodes to their first author, or the publication opener.
-- Missing old authors fall back to the space creator, so live legacy items count.
UPDATE nodes n SET created_by = coalesce(
  (SELECT p.created_by FROM publications p WHERE p.destination_page_id = n.id),
  (SELECT r.author_account_id FROM revisions r WHERE r.page_id = n.id
    ORDER BY r.created_at, r.draft_seq NULLS LAST, r.published_seq NULLS LAST, r.id LIMIT 1),
  (SELECT i.account_id FROM metadata_revisions m JOIN identities i
    ON i.id = m.author_identity_id AND i.key_version = m.author_key_version
    WHERE m.subject_kind = 'folder' AND m.subject_id = n.id
    ORDER BY m.created_at, m.id LIMIT 1),
  (SELECT s.created_by FROM spaces s WHERE s.id = n.space_id)
);
