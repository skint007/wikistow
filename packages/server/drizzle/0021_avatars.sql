CREATE TABLE "avatars" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatars_id_unique" UNIQUE("id"),
	CONSTRAINT "avatars_content_type" CHECK ("avatars"."content_type" in ('image/jpeg', 'image/png', 'image/gif', 'image/svg+xml')),
	CONSTRAINT "avatars_size" CHECK (octet_length("avatars"."bytes") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Uncompressed, so serving an avatar a part at a time reads only that part.
ALTER TABLE "avatars" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
