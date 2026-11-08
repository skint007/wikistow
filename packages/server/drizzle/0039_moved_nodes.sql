CREATE TABLE "moved_nodes" (
	"old_id" text PRIMARY KEY NOT NULL,
	"old_space_id" text NOT NULL,
	"new_space_id" text NOT NULL,
	"new_id" text NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "moved_nodes_new_idx" ON "moved_nodes" USING btree ("new_space_id","new_id");