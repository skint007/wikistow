ALTER TABLE "settings" ADD COLUMN "ai_style" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_base_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_api_key" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_max_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_requests_per_minute" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_ai_style" CHECK ("settings"."ai_style" in ('openai', 'anthropic'));