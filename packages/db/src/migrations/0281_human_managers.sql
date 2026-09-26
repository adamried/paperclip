ALTER TABLE "agents" ADD COLUMN "reports_to_user_id" text;--> statement-breakpoint
CREATE INDEX "agents_company_reports_to_user_idx" ON "agents" USING btree ("company_id","reports_to_user_id");
