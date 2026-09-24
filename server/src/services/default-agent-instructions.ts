import fs from "node:fs/promises";
import { AGENT_ROLE_INSTRUCTION_FILES, agentRoleInstructionBundle, type AgentRole } from "@paperclipai/shared";

export type DefaultAgentBundleRole = AgentRole | "default";

function bundleFileNames(role: DefaultAgentBundleRole): readonly string[] {
  return role === "default" ? AGENT_ROLE_INSTRUCTION_FILES.general : AGENT_ROLE_INSTRUCTION_FILES[role];
}

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const entries = await Promise.all(
    bundleFileNames(role).map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return agentRoleInstructionBundle(role);
}
