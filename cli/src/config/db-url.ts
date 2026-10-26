import type { PaperclipConfig } from "./schema.js";
import { readConfig } from "./store.js";

/**
 * Resolve the database connection string for host-authorized maintenance
 * commands that talk to the database directly (no HTTP API involved).
 *
 * Order: explicit flag, `DATABASE_URL`, config `postgres` connection string,
 * config embedded-postgres port.
 */
export function resolveDbUrl(configPath?: string, explicitDbUrl?: string): string | null {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  return resolveDatabaseUrlFromConfig(config?.database);
}

export function resolveDatabaseUrlFromConfig(database: PaperclipConfig["database"] | undefined): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (database?.mode === "postgres" && database.connectionString) {
    return database.connectionString;
  }
  if (database?.mode === "embedded-postgres") {
    const port = database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}
