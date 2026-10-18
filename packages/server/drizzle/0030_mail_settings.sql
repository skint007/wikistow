ALTER TABLE "settings" ADD COLUMN "smtp_host" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "smtp_port" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "smtp_security" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "smtp_username" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "smtp_password" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "smtp_from" text;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_smtp_security" CHECK ("settings"."smtp_security" in ('none', 'starttls', 'tls'));