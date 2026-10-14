ALTER TABLE "invitations" DROP CONSTRAINT "invitations_acceptedUserId_unique";
--> statement-breakpoint
-- Old confirmation links must not activate a password chosen by a stranger.
-- Email-bound links went only to their owner; open or generic creation did not.
-- No released installation holds such accounts, so nobody is mailed. An owner
-- would get the setup link from "Forgot password" or an administrator's resend.
UPDATE "accounts" SET "password" = NULL
  FROM "users"
  WHERE "accounts"."user_id" = "users"."id" AND "accounts"."provider_id" = 'credential'
    AND NOT "users"."email_verified"
    AND NOT EXISTS (
      SELECT 1 FROM "invitations"
      WHERE "accepted_user_id" = "users"."id" AND "email" IS NOT NULL
    );
