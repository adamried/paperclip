import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-person, per-company choice of who may decide approvals addressed to
 * them: any Board member (default), or only the addressee. A missing row
 * means the default.
 */
export const userApprovalDecisionPolicies = pgTable(
  "user_approval_decision_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    policy: text("policy").$type<"any_board" | "addressee_only">().notNull().default("any_board"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("user_approval_decision_policies_company_user_uq").on(
      table.companyId,
      table.userId,
    ),
    policyCheck: check(
      "user_approval_decision_policies_policy_check",
      sql`${table.policy} in ('any_board', 'addressee_only')`,
    ),
  }),
);
