import { z } from "zod";

// Fork update: keep a source checkout of a Paperclip fork current with its own
// GitHub branch and with upstream releases. The server half runs git against
// the checkout it is executing from and talks to the fork's GitHub Actions
// "Sync upstream" workflow; the UI half is a card in Instance Settings.

export const FORK_SYNC_WORKFLOW_FILE = "sync-upstream.yml";

export type ForkSyncRun = {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type ForkApplyPhase = "running" | "succeeded" | "failed";

export type ForkApplyState = {
  phase: ForkApplyPhase;
  /** Last step marker written by the apply script (fetch, pull, install, build, restart, done). */
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  /** Commit the apply targeted (origin/<branch> at start), short SHA. */
  targetCommit: string | null;
  logTail: string;
};

export type ForkUpdateStatus = {
  /** False when the server is not running from a git checkout with a GitHub origin. */
  supported: boolean;
  reason: string | null;
  repoRoot: string | null;
  branch: string | null;
  localCommit: string | null;
  localVersion: string | null;
  /** Uncommitted changes in the checkout block a fast-forward apply. */
  dirty: boolean;
  remote: { owner: string; repo: string; url: string } | null;
  remoteCommit: string | null;
  /** Commits on the fork's GitHub branch that are not applied locally. */
  remoteAhead: number;
  /** Local commits not pushed to the fork (informational). */
  localAhead: number;
  upstream: {
    remote: string | null;
    latestTag: string | null;
    /** Whether latestTag is contained in the fork's GitHub branch (null when unknown). */
    mergedIntoRemote: boolean | null;
    /** Whether latestTag is contained in the local checkout (null when unknown). */
    mergedLocally: boolean | null;
  };
  workflow: {
    /** The sync workflow file exists in the checkout. */
    available: boolean;
    /** A GitHub token could be resolved (env or gh CLI). */
    authenticated: boolean;
    latestRun: ForkSyncRun | null;
    error: string | null;
  };
  apply: ForkApplyState | null;
  /** True when the remote/GitHub facts were refreshed in this response. */
  refreshed: boolean;
  checkedAt: string;
};

export const forkUpdateSyncRequestSchema = z.object({
  upstreamRef: z.string().trim().max(200).optional(),
  dryRun: z.boolean().optional(),
});
export type ForkUpdateSyncRequest = z.infer<typeof forkUpdateSyncRequestSchema>;

export type ForkUpdateSyncResponse = {
  dispatched: true;
  run: ForkSyncRun | null;
};

export type ForkUpdateApplyResponse = {
  started: true;
  apply: ForkApplyState;
};
