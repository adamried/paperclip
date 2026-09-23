import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The ACP server (claude-agent-acp) launches the Claude Code build bundled
// with its Agent SDK unless CLAUDE_CODE_EXECUTABLE names another binary. The
// Test probe runs the host's installed `claude`, so without this the two can
// be different versions: a model the installed CLI supports can fail in runs
// on the older bundled build. Resolve the host CLI here so both use one build.

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
 * Absolute path of the host Claude Code CLI for `command` (default `claude`),
 * or null when none is found. A command containing a path separator is
 * checked as given; otherwise PATH and the usual per-user bin directories are
 * searched.
 */
export function resolveHostClaudeExecutable(
  command = "claude",
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
