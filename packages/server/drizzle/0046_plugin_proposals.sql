CREATE TABLE "plugin_proposal_files" (
	"proposal_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text" text,
	"data" "bytea",
	"size" integer NOT NULL,
	CONSTRAINT "plugin_proposal_files_proposal_id_path_pk" PRIMARY KEY("proposal_id","path"),
	CONSTRAINT "plugin_proposal_files_text_or_data" CHECK (("plugin_proposal_files"."text" is null) <> ("plugin_proposal_files"."data" is null))
);
--> statement-breakpoint
CREATE TABLE "plugin_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"from_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_proposal_files" ADD CONSTRAINT "plugin_proposal_files_proposal_id_plugin_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."plugin_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_proposals" ADD CONSTRAINT "plugin_proposals_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_proposals" ADD CONSTRAINT "plugin_proposals_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_proposals_sender_plugin_idx" ON "plugin_proposals" USING btree ("sender_id","plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_proposals_plugin_idx" ON "plugin_proposals" USING btree ("plugin_id");