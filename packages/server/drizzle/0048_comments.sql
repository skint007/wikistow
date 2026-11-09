CREATE TABLE "comment_envelopes" (
	"version_id" text NOT NULL,
	"recipient_identity_id" text NOT NULL,
	"recipient_key_version" integer NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "comment_envelopes_version_id_recipient_identity_id_recipient_key_version_pk" PRIMARY KEY("version_id","recipient_identity_id","recipient_key_version")
);
--> statement-breakpoint
CREATE TABLE "comment_seen" (
	"account_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_seen_account_id_page_id_pk" PRIMARY KEY("account_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "comment_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"comment_id" text NOT NULL,
	"space_id" text NOT NULL,
	"sealed" jsonb NOT NULL,
	"payload_size" integer GENERATED ALWAYS AS (length(sealed -> 'payload' ->> 'ciphertext')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_versions_commentId_unique" UNIQUE("comment_id"),
	CONSTRAINT "comment_versions_id_shape" CHECK ("comment_versions"."id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "comment_wraps" (
	"version_id" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"wrap" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"page_id" text NOT NULL,
	"thread_id" text,
	"audience" text NOT NULL,
	"author_identity_id" text NOT NULL,
	"author_account_id" uuid,
	"reader_history_from" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comments_id_shape" CHECK ("comments"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "comments_thread_state" CHECK ("comments"."thread_id" is null or ("comments"."resolved_at" is null and "comments"."deleted_at" is null)),
	CONSTRAINT "comments_resolved" CHECK (("comments"."resolved_at" is null) = ("comments"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "comment_envelopes" ADD CONSTRAINT "comment_envelopes_version_id_comment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."comment_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_envelopes" ADD CONSTRAINT "comment_envelopes_recipient_identity_id_recipient_key_version_identities_id_key_version_fk" FOREIGN KEY ("recipient_identity_id","recipient_key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_seen" ADD CONSTRAINT "comment_seen_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_seen" ADD CONSTRAINT "comment_seen_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_versions" ADD CONSTRAINT "comment_versions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_wraps" ADD CONSTRAINT "comment_wraps_version_id_comment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."comment_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_wraps" ADD CONSTRAINT "comment_wraps_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thread_id_comments_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_account_id_users_id_fk" FOREIGN KEY ("author_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_seen_page_idx" ON "comment_seen" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "comment_versions_space_idx" ON "comment_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "comment_wraps_share_idx" ON "comment_wraps" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "comments_page_idx" ON "comments" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "comments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "comments_author_account_idx" ON "comments" USING btree ("author_account_id");--> statement-breakpoint
-- Once a change to a comment commits (added, edited, deleted, resolved or
-- opened again), name its page on the "wikistow_comments" channel, with the
-- audience and the reader history it was made in, so the server tells only
-- the people who can read it (see `listenForTreeChanges`). Never what
-- changed. Postgres sends each payload once per transaction.
CREATE FUNCTION "wikistow_comment_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed record;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  PERFORM pg_notify('wikistow_comments',
    changed."page_id" || ' ' || changed."audience" || ' ' || changed."reader_history_from");
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "comments_changed" AFTER INSERT OR UPDATE OR DELETE ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_comment_changed"();
