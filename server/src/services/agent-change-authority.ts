import type {
  AgentChangeAuthority,
  AgentChangeAuthoritySource,
  PermissionKey,
} from "@paperclipai/shared";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

/**
 * Board-managed authority an agent holds over other agents' configuration.
 *
 * The authorization service resolves `agent_config:update` for agent actors
 * through two principal grants: `agents:configure` applies a change directly,
 * `agents:suggest-changes` proposes it and the Board must accept a change
 * consent before it lands. This module is the single place that maps those
 * grant rows to the `AgentChangeAuthority` level the API and UI expose, and
 * that knows which agents receive a default level the reconcile loop keeps
 * re-ensuring (so a Board "revoke" below that floor would silently revert).
 *
 * It deliberately depends only on shared types and the built-in marker helper
 * so route tests can import it without pulling in the built-in agent service.
 */

/** Grants the single non-built-in root CEO agent receives automatically. */
export const ROOT_AGENT_DEFAULT_CHANGE_GRANTS: PermissionKey[] = ["agents:configure", "skills:create"];

/** Grants a bundled built-in agent receives automatically, keyed by definition key. */
export const BUILT_IN_AGENT_DEFAULT_GRANTS: Record<string, PermissionKey[]> = {
  "reflection-coach": ["agents:suggest-changes", "skills:suggest-changes"],
};

const LEVEL_RANK: Record<AgentChangeAuthority, number> = {
  none: 0,
  suggest: 1,
  direct: 2,
};

export type AgentChangeAuthorityAgentLike = {
  role: string;
  reportsTo: string | null | undefined;
  status: string;
  metadata?: unknown;
};

export type AgentChangeAuthorityState = {
  agentChangeAuthority: AgentChangeAuthority;
  agentChangeAuthoritySource: AgentChangeAuthoritySource;
};

/**
 * Same predicate `ensureRootAgentDefaultChangeGrants` uses to pick the agent
 * that receives the root defaults, minus the "exactly one match" check. The
 * caller only reports the root source when the grant actually exists, so a
 * company with two CEO roots degrades to `explicit_grant`, never to a wrong
 * lock.
 */
export function isRootCeoAgent(agent: AgentChangeAuthorityAgentLike): boolean {
  return (
    !readBuiltInAgentMarker(agent.metadata) &&
    !agent.reportsTo &&
    agent.role.trim().toLowerCase() === "ceo" &&
    agent.status !== "pending_approval"
  );
}

/** Change-grant keys the reconcile loop re-ensures for this agent, if any. */
export function defaultChangeGrantKeysForAgent(agent: AgentChangeAuthorityAgentLike): PermissionKey[] {
  if (isRootCeoAgent(agent)) return ROOT_AGENT_DEFAULT_CHANGE_GRANTS;
  const marker = readBuiltInAgentMarker(agent.metadata);
  if (marker) return BUILT_IN_AGENT_DEFAULT_GRANTS[marker.key] ?? [];
  return [];
}

/** Accepts raw grant rows too, whose `permissionKey` is typed as a plain string. */
export function agentChangeAuthorityFromKeys(keys: Iterable<string>): AgentChangeAuthority {
  let level: AgentChangeAuthority = "none";
  for (const key of keys) {
    if (key === "agents:configure") return "direct";
    if (key === "agents:suggest-changes") level = "suggest";
  }
  return level;
}

export function compareAgentChangeAuthority(left: AgentChangeAuthority, right: AgentChangeAuthority): number {
  return LEVEL_RANK[left] - LEVEL_RANK[right];
}

/** The lowest level the Board may set without the reconcile loop restoring it. */
export function agentChangeAuthorityFloor(agent: AgentChangeAuthorityAgentLike): AgentChangeAuthority {
  return agentChangeAuthorityFromKeys(defaultChangeGrantKeysForAgent(agent));
}

export function deriveAgentChangeAuthority(
  agent: AgentChangeAuthorityAgentLike,
  grants: ReadonlyArray<{ permissionKey: string }>,
): AgentChangeAuthorityState {
  const level = agentChangeAuthorityFromKeys(grants.map((grant) => grant.permissionKey));
  if (level === "none") {
    return { agentChangeAuthority: "none", agentChangeAuthoritySource: "none" };
  }
  if (isRootCeoAgent(agent)) {
    return { agentChangeAuthority: level, agentChangeAuthoritySource: "root_ceo_default" };
  }
  const marker = readBuiltInAgentMarker(agent.metadata);
  if (marker && (BUILT_IN_AGENT_DEFAULT_GRANTS[marker.key] ?? []).length > 0) {
    return { agentChangeAuthority: level, agentChangeAuthoritySource: "built_in_default" };
  }
  return { agentChangeAuthority: level, agentChangeAuthoritySource: "explicit_grant" };
}

/** Grant rows to write for a requested level: exactly one key per non-none level. */
export function grantWritesForAgentChangeAuthority(
  level: AgentChangeAuthority,
): Array<{ permissionKey: PermissionKey; enabled: boolean }> {
  return [
    { permissionKey: "agents:configure", enabled: level === "direct" },
    { permissionKey: "agents:suggest-changes", enabled: level === "suggest" },
  ];
}
