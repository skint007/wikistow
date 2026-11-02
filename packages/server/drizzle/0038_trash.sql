CREATE TABLE "trash" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" text NOT NULL,
	"node_id" text NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trash_node_unique" UNIQUE("node_id")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "trash_id" uuid;--> statement-breakpoint
ALTER TABLE "trash" ADD CONSTRAINT "trash_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash" ADD CONSTRAINT "trash_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash" ADD CONSTRAINT "trash_space_id_node_id_nodes_space_id_id_fk" FOREIGN KEY ("space_id","node_id") REFERENCES "public"."nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_space_idx" ON "trash" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "trash_deleted_at_idx" ON "trash" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_trash_id_trash_id_fk" FOREIGN KEY ("trash_id") REFERENCES "public"."trash"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_trash_idx" ON "nodes" USING btree ("trash_id") WHERE "nodes"."trash_id" is not null;