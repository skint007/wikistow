CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_identity_id_pk" PRIMARY KEY("group_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"metadata_head" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_id_shape" CHECK ("groups"."id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "share_groups" (
	"share_id" text NOT NULL,
	"group_id" text NOT NULL,
	"role" text NOT NULL,
	"can_publish" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_groups_share_id_group_id_pk" PRIMARY KEY("share_id","group_id"),
	CONSTRAINT "share_groups_role" CHECK ("share_groups"."role" in ('reader', 'editor')),
	CONSTRAINT "share_groups_readers_never_publish" CHECK ("share_groups"."role" <> 'reader' or not "share_groups"."can_publish")
);
--> statement-breakpoint
ALTER TABLE "share_members" ADD COLUMN "direct_role" text;--> statement-breakpoint
ALTER TABLE "share_members" ADD COLUMN "direct_can_publish" boolean;--> statement-breakpoint
-- Before groups every member was there directly: their role is their direct
-- grant, and with no groups yet it is also their effective role.
UPDATE "share_members" SET "direct_role" = "role", "direct_can_publish" = "can_publish";
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_groups" ADD CONSTRAINT "share_groups_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_groups" ADD CONSTRAINT "share_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_groups" ADD CONSTRAINT "share_groups_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_identity_idx" ON "group_members" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "groups_space_idx" ON "groups" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "share_groups_group_idx" ON "share_groups" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "share_members" ADD CONSTRAINT "share_members_direct" CHECK (("share_members"."direct_role" is null) = ("share_members"."direct_can_publish" is null)
        and ("share_members"."direct_role" is null or "share_members"."direct_role" in ('reader', 'editor'))
        and ("share_members"."direct_role" is distinct from 'reader' or not "share_members"."direct_can_publish"));