import { and, eq } from "drizzle-orm";
import { authUsers, userApprovalDecisionPolicies, type Db } from "@paperclipai/db";
import type { ApprovalDecisionPolicy, UpdateApprovalDecisionPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { findHumanManagerMembership, humanManagerMembershipIsActive } from "./agent-manager.js";

/**
 * The single gate every approval decision path (web routes, the pending-agent
 * approve/terminate shortcuts, plugin decide) must pass. Under `addressee_only`
 * nobody but the addressee may decide, instance admins included: it is the
 * addressee's consent boundary. An addressee who is no longer an active
 * non-viewer member no longer binds anyone, so their approvals cannot be
 * orphaned.
 */
export async function assertApprovalDecisionAllowed(
  db: Db,
  approval: { companyId: string; addresseeUserId: string | null },
  actorUserId: string | null,
) {
  if (!approval.addresseeUserId) return;
  if (actorUserId === approval.addresseeUserId) return;
  const membership = await findHumanManagerMembership(db, approval.companyId, approval.addresseeUserId);
  if (!humanManagerMembershipIsActive(membership)) return;
  const policy = await approvalDecisionPolicyService(db).get(approval.companyId, approval.addresseeUserId);
  if (policy.policy !== "addressee_only") return;
  const addressee = await db
    .select({ name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, approval.addresseeUserId))
    .then((rows) => rows[0] ?? null);
  const addresseeName =
    addressee?.name?.trim()
    || addressee?.email?.trim()
    || (approval.addresseeUserId === "local-board" ? "the Board owner" : approval.addresseeUserId.slice(0, 8));
  throw forbidden(
    `Only ${addresseeName} can decide this approval. Ask them to decide it, or to allow any Board member in their profile settings.`,
    {
      code: "approval_addressee_only",
      addresseeUserId: approval.addresseeUserId,
      addresseeName,
    },
  );
}

/** True when the addressee still binds routing: present, active, and not a viewer. */
export async function approvalAddresseeIsActive(
  db: Db,
  companyId: string,
  addresseeUserId: string | null,
): Promise<boolean> {
  if (!addresseeUserId) return false;
  return humanManagerMembershipIsActive(await findHumanManagerMembership(db, companyId, addresseeUserId));
}

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
