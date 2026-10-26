import { AGENT_SENTINEL_USER_ID, type OrgTreeNode } from "@paperclipai/shared";
import { AGENT_SENTINEL_USER_NAME } from "../operator-identity.js";

/**
 * Wraps the agent forest the agent service produces into the org chart the
 * API serves: the Board at the root, its members (every `instance_admin` user
 * except the agent sentinel) first, then the other people who manage agents,
 * and every agent under its manager.
 *
 * Pure so it can be unit-tested and reused by the SVG/PNG export.
 */

export const ORG_CHART_BOARD_NODE_ID = "board";
export const ORG_CHART_BOARD_NAME = "The Board";
/** `role` of a user node that sits on the Board. */
export const ORG_CHART_BOARD_MEMBER_ROLE = "board";

export type OrgChartAgentNode = {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsToUserId?: string | null;
  reports: OrgChartAgentNode[];
};

export type OrgChartUserSummary = {
  name: string | null;
  email: string | null;
  image: string | null;
  membershipRole: string | null;
  active: boolean;
};

export function orgChartUserNodeId(userId: string) {
  return `user:${userId}`;
}

function toAgentTreeNode(node: OrgChartAgentNode): OrgTreeNode {
  return {
    kind: "agent",
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    reports: node.reports.map(toAgentTreeNode),
  };
}

function userDisplayName(userId: string, user: OrgChartUserSummary | undefined) {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  if (userId === AGENT_SENTINEL_USER_ID) return AGENT_SENTINEL_USER_NAME;
  return userId.slice(0, 8);
}

/**
 * @param roots the actor-visible agent forest (agents with no agent manager)
 * @param users profiles for the ids referenced by `reportsToUserId` and for
 *   every Board member
 * @param boardMemberIds the Board (instance admins minus the sentinel), listed
 *   as the root's first children whether or not they manage an agent
 */
export function buildOrgChartTree(
  roots: OrgChartAgentNode[],
  users: ReadonlyMap<string, OrgChartUserSummary>,
  boardMemberIds: readonly string[] = [],
): OrgTreeNode[] {
  if (roots.length === 0) return [];

  const byUser = new Map<string, OrgChartAgentNode[]>();
  const boardDirect: OrgChartAgentNode[] = [];
  for (const root of roots) {
    const userId = root.reportsToUserId ?? null;
    if (!userId) {
      boardDirect.push(root);
      continue;
    }
    const group = byUser.get(userId) ?? [];
    group.push(root);
    byUser.set(userId, group);
  }

  const memberIds = [...new Set(boardMemberIds)].filter((id) => id !== AGENT_SENTINEL_USER_ID);
  const memberNodes: OrgTreeNode[] = memberIds
    .map((userId) => {
      const user = users.get(userId);
      const group = byUser.get(userId) ?? [];
      byUser.delete(userId);
      return {
        kind: "user" as const,
        id: orgChartUserNodeId(userId),
        name: userDisplayName(userId, user),
        role: ORG_CHART_BOARD_MEMBER_ROLE,
        // Board membership is instance authority; it does not depend on a
        // company membership, so a member is never shown inactive here.
        status: "active",
        image: user?.image ?? null,
        reports: group.map(toAgentTreeNode),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const userNodes: OrgTreeNode[] = [...byUser.entries()]
    .map(([userId, group]) => {
      const user = users.get(userId);
      return {
        kind: "user" as const,
        id: orgChartUserNodeId(userId),
        name: userDisplayName(userId, user),
        role: user?.membershipRole ?? "member",
        status: user?.active === false ? "inactive" : "active",
        image: user?.image ?? null,
        reports: group.map(toAgentTreeNode),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return [
    {
      kind: "board",
      id: ORG_CHART_BOARD_NODE_ID,
      name: ORG_CHART_BOARD_NAME,
      role: "board",
      status: "active",
      reports: [...memberNodes, ...userNodes, ...boardDirect.map(toAgentTreeNode)],
    },
  ];
}

/** Ids referenced as human managers anywhere in the forest's roots. */
export function orgChartManagerUserIds(roots: OrgChartAgentNode[]): string[] {
  const ids = new Set<string>();
  for (const root of roots) {
    if (root.reportsToUserId) ids.add(root.reportsToUserId);
  }
  return [...ids];
}
