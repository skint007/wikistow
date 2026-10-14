CREATE TABLE "password_budgets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "password_budgets_refilled_at_idx" ON "password_budgets" USING btree ("refilled_at");