CREATE TABLE "live_envelopes" (
	"session_id" text NOT NULL,
	"recipient_identity_id" text NOT NULL,
	"recipient_key_version" integer NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "live_envelopes_session_id_recipient_identity_id_recipient_key_version_pk" PRIMARY KEY("session_id","recipient_identity_id","recipient_key_version")
);
--> statement-breakpoint
CREATE TABLE "live_grants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "live_grants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"subject" text NOT NULL,
	"identity_id" text NOT NULL,
	"join_id" text NOT NULL,
	"given_after" bigint NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position" bigint,
	"lapsed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "live_joins" (
	"session_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"join_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"account_id" uuid,
	"ordinal" integer NOT NULL,
	"parent_join_id" text,
	"catch_up" boolean DEFAULT false NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stream_open" boolean DEFAULT false NOT NULL,
	"stream_token" text,
	"stream_broke_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_joins_session_id_identity_id_join_id_pk" PRIMARY KEY("session_id","identity_id","join_id"),
	CONSTRAINT "live_joins_join_id_shape" CHECK ("live_joins"."join_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "live_messages" (
	"session_id" text NOT NULL,
	"position" bigint NOT NULL,
	"kind" text NOT NULL,
	"identity_id" text NOT NULL,
	"join_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"account_id" uuid,
	"message" jsonb NOT NULL,
	"size" integer NOT NULL,
	"covers" bigint,
	"revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_messages_session_id_position_pk" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "live_session_ids" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"space_id" text NOT NULL,
	"starter_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_session_ids_versionId_unique" UNIQUE("version_id")
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"page_id" text NOT NULL,
	"version_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"sealed" jsonb NOT NULL,
	"payload_size" integer GENERATED ALWAYS AS (length(sealed -> 'payload' ->> 'ciphertext')) STORED NOT NULL,
	"share_id" text,
	"key_version" integer,
	"starter_identity_id" text NOT NULL,
	"starter_account_id" uuid,
	"joins_made" integer DEFAULT 0 NOT NULL,
	"last_position" bigint DEFAULT 0 NOT NULL,
	"last_update_position" bigint DEFAULT 0 NOT NULL,
	"saved_covers" bigint,
	"snapshot_position" bigint,
	"snapshot_covers" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "live_sessions_versionId_unique" UNIQUE("version_id"),
	CONSTRAINT "live_sessions_id_shape" CHECK ("live_sessions"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "live_sessions_version_id_shape" CHECK ("live_sessions"."version_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "live_sessions_ended" CHECK (("live_sessions"."ended_at" is null) = ("live_sessions"."ended_reason" is null)),
	CONSTRAINT "live_sessions_region" CHECK (("live_sessions"."share_id" is null) = ("live_sessions"."key_version" is null))
);
--> statement-breakpoint
CREATE TABLE "live_usage" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_wraps" (
	"session_id" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"wrap" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_envelopes" ADD CONSTRAINT "live_envelopes_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_envelopes" ADD CONSTRAINT "live_envelopes_recipient_identity_id_recipient_key_version_identities_id_key_version_fk" FOREIGN KEY ("recipient_identity_id","recipient_key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_grants" ADD CONSTRAINT "live_grants_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_joins" ADD CONSTRAINT "live_joins_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_joins" ADD CONSTRAINT "live_joins_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_messages" ADD CONSTRAINT "live_messages_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_messages" ADD CONSTRAINT "live_messages_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_session_ids" ADD CONSTRAINT "live_session_ids_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_session_ids" ADD CONSTRAINT "live_session_ids_starter_account_id_users_id_fk" FOREIGN KEY ("starter_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_page_id_nodes_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_starter_account_id_users_id_fk" FOREIGN KEY ("starter_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_usage" ADD CONSTRAINT "live_usage_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_wraps" ADD CONSTRAINT "live_wraps_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_wraps" ADD CONSTRAINT "live_wraps_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_grants_session_idx" ON "live_grants" USING btree ("session_id","subject");--> statement-breakpoint
CREATE INDEX "live_joins_account_idx" ON "live_joins" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_messages_seq_idx" ON "live_messages" USING btree ("session_id","identity_id","join_id","seq");--> statement-breakpoint
CREATE INDEX "live_messages_account_idx" ON "live_messages" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "live_messages_revision_idx" ON "live_messages" USING btree ("revision_id") WHERE "live_messages"."revision_id" is not null;--> statement-breakpoint
CREATE INDEX "live_session_ids_space_idx" ON "live_session_ids" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "live_session_ids_starter_account_idx" ON "live_session_ids" USING btree ("starter_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_sessions_open_page_idx" ON "live_sessions" USING btree ("page_id") WHERE "live_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "live_sessions_page_idx" ON "live_sessions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "live_sessions_revision_idx" ON "live_sessions" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "live_sessions_starter_account_idx" ON "live_sessions" USING btree ("starter_account_id");--> statement-breakpoint
CREATE INDEX "live_wraps_share_idx" ON "live_wraps" USING btree ("share_id");--> statement-breakpoint
-- A page's open live session ends in the transaction that moves the page's
-- permission version (protocol section 5.10, **Ending**): a rotation, a
-- member or role change, a move, making or ending a share, an owner
-- change, unpublishing, and the trash all move it. Writers of messages
-- hold the page's row FOR SHARE, so they wait for this transaction and
-- then find the session ended, or this waits for them.
CREATE FUNCTION "wikistow_live_end"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "live_sessions" SET "ended_at" = now(), "ended_reason" = 'access'
    WHERE "page_id" = NEW."id" AND "ended_at" IS NULL;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "nodes_live_end" AFTER UPDATE OF "permission_version" ON "nodes"
  FOR EACH ROW WHEN (OLD."permission_version" IS DISTINCT FROM NEW."permission_version")
  EXECUTE FUNCTION "wikistow_live_end"();
--> statement-breakpoint
-- Once a session ends or goes, name it on the "wikistow_live" channel, so
-- the server ends its streams (see `listenForTreeChanges`); and once the
-- draft head of a page with a session moves, name the page, so its
-- streams carry the new head. Never anything else. Postgres sends each
-- payload once per transaction.
CREATE FUNCTION "wikistow_live_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('wikistow_live', 'gone ' || OLD."id");
  ELSIF NEW."ended_at" IS NOT NULL AND OLD."ended_at" IS NULL THEN
    PERFORM pg_notify('wikistow_live', 'ended ' || NEW."id");
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "live_sessions_changed" AFTER UPDATE OF "ended_at" OR DELETE ON "live_sessions"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_live_changed"();
--> statement-breakpoint
CREATE FUNCTION "wikistow_live_head"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "live_sessions" WHERE "page_id" = NEW."page_id") THEN
    PERFORM pg_notify('wikistow_live', 'head ' || NEW."page_id");
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "page_heads_live_head" AFTER UPDATE OF "draft_head" ON "page_heads"
  FOR EACH ROW WHEN (OLD."draft_head" IS DISTINCT FROM NEW."draft_head")
  EXECUTE FUNCTION "wikistow_live_head"();
--> statement-breakpoint
-- Each account's live storage (protocol section 5.10), kept as rows come and
-- go, so a quota check reads one row: a session's record and its used ID
-- count for its starter, a stored message and a join for their sender, each
-- with what its row takes besides (LIVE_ID_BYTES, LIVE_MESSAGE_BYTES and
-- LIVE_JOIN_BYTES in schema/live.ts). Rows whose account went count for nobody.
CREATE FUNCTION "wikistow_live_usage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account uuid;
  delta bigint;
BEGIN
  IF TG_TABLE_NAME = 'live_messages' THEN
    account := CASE WHEN TG_OP = 'DELETE' THEN OLD."account_id" ELSE NEW."account_id" END;
    delta := CASE WHEN TG_OP = 'DELETE' THEN OLD."size" ELSE NEW."size" END + 1024;
  ELSIF TG_TABLE_NAME = 'live_joins' THEN
    account := CASE WHEN TG_OP = 'DELETE' THEN OLD."account_id" ELSE NEW."account_id" END;
    delta := 512;
  ELSIF TG_TABLE_NAME = 'live_sessions' THEN
    account := CASE WHEN TG_OP = 'DELETE' THEN OLD."starter_account_id" ELSE NEW."starter_account_id" END;
    delta := CASE WHEN TG_OP = 'DELETE' THEN OLD."payload_size" ELSE NEW."payload_size" END;
  ELSE
    account := CASE WHEN TG_OP = 'DELETE' THEN OLD."starter_account_id" ELSE NEW."starter_account_id" END;
    delta := 256;
  END IF;
  IF account IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE "live_usage" SET "bytes" = "bytes" - delta WHERE "account_id" = account;
  ELSE
    INSERT INTO "live_usage" ("account_id", "bytes") VALUES (account, delta)
      ON CONFLICT ("account_id") DO UPDATE SET "bytes" = "live_usage"."bytes" + delta;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "live_messages_usage" AFTER INSERT OR DELETE ON "live_messages"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_live_usage"();
--> statement-breakpoint
CREATE TRIGGER "live_joins_usage" AFTER INSERT OR DELETE ON "live_joins"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_live_usage"();
--> statement-breakpoint
CREATE TRIGGER "live_sessions_usage" AFTER INSERT OR DELETE ON "live_sessions"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_live_usage"();
--> statement-breakpoint
CREATE TRIGGER "live_session_ids_usage" AFTER INSERT OR DELETE ON "live_session_ids"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_live_usage"();
