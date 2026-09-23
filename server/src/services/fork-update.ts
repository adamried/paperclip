import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  FORK_SYNC_WORKFLOW_FILE,
  type ForkApplyState,
  type ForkSyncRun,
  type ForkUpdateStatus,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serverVersion } from "../version.js";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { hostToolchainPath as toolchainPath } from "./host-toolchain-path.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 45_000;
const GITHUB_API = "https://api.github.com";
const TOKEN_CACHE_MS = 10 * 60 * 1000;
const APPLY_DIR = "fork-update";
const APPLY_META = "apply.json";
const APPLY_LOG = "apply.log";
const APPLY_EXIT = "apply.exit";
const LOG_TAIL_LINES = 60;
const STEP_MARKER = "::step::";

type ApplyMeta = { startedAt: string; pid: number; targetCommit: string | null };

/**
 * The checkout this server runs from: server/{src,dist}/services -> repo root.
 * Both the tsx source path and the compiled dist path sit three levels below
 * the root, so one resolution covers dev and prod. PAPERCLIP_FORK_REPO_ROOT
 * overrides it for unusual layouts.
 */
export function resolveForkRepoRoot(): string | null {
  const override = process.env.PAPERCLIP_FORK_REPO_ROOT?.trim();
  const candidate = override || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  if (!existsSync(path.join(candidate, ".git"))) return null;
  if (!existsSync(path.join(candidate, "pnpm-workspace.yaml"))) return null;
  return candidate;
}

