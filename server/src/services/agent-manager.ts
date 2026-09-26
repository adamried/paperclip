import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companyMemberships } from "@paperclipai/db";
import type { ChainOfCommandRoot } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import type { OrgChartUserSummary } from "./org-chart-tree.js";

/**
 * Human managers for agents.
 *
 * An agent reports to exactly one of: another agent (`agents.reports_to`), a
 * person (`agents.reports_to_user_id`), or the Board (both null). This module
 * owns the eligibility rule for the person and the "is the manager still
 * active" check that every routing and identity consumer shares, so a
 * suspended or downgraded member falls through to the Board / company default
 * everywhere at once without the stored link being lost.
 *
 * Kept light on imports so route tests can load it without the agent service.
 */

export type HumanManagerMembership = {
  status: string;
  membershipRole: string | null;
};

/** Roles a person must hold to manage agents. Viewers are read-only. */
export function isHumanManagerRole(membershipRole: string | null | undefined): boolean {
  return normalizeHumanRole(membershipRole, "viewer") !== "viewer";
}

export function humanManagerMembershipIsActive(
  membership: HumanManagerMembership | null | undefined,
): boolean {
  return Boolean(membership && membership.status === "active" && isHumanManagerRole(membership.membershipRole));
}

export async function findHumanManagerMembership(
  db: Db,
  companyId: string,
  userId: string,
): Promise<HumanManagerMembership | null> {
  const rows = await db
    .select({
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function assertHumanManagerEligible(db: Db, companyId: string, userId: string) {
  const membership = await findHumanManagerMembership(db, companyId, userId);
  if (!humanManagerMembershipIsActive(membership)) {
    throw unprocessable("Manager must be an active owner, admin, or operator of this company", {
      code: "agent_manager_not_eligible",
      userId,
    });
  }
  return membership!;
}

/**
 * The agent's human manager, or null when the agent has none or the person is
 * no longer an active non-viewer member. This is the single check escalation
 * and responsible-user resolution use.
 */
export async function resolveActiveAgentManagerUserId(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const rows = await db
    .select({ reportsToUserId: agents.reportsToUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  const userId = rows[0]?.reportsToUserId ?? null;
  if (!userId) return null;
  const membership = await findHumanManagerMembership(db, companyId, userId);
  return humanManagerMembershipIsActive(membership) ? userId : null;
}

/**
 * Profiles for the people referenced as managers in an org chart, including
 * members who are no longer active so the chart can flag them rather than
 * drop the agents they manage.
 */
export async function loadOrgChartUserSummaries(
  db: Db,
  companyId: string,
  userIds: string[],
): Promise<Map<string, OrgChartUserSummary>> {
  const result = new Map<string, OrgChartUserSummary>();
  if (userIds.length === 0) return result;
  const [memberships, users] = await Promise.all([
    db
      .select({
        principalId: companyMemberships.principalId,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          inArray(companyMemberships.principalId, userIds),
        ),
      ),
    db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, image: authUsers.image })
      .from(authUsers)
      .where(inArray(authUsers.id, userIds)),
  ]);
  const membershipById = new Map(memberships.map((row) => [row.principalId, row]));
  const userById = new Map(users.map((row) => [row.id, row]));
  for (const userId of userIds) {
    const membership = membershipById.get(userId) ?? null;
    const user = userById.get(userId) ?? null;
    result.set(userId, {
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
      membershipRole: membership?.membershipRole ?? null,
      active: humanManagerMembershipIsActive(membership),
    });
  }
  return result;
}

export async function loadChainOfCommandRoot(
  db: Db,
  companyId: string,
  reportsToUserId: string | null | undefined,
): Promise<ChainOfCommandRoot> {
  if (!reportsToUserId) return { kind: "board" };
  const [membership, userRows] = await Promise.all([
    findHumanManagerMembership(db, companyId, reportsToUserId),
    db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, image: authUsers.image })
      .from(authUsers)
      .where(eq(authUsers.id, reportsToUserId))
      .limit(1),
  ]);
  const user = userRows[0] ?? null;
  return {
    kind: "user",
    id: reportsToUserId,
    name: user?.name ?? null,
    email: user?.email ?? null,
    image: user?.image ?? null,
    active: humanManagerMembershipIsActive(membership),
  };
}
