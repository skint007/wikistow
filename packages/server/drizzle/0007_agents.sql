CREATE TABLE "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"lookup_code_hash" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"box_public_key" text NOT NULL,
	"sign_public_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"owner_account_id" uuid,
	"owner_identity_id" text,
	"owner_key_version" integer,
	"agent_id" text,
	"confirmed_at" timestamp with time zone,
	"credential_id" text,
	"sealed_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_enrollments_state" CHECK ("agent_enrollments"."state" in ('requested', 'claimed', 'cli-confirmed', 'approved', 'delivered', 'expired', 'cancelled', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"agent_id" text NOT NULL,
	"share_id" text NOT NULL,
	"space_id" text NOT NULL,
	"folder_id" text,
	"role" text NOT NULL,
	"can_publish" boolean DEFAULT false NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_grants_agent_id_share_id_pk" PRIMARY KEY("agent_id","share_id"),
	CONSTRAINT "agent_grants_role" CHECK ("agent_grants"."role" in ('reader', 'editor')),
	CONSTRAINT "agent_grants_readers_never_publish" CHECK ("agent_grants"."role" <> 'reader' or not "agent_grants"."can_publish")
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"owner_identity_id" text NOT NULL,
	"owner_key_version" integer NOT NULL,
	"name" text NOT NULL,
	"enrollment" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_agent" CHECK ("agent_profiles"."agent_id" like 'agent-%'),
	CONSTRAINT "agent_profiles_key_version" CHECK ("agent_profiles"."key_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"caller_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_caller_id_key_pk" PRIMARY KEY("caller_id","key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credentials_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agent_profiles_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_profiles"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_agent_id_agent_profiles_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_profiles"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_space_id_folder_id_nodes_space_id_id_fk" FOREIGN KEY ("space_id","folder_id") REFERENCES "public"."nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_key_version_identities_id_key_version_fk" FOREIGN KEY ("agent_id","key_version") REFERENCES "public"."identities"("id","key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_credentials_agent_idx" ON "agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_enrollments_open_code" ON "agent_enrollments" USING btree ("lookup_code_hash") WHERE "agent_enrollments"."state" = 'requested';--> statement-breakpoint
CREATE INDEX "agent_enrollments_owner_idx" ON "agent_enrollments" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "agent_enrollments_expires_idx" ON "agent_enrollments" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_grants_share_idx" ON "agent_grants" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "agent_profiles_account_idx" ON "agent_profiles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
-- Every agent credential an account holds dies (section 9.7): those made
-- before now no longer authenticate, its agents are revoked and lose their
-- grants, so nobody seals to them or reuses their names, and its open
-- enrollments end, an approved one's token with them. The enrollments go
-- first: that waits for an approval in progress, so the statements after
-- see the agent it made.
CREATE FUNCTION "wikistow_revoke_agents"(account uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "agent_enrollments" SET "state" = 'cancelled', "sealed_token" = NULL
    WHERE "owner_account_id" = account AND "state" IN ('claimed', 'cli-confirmed', 'approved');
  UPDATE "users" SET "credentials_revoked_at" = now() WHERE "id" = account;
  UPDATE "identities" SET "revoked_at" = now()
    WHERE "account_id" = account AND "kind" = 'agent' AND "revoked_at" IS NULL;
  DELETE FROM "agent_grants"
    WHERE "agent_id" IN (SELECT "agent_id" FROM "agent_profiles" WHERE "account_id" = account);
END $$;
--> statement-breakpoint
-- A password set or changed, by a reset or otherwise, revokes the account's
-- agents in the same transaction as the write (#7), so a reset can't store
-- the new password and leave the old tokens working.
CREATE FUNCTION "wikistow_password_revokes_agents"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider_id" <> 'credential' OR NEW."password" IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."password" IS NOT DISTINCT FROM OLD."password" THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM "wikistow_revoke_agents"(NEW."user_id");
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "accounts_password_revokes_agents" AFTER INSERT OR UPDATE OF "password" ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION "wikistow_password_revokes_agents"();
