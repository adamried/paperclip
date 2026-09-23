import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeInventory, RuntimeInventoryEntry } from "@paperclipai/shared";
import { resolveHostExecutable } from "@paperclipai/adapter-utils/host-executable";
import { hostToolchainPath } from "./host-toolchain-path.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;

// Which build each local adapter runs its provider CLI on. Claude and Codex go
// through an ACP server that bundles its own CLI; Paperclip points those at
// the host CLI when one is installed. The others launch the host CLI directly.
type Spec = {
  adapterType: string;
  label: string;
  command: string;
  overrideEnv: string | null;
  bundled?: { acpPackage: string; adapterPackage: string; innerPackage: string; nativeBinary?: (platform: string, arch: string) => string };
};

const SPECS: Spec[] = [
  {
    adapterType: "claude_local",
    label: "Claude Code",
    command: "claude",
    overrideEnv: "CLAUDE_CODE_EXECUTABLE",
    bundled: {
      adapterPackage: "@paperclipai/adapter-claude-local/server",
      acpPackage: "@agentclientprotocol/claude-agent-acp",
      innerPackage: "@anthropic-ai/claude-agent-sdk",
      nativeBinary: (platform, arch) => `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${platform === "win32" ? ".exe" : ""}`,
    },
  },
  {
    adapterType: "codex_local",
    label: "Codex",
    command: "codex",
    overrideEnv: "CODEX_PATH",
    bundled: {
      adapterPackage: "@paperclipai/adapter-codex-local/server",
      acpPackage: "@agentclientprotocol/codex-acp",
      innerPackage: "@openai/codex",
    },
  },
  { adapterType: "opencode_local", label: "OpenCode", command: "opencode", overrideEnv: null },
  { adapterType: "gemini_local", label: "Gemini CLI", command: "gemini", overrideEnv: null },
  { adapterType: "kimi_local", label: "Kimi CLI", command: "kimi", overrideEnv: null },
  { adapterType: "grok_local", label: "Grok CLI", command: "grok", overrideEnv: null },
  { adapterType: "pi_local", label: "Pi", command: "pi", overrideEnv: null },
];

function firstVersionToken(output: string): string | null {
  const match = /\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?/.exec(output);
  return match ? match[0] : null;
}

async function cliVersion(executable: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: { ...process.env, PATH: hostToolchainPath() },
    });
    return firstVersionToken(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

/**
 * Locate `pkg` the way Node would from `fromPath`, without going through the
 * package's exports map (which often hides package.json). Walks node_modules
 * directories upward from `fromPath`.
 */
function findPackageDir(fromPath: string, pkg: string): string | null {
  let dir = path.dirname(fromPath);
  for (;;) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageVersion(fromPath: string, pkg: string): { version: string | null; dir: string | null } {
  const dir = findPackageDir(realpathOrSelf(fromPath), pkg);
  if (!dir) return { version: null, dir: null };
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string };
    return { version: manifest.version ?? null, dir: realpathOrSelf(dir) };
  } catch {
    return { version: null, dir };
  }
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

async function describeBundled(spec: NonNullable<Spec["bundled"]>): Promise<RuntimeInventoryEntry["bundled"]> {
  // Resolve from the adapter package so nested installs are found the way the ACP server finds them.
  let adapterEntry: string;
  try {
    adapterEntry = createRequire(import.meta.url).resolve(spec.adapterPackage);
  } catch {
    return { package: spec.innerPackage, version: null, cliVersion: null };
  }
  const acp = packageVersion(adapterEntry, spec.acpPackage);
  if (!acp.dir) return { package: spec.innerPackage, version: null, cliVersion: null };
  const inner = packageVersion(path.join(acp.dir, "package.json"), spec.innerPackage);
  let cli: string | null = inner.version;
  if (spec.nativeBinary && inner.dir) {
    const [nativePkg, ...rest] = spec.nativeBinary(process.platform, process.arch).split("/");
    const scoped = nativePkg.startsWith("@") ? `${nativePkg}/${rest.shift()}` : nativePkg;
    const nativeDir = findPackageDir(path.join(inner.dir, "package.json"), scoped);
    const binary = nativeDir ? path.join(nativeDir, ...rest) : null;
    if (binary && existsSync(binary)) cli = (await cliVersion(binary)) ?? cli;
  }
  return { package: spec.innerPackage, version: inner.version, cliVersion: cli };
}

export async function collectRuntimeInventory(): Promise<RuntimeInventory> {
  const runtimes = await Promise.all(
    SPECS.map(async (spec): Promise<RuntimeInventoryEntry> => {
      const override = spec.overrideEnv ? process.env[spec.overrideEnv]?.trim() : undefined;
      const hostPath = override || resolveHostExecutable(spec.command, hostToolchainPath());
      const host = hostPath ? { path: hostPath, version: await cliVersion(hostPath) } : null;
      const bundled = spec.bundled ? await describeBundled(spec.bundled) : null;
      return {
        adapterType: spec.adapterType,
        label: spec.label,
        command: spec.command,
        host,
        bundled,
        effective: host ? "host" : bundled?.version ? "bundled" : "missing",
        overrideEnv: spec.overrideEnv,
      };
    }),
  );
  return { runtimes, checkedAt: new Date().toISOString() };
}
