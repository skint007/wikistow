CREATE TABLE "publications" (
	"destination_page_id" text PRIMARY KEY NOT NULL,
	"destination_space_id" text NOT NULL,
	"source_space_id" text NOT NULL,
	"source_page_id" text NOT NULL,
	"last_source_revision_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detached_at" timestamp with time zone,
	CONSTRAINT "publications_other_space" CHECK ("publications"."source_space_id" <> "publications"."destination_space_id")
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_destination_page_id_nodes_id_fk" FOREIGN KEY ("destination_page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_destination_space_id_spaces_id_fk" FOREIGN KEY ("destination_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_live" ON "publications" USING btree ("source_page_id","destination_space_id") WHERE "publications"."detached_at" is null;--> statement-breakpoint
CREATE INDEX "publications_destination_space_idx" ON "publications" USING btree ("destination_space_id");