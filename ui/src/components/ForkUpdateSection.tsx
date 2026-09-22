import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ForkUpdateStatus } from "@paperclipai/shared";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { forkUpdateApi } from "@/api/forkUpdate";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

const POLL_MS = 10_000;

function runInProgress(status: ForkUpdateStatus | undefined) {
  const run = status?.workflow.latestRun;
  return run?.status === "queued" || run?.status === "in_progress" || run?.status === "waiting";
}

function applyInProgress(status: ForkUpdateStatus | undefined) {
  return status?.apply?.phase === "running";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Updates card for a Paperclip instance running from a git checkout of a fork.
 * Two actions: ask GitHub to merge the newest upstream release into the fork's
 * branch (the "Sync upstream" workflow), and apply whatever the fork's branch
 * holds to this machine (pull, build, hot-restart). The server hides the card
 * entirely when it is not running from such a checkout.
 */
export function ForkUpdateSection() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.forkUpdate,
    queryFn: () => forkUpdateApi.status(),
    retry: false,
    // While GitHub or the local apply is working, keep the card live. The apply
    // ends with a server restart, so failed polls in that window are expected.
    refetchInterval: (query) =>
      runInProgress(query.state.data) || applyInProgress(query.state.data) ? POLL_MS : false,
  });
  const status = statusQuery.data;

  const refresh = async () => {
    setActionError(null);
    setRefreshing(true);
    try {
      const next = await forkUpdateApi.status({ refresh: true });
      queryClient.setQueryData(queryKeys.instance.forkUpdate, next);
    } catch (error) {
      setActionError(errorMessage(error, "Could not check for updates."));
    } finally {
      setRefreshing(false);
    }
  };

  const syncMutation = useMutation({
    mutationFn: () => forkUpdateApi.sync({}),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      await refresh();
    },
    onError: (error) => setActionError(errorMessage(error, "Could not start the upstream sync.")),
  });

  const applyMutation = useMutation({
    mutationFn: () => forkUpdateApi.apply(),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.forkUpdate });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not start applying the update.")),
  });

  if (statusQuery.isLoading) return null;
  if (!status?.supported) return null;

  const run = status.workflow.latestRun;
  const syncBusy = syncMutation.isPending || runInProgress(status);
  const applyBusy = applyMutation.isPending || applyInProgress(status);
  const upstreamState =
    status.upstream.latestTag === null
      ? "No upstream release tags fetched yet."
      : status.upstream.mergedIntoRemote
        ? `Fork branch already contains ${status.upstream.latestTag}.`
        : status.upstream.mergedIntoRemote === false
          ? `${status.upstream.latestTag} is not in the fork branch yet.`
          : `Newest known release: ${status.upstream.latestTag}.`;
  const localState =
    status.remoteAhead > 0
      ? `${status.remoteAhead} commit${status.remoteAhead === 1 ? "" : "s"} on GitHub not applied here.`
      : status.remoteCommit
        ? "This machine matches the fork branch on GitHub."
        : "Fork branch on GitHub not fetched yet.";

  return (
    <section>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Updates</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Running from{" "}
              {status.remote ? (
                <a className="underline underline-offset-2" href={status.remote.url} target="_blank" rel="noreferrer">
                  {status.remote.owner}/{status.remote.repo}
                </a>
              ) : (
                "a git checkout"
              )}
              {status.branch ? <> on <code className="text-xs">{status.branch}</code></> : null}
              {status.localCommit ? <> at <code className="text-xs">{status.localCommit}</code></> : null}
              {status.localVersion ? <> (version {status.localVersion})</> : null}.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing || applyBusy}>
            <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Check for updates
          </Button>
        </div>

        {actionError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              Upstream releases
            </div>
            <p className="text-sm text-muted-foreground">{upstreamState}</p>
            {run ? (
              <p className="text-xs text-muted-foreground">
                Last sync run: {run.status}
                {run.conclusion ? ` (${run.conclusion})` : ""}{" "}
                <a className="inline-flex items-center gap-1 underline underline-offset-2" href={run.url} target="_blank" rel="noreferrer">
                  view <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            ) : null}
            {status.workflow.error ? (
              <p className="text-xs text-destructive">{status.workflow.error}</p>
            ) : null}
            <Button
              size="sm"
              onClick={() => syncMutation.mutate()}
              disabled={syncBusy || applyBusy || !status.workflow.available}
            >
              {runInProgress(status) ? "Sync running on GitHub..." : "Sync upstream on GitHub"}
            </Button>
          </div>

          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              This machine
            </div>
            <p className="text-sm text-muted-foreground">{localState}</p>
            {status.localAhead > 0 ? (
              <p className="text-xs text-muted-foreground">
                {status.localAhead} local commit{status.localAhead === 1 ? "" : "s"} not pushed to GitHub.
              </p>
            ) : null}
            {status.dirty ? (
              <p className="text-xs text-destructive">Uncommitted changes in the checkout block applying an update.</p>
            ) : null}
            <Button
              size="sm"
              onClick={() => applyMutation.mutate()}
              disabled={applyBusy || syncBusy || status.dirty || status.remoteAhead === 0}
            >
              {applyInProgress(status) ? "Applying update..." : "Apply update and restart"}
            </Button>
          </div>
        </div>

        {status.apply ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Last apply {status.apply.phase}
              {status.apply.step ? ` (step: ${status.apply.step})` : ""} · started{" "}
              {new Date(status.apply.startedAt).toLocaleString()}
              {status.apply.finishedAt ? `, finished ${new Date(status.apply.finishedAt).toLocaleString()}` : ""}
              {status.apply.phase === "running" ? " · the server restarts at the end; this page may briefly lose connection." : ""}
            </p>
            {status.apply.logTail ? (
              <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
                {status.apply.logTail}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
