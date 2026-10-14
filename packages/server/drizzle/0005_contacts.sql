CREATE TABLE "contacts_records" (
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sealed" jsonb NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_records_account_id_version_pk" PRIMARY KEY("account_id","version"),
	CONSTRAINT "contacts_records_version" CHECK ("contacts_records"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "metadata_revisions" ADD COLUMN "payload_size" integer GENERATED ALWAYS AS (length(sealed -> 'payload' ->> 'ciphertext')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts_records" ADD CONSTRAINT "contacts_records_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metadata_revisions_author_idx" ON "metadata_revisions" USING btree ("author_identity_id","author_key_version");--> statement-breakpoint
-- Every contacts version stays as its owner signed it, and goes only with
-- its account. A superseded one may only drop its payloads, keeping the
-- signed record a device checks the chain with (protocol section 8.5).
CREATE FUNCTION "wikistow_contacts_prune"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."account_id" <> OLD."account_id" OR NEW."version" <> OLD."version"
    OR NEW."created_at" <> OLD."created_at"
    OR NEW."sealed" <> jsonb_build_object(
      'record', OLD."sealed" -> 'record', 'signature', OLD."sealed" -> 'signature')
    OR NEW."size" <> length(NEW."sealed"::text) THEN
    RAISE EXCEPTION 'contacts version % of % is immutable', OLD."version", OLD."account_id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "contacts_records_immutable" BEFORE UPDATE ON "contacts_records"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_contacts_prune"();
--> statement-breakpoint
-- A delete cascading from an account runs inside the foreign key's own
-- trigger; any other is refused.
CREATE FUNCTION "wikistow_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% rows are removed only with what owns them', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "contacts_records_kept" BEFORE DELETE ON "contacts_records"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_delete"();
