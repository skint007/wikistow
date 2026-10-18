ALTER TABLE "avatars" DROP CONSTRAINT "avatars_size";--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_size" CHECK (octet_length("avatars"."bytes") <= 2621440);