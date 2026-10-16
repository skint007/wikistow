CREATE TABLE "plugin_draft_build_files" (
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "plugin_draft_build_files_draft_id_path_pk" PRIMARY KEY("draft_id","path")
);
--> statement-breakpoint
CREATE TABLE "plugin_draft_files" (
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text" text NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "plugin_draft_files_draft_id_path_pk" PRIMARY KEY("draft_id","path")
);
--> statement-breakpoint
CREATE TABLE "plugin_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"from_plugin_id" text,
	"from_hash" text,
	"build_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_draft_build_files" ADD CONSTRAINT "plugin_draft_build_files_draft_id_plugin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."plugin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_draft_files" ADD CONSTRAINT "plugin_draft_files_draft_id_plugin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."plugin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_drafts" ADD CONSTRAINT "plugin_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_drafts_owner_idx" ON "plugin_drafts" USING btree ("owner_id","updated_at");