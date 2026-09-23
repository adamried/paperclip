import { useQuery } from "@tanstack/react-query";
import type { RuntimeInventoryEntry } from "@paperclipai/shared";
import { Cpu } from "lucide-react";
import { runtimesApi } from "@/api/runtimes";
import { queryKeys } from "@/lib/queryKeys";

function versionDiffers(entry: RuntimeInventoryEntry): boolean {
  return Boolean(entry.host?.version && entry.bundled?.cliVersion && entry.host.version !== entry.bundled.cliVersion);
}

/**
 * Which build of each provider CLI local agent runs use. Claude and Codex
 * go through an ACP server that carries a bundled CLI; Paperclip prefers the
 * host's installed CLI so runs, the Test probe and the operator's terminal
 * agree. Updating a host CLI therefore changes what agents run on, which
 * this card makes visible.
 */
export function RuntimeInventorySection() {
  const query = useQuery({ queryKey: queryKeys.instance.runtimes, queryFn: () => runtimesApi.inventory(), retry: false, staleTime: 60_000 });
  if (query.isLoading || query.error || !query.data) return null;
  const installed = query.data.runtimes.filter((entry) => entry.host || entry.bundled);
  if (installed.length === 0) return null;
  return (
    <section>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Cpu className="h-4 w-4 text-muted-foreground" />Agent runtimes</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The provider CLI build each local adapter runs on. Installed CLIs are preferred; a bundled copy is the fallback
            when none is installed. Update a CLI with its own installer and agents use the new build on their next run.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="py-1 pr-4 text-left font-medium">Adapter</th><th className="py-1 pr-4 text-left font-medium">Runs use</th><th className="py-1 pr-4 text-left font-medium">Installed</th><th className="py-1 text-left font-medium">Bundled</th></tr>
            </thead>
            <tbody>
              {installed.map((entry) => (
                <tr key={entry.adapterType} className="border-t border-border/60 align-top">
                  <td className="py-2 pr-4">{entry.label}</td>
                  <td className="py-2 pr-4">
                    {entry.effective === "host" ? "Installed CLI" : entry.effective === "bundled" ? "Bundled copy" : "Not available"}
                    {versionDiffers(entry) && entry.effective === "host" ? <span className="block text-xs text-muted-foreground">Bundled copy differs; runs follow the installed CLI.</span> : null}
                  </td>
                  <td className="py-2 pr-4">
                    {entry.host ? <><span>{entry.host.version ?? "unknown version"}</span><span className="block break-all text-xs text-muted-foreground">{entry.host.path}</span></> : <span className="text-muted-foreground">not found on PATH</span>}
                  </td>
                  <td className="py-2">
                    {entry.bundled ? <><span>{entry.bundled.cliVersion ?? entry.bundled.version ?? "unknown"}</span><span className="block text-xs text-muted-foreground">{entry.bundled.package}{entry.overrideEnv ? ` · override with ${entry.overrideEnv}` : ""}</span></> : <span className="text-muted-foreground">none</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
