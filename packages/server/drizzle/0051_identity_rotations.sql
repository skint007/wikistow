CREATE TABLE "identity_rotations" (
	"identity_id" text NOT NULL,
	"from_key_version" integer NOT NULL,
	"statement" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_rotations_identity_id_from_key_version_pk" PRIMARY KEY("identity_id","from_key_version")
);
--> statement-breakpoint
ALTER TABLE "identity_rotations" ADD CONSTRAINT "identity_rotations_identity_id_from_key_version_identities_id_key_version_fk" FOREIGN KEY ("identity_id","from_key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A stored statement is never changed (protocol section 4.6).
CREATE TRIGGER "identity_rotations_immutable" BEFORE UPDATE ON "identity_rotations"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_forbid_update"();
