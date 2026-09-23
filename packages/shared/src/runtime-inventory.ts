/** Which build of a provider CLI agent runs on, per adapter. */
export type RuntimeInventoryEntry = {
  adapterType: string;
  label: string;
  /** The CLI command the adapter launches on the host. */
  command: string;
  host: { path: string; version: string | null } | null;
  /** A runtime bundled with the adapter's ACP server, when there is one. */
  bundled: { package: string; version: string | null; cliVersion: string | null } | null;
  /** What a local run uses today. */
  effective: "host" | "bundled" | "missing";
  /** The environment variable that overrides the choice, when applicable. */
  overrideEnv: string | null;
};

export type RuntimeInventory = {
  runtimes: RuntimeInventoryEntry[];
  checkedAt: string;
};
