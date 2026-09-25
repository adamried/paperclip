import fs from "node:fs/promises";
import { AGENT_ROLE_INSTRUCTION_FILES, AGENT_ROLE_LABELS, agentRoleInstructionBundle, type AgentRole } from "@paperclipai/shared";

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

const ROLE_FILE_DESCRIPTIONS: Record<string, string> = {
  "SOUL.md": "who you are and how you should act.",
  "HEARTBEAT.md": "execution and extraction checklist. Run every heartbeat.",
  "TOOLS.md": "tools you have access to.",
};

/**
 * A hirer that writes its own AGENTS.md still gets the role's companion files
 * (SOUL.md, HEARTBEAT.md, TOOLS.md) seeded beside it, with a pointer appended
 * to the entry file so the agent actually reads them: only the entry file is
 * placed in the prompt, siblings are read on instruction. Files the hirer
 * supplied always win; a `general` role or an entry that already names every
 * companion leaves the bundle untouched.
 */
export async function withRoleCompanionFiles(
  role: string,
  files: Record<string, string>,
  entryFile = "AGENTS.md",
): Promise<Record<string, string>> {
  const bundleRole = resolveDefaultAgentInstructionsBundleRole(role);
  if (bundleRole === "default") return files;
  const bundle = await loadDefaultAgentInstructionsBundle(bundleRole);
  const companions = Object.entries(bundle).filter(
    ([name]) => name !== entryFile && name !== "AGENTS.md" && !(name in files),
  );
  if (companions.length === 0) return files;
  const merged: Record<string, string> = { ...Object.fromEntries(companions), ...files };
  const entry = files[entryFile];
  if (typeof entry !== "string") return merged;
  const unmentioned = companions.map(([name]) => name).filter((name) => !entry.includes(name));
  if (unmentioned.length === 0) return merged;
  const label = AGENT_ROLE_LABELS[bundleRole as AgentRole] ?? bundleRole;
  const lines = unmentioned.map((name) => `- \`./${name}\` -- ${ROLE_FILE_DESCRIPTIONS[name] ?? "read it."}`);
  merged[entryFile] = `${entry.trimEnd()}\n\n## Role files\n\nThese files come with the ${label} role and are essential. Read them.\n\n${lines.join("\n")}\n`;
  return merged;
}
