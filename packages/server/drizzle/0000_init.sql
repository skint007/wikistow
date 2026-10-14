CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"installation_id" text NOT NULL,
	"public_registration" boolean DEFAULT false NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
-- The installation ID is bound into every signature and ciphertext, so it is
-- created exactly once, here, and never changes.
INSERT INTO "settings" ("id", "installation_id") VALUES (1, gen_random_uuid()::text);
