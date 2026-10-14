CREATE TABLE "agent_edits" (
	"agent_id" text NOT NULL,
	"page_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"audience" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_edits_agent_id_page_id_pk" PRIMARY KEY("agent_id","page_id")
);
--> statement-breakpoint
DROP INDEX "revisions_author_created_idx";--> statement-breakpoint
ALTER TABLE "agent_edits" ADD CONSTRAINT "agent_edits_agent_id_agent_profiles_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_profiles"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edits" ADD CONSTRAINT "agent_edits_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_edits_page_created_idx" ON "agent_edits" USING btree ("page_id","created_at");--> statement-breakpoint
-- Each agent's latest version of each page, from the versions still stored.
INSERT INTO agent_edits (agent_id, page_id, revision_id, audience, created_at)
SELECT DISTINCT ON (r.author_identity_id, r.page_id)
  r.author_identity_id, r.page_id, r.id, r.audience, r.created_at
FROM revisions r JOIN agent_profiles a ON a.agent_id = r.author_identity_id
ORDER BY r.author_identity_id, r.page_id, r.created_at DESC, r.id DESC;
