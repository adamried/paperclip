import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import type { LocalAiLoginAssisted } from "@paperclipai/shared";
import { hostToolchainPath } from "./host-toolchain-path.js";

// Assisted isolated sign-in for Anthropic on the local host. Instead of asking
// the user to run `CLAUDE_CONFIG_DIR=<home> claude auth login` in a terminal,
// the server runs that command itself against the attempt's own login home,
// reads the sign-in URL the CLI prints, and forwards the browser code the user
// pastes into the UI to the CLI's stdin. The CLI then stores the credential
// where it always does for a custom config dir (a credentials file, or on
// macOS the home's own Keychain item), so the existing check and complete
// paths pick it up unchanged.
//
// Secret handling: the CLI's output for `auth login` carries the sign-in URL
// and status text, never a token. The URL is shown to the user (it is their
// own sign-in link) and the pasted code is written only to the child's stdin.
// Neither is logged.

const URL_RE = /https:\/\/[^\s'"<>]+/;
const PASTE_PROMPT_RE = /paste code here/i;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 200;

type Entry = {
  child: ChildProcess;
  state: LocalAiLoginAssisted["state"];
  loginUrl: string | null;
  exitCode: number | null;
  error: string | null;
  output: string;
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Extract the sign-in URL from the CLI's login output, if it has appeared. */
export function parseClaudeLoginUrl(output: string): string | null {
  const match = URL_RE.exec(stripAnsi(output));
  return match ? match[0] : null;
}

export function createAssistedLoginManager(options: { command?: string } = {}) {
  const entries = new Map<string, Entry>();
  const command = options.command ?? "claude";

  function snapshot(id: string): LocalAiLoginAssisted | null {
    const entry = entries.get(id);
    if (!entry) return null;
    return { state: entry.state, loginUrl: entry.loginUrl, exitCode: entry.exitCode, error: entry.error };
  }

  /** Start the login for an attempt when it is not already running. */
  function ensure(id: string, loginHome: string): LocalAiLoginAssisted {
    const existing = entries.get(id);
    if (existing && existing.state !== "exited") return snapshot(id)!;
    const child = spawn(command, ["auth", "login"], {
      cwd: loginHome,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: hostToolchainPath(),
        HOME: os.homedir(),
        CLAUDE_CONFIG_DIR: loginHome,
        // Never let an inherited token or config dir leak into the attempt.
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        BROWSER: "/usr/bin/true",
      },
    });
    const entry: Entry = { child, state: "starting", loginUrl: null, exitCode: null, error: null, output: "" };
    entries.set(id, entry);
    const onData = (chunk: Buffer) => {
      entry.output = (entry.output + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES);
      if (!entry.loginUrl) entry.loginUrl = parseClaudeLoginUrl(entry.output);
      if (entry.state === "starting" && (entry.loginUrl || PASTE_PROMPT_RE.test(stripAnsi(entry.output)))) entry.state = "awaiting_code";
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      entry.state = "exited";
      entry.exitCode = entry.exitCode ?? 1;
      entry.error = error.message.slice(0, MAX_ERROR_CHARS);
    });
    child.on("exit", (code) => {
      entry.state = "exited";
      entry.exitCode = code ?? 1;
      if ((code ?? 1) !== 0 && !entry.error) {
        const lines = stripAnsi(entry.output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        // The paste prompt has no trailing newline, so the CLI's error lands on
        // the same line; drop that prefix.
        const last = (lines[lines.length - 1] ?? "").replace(/^paste code here if prompted\s*>\s*/i, "");
        entry.error = (last || `Sign-in exited with code ${code ?? 1}`).slice(0, MAX_ERROR_CHARS);
      }
      entry.output = "";
    });
    return snapshot(id)!;
  }

  /** Forward the browser code to the waiting CLI. */
  function submitCode(id: string, code: string): LocalAiLoginAssisted {
    const entry = entries.get(id);
    if (!entry || entry.state === "exited" || !entry.child.stdin || entry.child.stdin.destroyed) {
      throw new Error("The assisted sign-in is not running. Start sign-in again.");
    }
    entry.child.stdin.write(`${code.trim()}\n`);
    entry.state = "completing";
    return snapshot(id)!;
  }

  function stop(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (entry.state !== "exited") {
      try {
        entry.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  return { ensure, submitCode, stop, snapshot };
}

export type AssistedLoginManager = ReturnType<typeof createAssistedLoginManager>;
