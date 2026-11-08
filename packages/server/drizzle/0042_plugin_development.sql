CREATE TABLE "plugin_development_files" (
	"account_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"hash" text NOT NULL,
	"path" text NOT NULL,
	"data" "bytea" NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_development_files_account_id_plugin_id_path_pk" PRIMARY KEY("account_id","plugin_id","path")
);
--> statement-breakpoint
ALTER TABLE "plugin_development_files" ADD CONSTRAINT "plugin_development_files_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;