/** owner/repo from an https or ssh GitHub remote URL; null for anything else. */
export function parseGitHubRemote(url: string): { owner: string; repo: string; url: string } | null {
  const trimmed = url.trim();
  const match =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (!match) return null;
  const [, owner, repo] = match;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Newest stable release tag among `vYYYY.MDD.N` tags; nightlies and odd shapes are ignored. */
export function pickLatestReleaseTag(tags: string[]): string | null {
  const parsed = tags
    .map((tag) => {
      const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
      return m ? { tag: tag.trim(), parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter((entry): entry is { tag: string; parts: number[] } => entry !== null)
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
      return 0;
    });
  return parsed[0]?.tag ?? null;
}

/** Derive the apply phase from what the detached script left on disk. */
export function deriveApplyState(input: {
  meta: ApplyMeta;
  exitCode: number | null;
  exitAt: string | null;
  pidAlive: boolean;
  log: string;
}): ForkApplyState {
  const lines = input.log.split(/\r?\n/);
  let step: string | null = null;
  const tail: string[] = [];
  for (const line of lines) {
    if (line.startsWith(STEP_MARKER)) {
      step = line.slice(STEP_MARKER.length).trim() || step;
      continue;
    }
    tail.push(line);
  }
  const phase: ForkApplyState["phase"] =
    input.exitCode !== null ? (input.exitCode === 0 ? "succeeded" : "failed") : input.pidAlive ? "running" : "failed";
  return {
    phase,
    step,
    startedAt: input.meta.startedAt,
    finishedAt: phase === "running" ? null : input.exitAt,
    exitCode: input.exitCode,
    targetCommit: input.meta.targetCommit,
    logTail: tail.slice(-LOG_TAIL_LINES).join("\n").trimEnd(),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function forkUpdateService(deps: { repoRoot?: string | null; fetchImpl?: typeof fetch } = {}) {
  const repoRoot = deps.repoRoot === undefined ? resolveForkRepoRoot() : deps.repoRoot;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let tokenCache: { value: string | null; at: number } | null = null;

  async function git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    if (!repoRoot) throw unprocessable("Not running from a git checkout");
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: toolchainPath(), GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  }

  async function gitOk(args: string[]): Promise<boolean> {
    try {
      await git(args);
      return true;
    } catch {
      return false;
    }
  }

  async function resolveToken(): Promise<string | null> {
    const fromEnv = process.env.PAPERCLIP_FORK_GITHUB_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.value;
    let value: string | null = null;
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], {
        timeout: 10_000,
        env: { ...process.env, PATH: toolchainPath() },
      });
      value = stdout.trim() || null;
    } catch {
      value = null;
    }
    tokenCache = { value, at: Date.now() };
    return value;
  }

  async function github<T>(token: string, method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${GITHUB_API}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // Never echo the token; the GitHub message itself is safe to surface.
      const text = await response.text().catch(() => "");
      let message = `GitHub API ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed?.message) message = `${message}: ${parsed.message}`;
      } catch {
        /* keep the generic message */
      }
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  function toRun(raw: {
    id: number;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
    updated_at: string;
  }): ForkSyncRun {
    return {
      id: raw.id,
      status: raw.status,
      conclusion: raw.conclusion,
      url: raw.html_url,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  async function latestRun(token: string, remote: { owner: string; repo: string }, branch: string) {
    const data = await github<{ workflow_runs: Parameters<typeof toRun>[0][] }>(
      token,
      "GET",
      `/repos/${remote.owner}/${remote.repo}/actions/workflows/${FORK_SYNC_WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
    );
    const first = data.workflow_runs?.[0];
    return first ? toRun(first) : null;
  }

  function applyDir(): string {
    return path.join(resolvePaperclipInstanceRoot({}), APPLY_DIR);
  }

  async function readApplyState(): Promise<ForkApplyState | null> {
    const dir = applyDir();
    let meta: ApplyMeta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, APPLY_META), "utf8")) as ApplyMeta;
    } catch {
      return null;
    }
    const log = await fs.readFile(path.join(dir, APPLY_LOG), "utf8").catch(() => "");
    let exitCode: number | null = null;
    let exitAt: string | null = null;
    try {
      const exitPath = path.join(dir, APPLY_EXIT);
      const raw = (await fs.readFile(exitPath, "utf8")).trim();
      const parsed = Number.parseInt(raw, 10);
      exitCode = Number.isFinite(parsed) ? parsed : 1;
      exitAt = (await fs.stat(exitPath)).mtime.toISOString();
    } catch {
      exitCode = null;
    }
    return deriveApplyState({ meta, exitCode, exitAt, pidAlive: pidAlive(meta.pid), log });
  }

  async function getStatus(opts: { refresh?: boolean } = {}): Promise<ForkUpdateStatus> {
    const checkedAt = new Date().toISOString();
    const base: ForkUpdateStatus = {
      supported: false,
      reason: null,
      repoRoot,
      branch: null,
      localCommit: null,
      localVersion: serverVersion,
      dirty: false,
      remote: null,
      remoteCommit: null,
      remoteAhead: 0,
      localAhead: 0,
      upstream: { remote: null, latestTag: null, mergedIntoRemote: null, mergedLocally: null },
      workflow: { available: false, authenticated: false, latestRun: null, error: null },
      apply: null,
      refreshed: false,
      checkedAt,
    };
    if (!repoRoot) return { ...base, reason: "Paperclip is not running from a git checkout." };

    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (!branch) return { ...base, reason: "The checkout is not on a branch." };
    const originUrl = await git(["remote", "get-url", "origin"]).catch(() => "");
    const remote = originUrl ? parseGitHubRemote(originUrl) : null;
    if (!remote) return { ...base, branch, reason: "The checkout's origin remote is not a GitHub repository." };

    const upstreamRemote = (await gitOk(["remote", "get-url", "upstream"])) ? "upstream" : null;
    const workflowAvailable = existsSync(path.join(repoRoot, ".github", "workflows", FORK_SYNC_WORKFLOW_FILE));
    const status: ForkUpdateStatus = {
      ...base,
      supported: true,
      branch,
      remote,
      upstream: { ...base.upstream, remote: upstreamRemote },
      workflow: { ...base.workflow, available: workflowAvailable },
      apply: await readApplyState(),
    };

    if (opts.refresh) {
      try {
        await git(["fetch", "--quiet", "origin", branch], FETCH_TIMEOUT_MS);
        if (upstreamRemote) await git(["fetch", "--quiet", "--tags", upstreamRemote], FETCH_TIMEOUT_MS);
        status.refreshed = true;
      } catch (error) {
        status.workflow.error = `Fetch failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      }
    }

    status.localCommit = await git(["rev-parse", "--short", "HEAD"]).catch(() => null);
    status.dirty = (await git(["status", "--porcelain=v1", "--untracked-files=no"]).catch(() => "")).length > 0;
    const remoteRef = `refs/remotes/origin/${branch}`;
    if (await gitOk(["rev-parse", "--verify", "--quiet", remoteRef])) {
      status.remoteCommit = await git(["rev-parse", "--short", remoteRef]).catch(() => null);
      status.remoteAhead = Number.parseInt(await git(["rev-list", "--count", `HEAD..${remoteRef}`]).catch(() => "0"), 10) || 0;
      status.localAhead = Number.parseInt(await git(["rev-list", "--count", `${remoteRef}..HEAD`]).catch(() => "0"), 10) || 0;
    }
    const tags = (await git(["tag", "-l", "v*"]).catch(() => "")).split("\n");
    const latestTag = pickLatestReleaseTag(tags);
    status.upstream.latestTag = latestTag;
    if (latestTag) {
      status.upstream.mergedLocally = await gitOk(["merge-base", "--is-ancestor", `refs/tags/${latestTag}`, "HEAD"]);
      status.upstream.mergedIntoRemote = status.remoteCommit
        ? await gitOk(["merge-base", "--is-ancestor", `refs/tags/${latestTag}`, remoteRef])
        : null;
    }

    if (opts.refresh && workflowAvailable) {
      const token = await resolveToken();
      status.workflow.authenticated = token !== null;
      if (token) {
        try {
          status.workflow.latestRun = await latestRun(token, remote, branch);
        } catch (error) {
          status.workflow.error = error instanceof Error ? error.message : String(error);
        }
      } else {
        status.workflow.error =
          "No GitHub token: set PAPERCLIP_FORK_GITHUB_TOKEN for the service, or sign in with the gh CLI on this machine.";
      }
    }
    return status;
  }

  async function dispatchSync(input: { upstreamRef?: string; dryRun?: boolean }) {
    const status = await getStatus();
    if (!status.supported || !status.remote || !status.branch) throw unprocessable(status.reason ?? "Fork updates are not available");
    if (!status.workflow.available) throw unprocessable(`The checkout has no .github/workflows/${FORK_SYNC_WORKFLOW_FILE}`);
    const token = await resolveToken();
    if (!token) throw unprocessable("No GitHub token: set PAPERCLIP_FORK_GITHUB_TOKEN for the service, or sign in with the gh CLI on this machine.");
    const { owner, repo } = status.remote;
    const before = await latestRun(token, status.remote, status.branch).catch(() => null);
    if (before && (before.status === "queued" || before.status === "in_progress")) {
      throw conflict("A sync run is already in progress", { code: "fork_sync_in_progress", run: before });
    }
    await github(token, "POST", `/repos/${owner}/${repo}/actions/workflows/${FORK_SYNC_WORKFLOW_FILE}/dispatches`, {
      ref: status.branch,
      inputs: {
        upstream_ref: input.upstreamRef ?? "",
        dry_run: input.dryRun ? "true" : "false",
      },
    });
    // The run appears a moment after the dispatch; report it when it already has.
    let run: ForkSyncRun | null = null;
    for (let attempt = 0; attempt < 5 && !run; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const latest = await latestRun(token, status.remote, status.branch).catch(() => null);
      if (latest && (!before || latest.id !== before.id)) run = latest;
    }
    return { dispatched: true as const, run };
  }

  async function startApply() {
    const status = await getStatus();
    if (!status.supported || !status.branch || !repoRoot) throw unprocessable(status.reason ?? "Fork updates are not available");
    if (status.apply?.phase === "running") throw conflict("An update is already being applied", { code: "fork_apply_in_progress" });
    if (status.dirty) {
      throw unprocessable("The checkout has uncommitted changes; commit or stash them before applying an update.", {
        code: "fork_checkout_dirty",
      });
    }
    const dir = applyDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await Promise.all([APPLY_LOG, APPLY_EXIT].map((name) => fs.rm(path.join(dir, name), { force: true })));
    const instanceId = resolvePaperclipInstanceId();
    const launcher = path.join(repoRoot, "bin", "paperclipai");
    const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const script = [
      "set -u",
      `export PATH=${q(toolchainPath())}`,
      `STATE_DIR=${q(dir)}`,
      `trap 'code=$?; echo "$code" > "$STATE_DIR/${APPLY_EXIT}"; exit $code' EXIT`,
      `step() { echo "${STEP_MARKER}$1"; echo "==> $1"; }`,
      `cd ${q(repoRoot)} || exit 1`,
      "step fetch",
      `git fetch --quiet origin ${q(status.branch)} || exit 1`,
      "step pull",
      `git merge --ff-only ${q(`origin/${status.branch}`)} || exit 1`,
      "step install",
      'command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on PATH for the service"; exit 1; }',
      "pnpm install --frozen-lockfile || exit 1",
      "step build",
      "pnpm build || exit 1",
      "step restart",
      `${q(launcher)} service restart --instance ${q(instanceId)} --json || exit 1`,
      "step done",
    ].join("\n");
    const logFd = openSync(path.join(dir, APPLY_LOG), "a", 0o600);
    let child;
    try {
      child = spawn("/bin/sh", ["-c", script], {
        cwd: repoRoot,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, PATH: toolchainPath(), CI: "1" },
      });
    } finally {
      closeSync(logFd);
    }
    child.unref();
    const meta: ApplyMeta = {
      startedAt: new Date().toISOString(),
      pid: child.pid ?? -1,
      targetCommit: status.remoteCommit,
    };
    await fs.writeFile(path.join(dir, APPLY_META), JSON.stringify(meta, null, 2), { mode: 0o600 });
    logger.info({ pid: meta.pid, targetCommit: meta.targetCommit, branch: status.branch }, "fork update apply started");
    const apply = (await readApplyState()) ?? deriveApplyState({ meta, exitCode: null, exitAt: null, pidAlive: true, log: "" });
    return { started: true as const, apply };
  }

  return { getStatus, dispatchSync, startApply };
}

export type ForkUpdateService = ReturnType<typeof forkUpdateService>;
