import { describe, expect, it } from "vitest";
import {
  agentChangeAuthorityFloor,
  agentChangeAuthorityFromKeys,
  compareAgentChangeAuthority,
  defaultChangeGrantKeysForAgent,
  deriveAgentChangeAuthority,
  grantWritesForAgentChangeAuthority,
  isRootCeoAgent,
} from "../services/agent-change-authority.js";
import { BUILT_IN_AGENT_METADATA_KEY } from "../services/built-in-agent-metadata.js";

const rootCeo = { role: "ceo", reportsTo: null, status: "active", metadata: {} };
const chiefOfStaff = { role: "chief_of_staff", reportsTo: "ceo-1", status: "active", metadata: {} };
const reflectionCoach = {
  role: "general",
  reportsTo: null,
  status: "active",
  metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "reflection-coach", featureKeys: ["reflection"] } },
};

describe("agent change authority", () => {
  it("recognizes the non-built-in root CEO", () => {
    expect(isRootCeoAgent(rootCeo)).toBe(true);
    expect(isRootCeoAgent({ ...rootCeo, role: " CEO " })).toBe(true);
    expect(isRootCeoAgent({ ...rootCeo, reportsTo: "board-agent" })).toBe(false);
    expect(isRootCeoAgent({ ...rootCeo, status: "pending_approval" })).toBe(false);
    expect(isRootCeoAgent(chiefOfStaff)).toBe(false);
    expect(isRootCeoAgent({ ...rootCeo, metadata: reflectionCoach.metadata })).toBe(false);
  });

  it("maps grant keys to a level, with direct winning over suggest", () => {
    expect(agentChangeAuthorityFromKeys([])).toBe("none");
    expect(agentChangeAuthorityFromKeys(["tasks:assign"])).toBe("none");
    expect(agentChangeAuthorityFromKeys(["agents:suggest-changes"])).toBe("suggest");
    expect(agentChangeAuthorityFromKeys(["agents:suggest-changes", "agents:configure"])).toBe("direct");
  });

  it("derives the floor from the default grants each agent kind re-ensures", () => {
    expect(defaultChangeGrantKeysForAgent(rootCeo)).toEqual(["agents:configure", "skills:create"]);
    expect(agentChangeAuthorityFloor(rootCeo)).toBe("direct");
    expect(defaultChangeGrantKeysForAgent(reflectionCoach)).toEqual(["agents:suggest-changes", "skills:suggest-changes"]);
    expect(agentChangeAuthorityFloor(reflectionCoach)).toBe("suggest");
    expect(defaultChangeGrantKeysForAgent(chiefOfStaff)).toEqual([]);
    expect(agentChangeAuthorityFloor(chiefOfStaff)).toBe("none");
  });

  it("orders levels none < suggest < direct", () => {
    expect(compareAgentChangeAuthority("none", "suggest")).toBeLessThan(0);
    expect(compareAgentChangeAuthority("suggest", "direct")).toBeLessThan(0);
    expect(compareAgentChangeAuthority("direct", "direct")).toBe(0);
    expect(compareAgentChangeAuthority("direct", "none")).toBeGreaterThan(0);
  });

  it("reports the source of an existing level", () => {
    expect(deriveAgentChangeAuthority(chiefOfStaff, [])).toEqual({
      agentChangeAuthority: "none",
      agentChangeAuthoritySource: "none",
    });
    expect(deriveAgentChangeAuthority(chiefOfStaff, [{ permissionKey: "agents:configure" }])).toEqual({
      agentChangeAuthority: "direct",
      agentChangeAuthoritySource: "explicit_grant",
    });
    expect(deriveAgentChangeAuthority(chiefOfStaff, [{ permissionKey: "agents:suggest-changes" }])).toEqual({
      agentChangeAuthority: "suggest",
      agentChangeAuthoritySource: "explicit_grant",
    });
    expect(deriveAgentChangeAuthority(rootCeo, [{ permissionKey: "agents:configure" }])).toEqual({
      agentChangeAuthority: "direct",
      agentChangeAuthoritySource: "root_ceo_default",
    });
    expect(deriveAgentChangeAuthority(reflectionCoach, [{ permissionKey: "agents:suggest-changes" }])).toEqual({
      agentChangeAuthority: "suggest",
      agentChangeAuthoritySource: "built_in_default",
    });
  });

  it("never reports a default source when the grant is absent", () => {
    expect(deriveAgentChangeAuthority(rootCeo, [{ permissionKey: "tasks:assign" }])).toEqual({
      agentChangeAuthority: "none",
      agentChangeAuthoritySource: "none",
    });
  });

  it("writes exactly one change grant per requested level", () => {
    expect(grantWritesForAgentChangeAuthority("none")).toEqual([
      { permissionKey: "agents:configure", enabled: false },
      { permissionKey: "agents:suggest-changes", enabled: false },
    ]);
    expect(grantWritesForAgentChangeAuthority("suggest")).toEqual([
      { permissionKey: "agents:configure", enabled: false },
      { permissionKey: "agents:suggest-changes", enabled: true },
    ]);
    expect(grantWritesForAgentChangeAuthority("direct")).toEqual([
      { permissionKey: "agents:configure", enabled: true },
      { permissionKey: "agents:suggest-changes", enabled: false },
    ]);
  });
});
