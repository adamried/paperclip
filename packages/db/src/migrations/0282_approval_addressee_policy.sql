CREATE TABLE "user_approval_decision_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"policy" text DEFAULT 'any_board' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_approval_decision_policies_policy_check" CHECK ("user_approval_decision_policies"."policy" in ('any_board', 'addressee_only'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "addressee_user_id" text;--> statement-breakpoint
ALTER TABLE "user_approval_decision_policies" ADD CONSTRAINT "user_approval_decision_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_approval_decision_policies_company_user_uq" ON "user_approval_decision_policies" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "approvals_company_addressee_status_idx" ON "approvals" USING btree ("company_id","addressee_user_id","status");
