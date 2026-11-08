ALTER TABLE "public_targets" DROP CONSTRAINT "public_targets_target_page_id_public_links_page_id_fk";
--> statement-breakpoint
ALTER TABLE "public_targets" ADD CONSTRAINT "public_targets_target_page_id_public_links_page_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."public_links"("page_id") ON DELETE cascade ON UPDATE cascade;