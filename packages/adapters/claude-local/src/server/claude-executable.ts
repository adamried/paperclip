import { resolveHostExecutable } from "@paperclipai/adapter-utils/host-executable";

/** The host Claude Code CLI for `command` (default `claude`); see adapter-utils/host-executable. */
export function resolveHostClaudeExecutable(command = "claude", pathValue: string | undefined = process.env.PATH): string | null {
  return resolveHostExecutable(command, pathValue);
}
