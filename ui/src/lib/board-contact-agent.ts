import type { Agent } from "@paperclipai/shared";

const BUILT_IN_AGENT_METADATA_KEY = "paperclipBuiltInAgent";

type BoardContactCandidate = Pick<Agent, "id" | "role" | "status" | "reportsTo" | "metadata"> &
  Partial<Pick<Agent, "reportsToUserId">>;

function isBuiltIn(agent: BoardContactCandidate): boolean {
  const metadata = agent.metadata;
  return Boolean(
    metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata[BUILT_IN_AGENT_METADATA_KEY],
  );
}

function isLive(agent: BoardContactCandidate): boolean {
  return agent.status !== "terminated" && agent.status !== "pending_approval";
}

/**
 * The agent that fronts the company for the Board: the CEO when there is
 * one; otherwise the single non-built-in root agent that reports to the Board;
 * otherwise a root agent the current person manages. A company with no CEO
 * (root agents managed by people) still gets a contact this way.
 */
export function boardContactAgent<T extends BoardContactCandidate>(
  agents: T[] | null | undefined,
  currentUserId: string | null,
): T | null {
  const live = (agents ?? []).filter(isLive);
  const ceo = live.find((agent) => agent.role === "ceo");
  if (ceo) return ceo;

  const roots = live.filter((agent) => !agent.reportsTo && !isBuiltIn(agent));
  const boardRoots = roots.filter((agent) => !agent.reportsToUserId);
  if (boardRoots.length === 1) return boardRoots[0]!;

  if (currentUserId) {
    const mine = roots.find((agent) => agent.reportsToUserId === currentUserId);
    if (mine) return mine;
  }
  // A company with one root agent, whoever manages it, still has one obvious
  // contact (the "I run it" onboarding shape).
  if (roots.length === 1) return roots[0]!;
  return null;
}
