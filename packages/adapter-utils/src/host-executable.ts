import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Adapters that go through an ACP server (Claude, Codex) launch the provider
// CLI bundled with that server unless an environment variable names another
// binary. The Test probes and the operator's terminal use the host's installed
// CLI, so runs should too. This resolves the host CLI for a command.

const FALLBACK_DIRS = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the host CLI for `command`, or null when none is found.
 * A command containing a path separator is checked as given; otherwise PATH
 * and the usual per-user bin directories are searched.
 */
export function resolveHostExecutable(
  command: string,
  pathValue: string | undefined = process.env.PATH,
): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.includes(path.sep) || trimmed.includes("/")) {
    const absolute = path.resolve(trimmed);
    return isExecutableFile(absolute) ? absolute : null;
  }
  const dirs = [...(pathValue ?? "").split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, trimmed);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
