import type { OrgTreeNode } from "@paperclipai/shared";

/**
 * Wraps the agent forest the agent service produces into the org chart the
 * API serves: the Board at the root, people who manage agents directly under
 * it, and every agent under its manager.
 *
 * Pure so it can be unit-tested and reused by the SVG/PNG export.
 */

export const ORG_CHART_BOARD_NODE_ID = "board";
export const ORG_CHART_BOARD_NAME = "The Board";

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
  if (userId === "local-board") return "Board";
  return userId.slice(0, 8);
}

/**
 * @param roots the actor-visible agent forest (agents with no agent manager)
 * @param users profiles for the ids referenced by `reportsToUserId`
 */
export function buildOrgChartTree(
  roots: OrgChartAgentNode[],
  users: ReadonlyMap<string, OrgChartUserSummary>,
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
      reports: [...userNodes, ...boardDirect.map(toAgentTreeNode)],
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
