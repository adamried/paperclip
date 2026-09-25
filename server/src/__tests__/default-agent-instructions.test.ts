import { describe, expect, it } from "vitest";
import { AGENT_ROLES, AGENT_ROLE_INSTRUCTION_FILES, agentRoleInstructionBundle } from "@paperclipai/shared";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
  withRoleCompanionFiles,
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

  it("seeds a role's companion files beside a hirer-written AGENTS.md and points at them", async () => {
    const written = "You are Ada, a backend engineer at Acme.\n\nShip code that passes review.\n";
    const files = await withRoleCompanionFiles("engineer", { "AGENTS.md": written });
    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "SOUL.md"]);
    expect(files["AGENTS.md"]!.startsWith(written.trimEnd())).toBe(true);
    expect(files["AGENTS.md"]).toContain("## Role files");
    expect(files["AGENTS.md"]).toContain("`./SOUL.md`");
    expect(files["SOUL.md"]).toContain("Software Engineer Persona");
    // The role's own AGENTS.md never overrides the hirer's.
    expect(files["AGENTS.md"]).not.toContain("You are a Software Engineer.");
  });

  it("keeps hirer-supplied companions, skips the pointer when already named, and leaves general hires alone", async () => {
    const own = { "AGENTS.md": "Read ./SOUL.md and ./HEARTBEAT.md first.", "SOUL.md": "Custom soul" };
    const cos = await withRoleCompanionFiles("chief_of_staff", own);
    expect(cos["SOUL.md"]).toBe("Custom soul");
    expect(cos["HEARTBEAT.md"]).toContain("Chief of Staff Checklist");
    expect(cos["AGENTS.md"]).toBe(own["AGENTS.md"]);
    const general = await withRoleCompanionFiles("general", { "AGENTS.md": "Just do the work." });
    expect(general).toEqual({ "AGENTS.md": "Just do the work." });
  });

  it("falls back to the generic bundle for unknown roles", () => {
    expect(agentRoleInstructionBundle("wizard")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
  });
});
