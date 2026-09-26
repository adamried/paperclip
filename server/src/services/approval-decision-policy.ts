import { and, eq } from "drizzle-orm";
import { userApprovalDecisionPolicies, type Db } from "@paperclipai/db";
import type { ApprovalDecisionPolicy, UpdateApprovalDecisionPolicy } from "@paperclipai/shared";

/**
 * Who may decide approvals addressed to a person. Mirrors the inbox agent
 * policy service: a missing row is the default (`any_board`) and reads as
 * `materialized: false`.
 */
export function approvalDecisionPolicyService(db: Db) {
  async function get(companyId: string, userId: string): Promise<ApprovalDecisionPolicy> {
    const row = await db
      .select()
      .from(userApprovalDecisionPolicies)
      .where(and(
        eq(userApprovalDecisionPolicies.companyId, companyId),
        eq(userApprovalDecisionPolicies.userId, userId),
      ))
      .then((rows) => rows[0] ?? null);
    return row
      ? { ...row, materialized: true }
      : {
          companyId,
          userId,
          policy: "any_board",
          materialized: false,
          createdAt: null,
          updatedAt: null,
        };
  }

  async function update(
    companyId: string,
    userId: string,
    input: UpdateApprovalDecisionPolicy,
  ): Promise<ApprovalDecisionPolicy> {
    const now = new Date();
    const [row] = await db
      .insert(userApprovalDecisionPolicies)
      .values({ companyId, userId, policy: input.policy, updatedAt: now })
      .onConflictDoUpdate({
        target: [userApprovalDecisionPolicies.companyId, userApprovalDecisionPolicies.userId],
        set: { policy: input.policy, updatedAt: now },
      })
      .returning();
    return { ...row!, materialized: true };
  }

  return { get, update };
}
