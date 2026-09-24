import { describe, expect, it } from "vitest";
import { AGENT_ROLES, AGENT_ROLE_INSTRUCTION_FILES, agentRoleInstructionBundle } from "@paperclipai/shared";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions bundles", () => {
  it("resolves every role to a bundle whose files exist and are non-empty", async () => {
    for (const role of AGENT_ROLES) {
      const bundleRole = resolveDefaultAgentInstructionsBundleRole(role);
      expect(bundleRole).toBe(role === "general" ? "default" : role);
      const files = await loadDefaultAgentInstructionsBundle(bundleRole);
      expect(Object.keys(files).sort()).toEqual([...AGENT_ROLE_INSTRUCTION_FILES[role]].sort());
      for (const [name, content] of Object.entries(files)) {
        expect(content.trim().length, `${role}/${name}`).toBeGreaterThan(name === "TOOLS.md" ? 20 : 200);
        expect(content, `${role}/${name}`).not.toMatch(/\{\{\w+\}\}/);
      }
    }
  });

  it("gives every role an entry AGENTS.md and a SOUL.md except general", () => {
    for (const role of AGENT_ROLES) {
      expect(AGENT_ROLE_INSTRUCTION_FILES[role]).toContain("AGENTS.md");
      if (role !== "general") expect(AGENT_ROLE_INSTRUCTION_FILES[role]).toContain("SOUL.md");
    }
  });

  it("falls back to the generic bundle for unknown roles", () => {
    expect(agentRoleInstructionBundle("wizard")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
  });
});
