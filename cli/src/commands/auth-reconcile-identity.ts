import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  applyIdentityReconciliation,
  createDb,
  formatIdentityReconciliationReport,
  IdentityReconciliationError,
  LOCAL_BOARD_USER_ID,
  previewIdentityReconciliation,
  resolveIdentityReconciliationTarget,
  type IdentityReconciliationReport,
} from "@paperclipai/db";
import { resolveDbUrl } from "../config/db-url.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { resolvePaperclipInstanceRoot } from "../config/home.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

export interface ReconcileIdentityOptions {
  config?: string;
  dataDir?: string;
  instance?: string;
  from?: string;
  to?: string;
  apply?: boolean;
  includeBoardKeys?: boolean;
  dbUrl?: string;
  json?: boolean;
  /** Directory for the JSON report. Defaults to the instance data directory. */
  reportDir?: string;
}

export class ReconcileIdentityCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileIdentityCommandError";
  }
}

function reportFileName(report: IdentityReconciliationReport): string {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  return `reconcile-identity-${stamp}.json`;
}

export function writeReconciliationReportFile(report: IdentityReconciliationReport, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, reportFileName(report));
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

/**
 * `paperclipai auth reconcile-identity --from local-board --to <userId|email> [--apply] [--include-board-keys]`
 *
 * Host-authorized: runs against the database directly with the same trust as
 * `auth bootstrap-ceo`. Dry run by default; `--apply` runs one transaction.
 */
export async function reconcileIdentity(opts: ReconcileIdentityOptions): Promise<IdentityReconciliationReport> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const config = readConfig(configPath);

  const fromUserId = (opts.from ?? "").trim();
  const toRef = (opts.to ?? "").trim();
  if (!fromUserId) {
    throw new ReconcileIdentityCommandError(`--from is required (currently only ${LOCAL_BOARD_USER_ID} is supported).`);
  }
  if (!toRef) {
    throw new ReconcileIdentityCommandError("--to <userId|email> is required.");
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    throw new ReconcileIdentityCommandError(
      config
        ? "Could not resolve the database connection. Pass --db-url or set DATABASE_URL."
        : `No config found at ${configPath}. Run ${pc.cyan("paperclipai onboard")} first, or pass --db-url.`,
    );
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  try {
    const toUser = await resolveIdentityReconciliationTarget(db, toRef);
    const input = { fromUserId, toUser, includeBoardKeys: opts.includeBoardKeys === true };
    const report = opts.apply
      ? await applyIdentityReconciliation(db, input)
      : await previewIdentityReconciliation(db, input);

    const reportDir = opts.reportDir ?? resolvePaperclipInstanceRoot(opts.instance);
    let reportPath: string | null = null;
    try {
      reportPath = writeReconciliationReportFile(report, reportDir);
    } catch (err) {
      if (!opts.json) {
        p.log.warn(`Could not write the report file under ${reportDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    } else {
      console.log(formatIdentityReconciliationReport(report));
      if (reportPath) p.log.message(`Report written to ${pc.cyan(reportPath)}`);
      if (report.mode === "preview") {
        p.log.info(`Dry run. Re-run with ${pc.cyan("--apply")} to move the class A references in one transaction.`);
      } else {
        p.log.success(`Reconciled ${report.totals.changed} row(s) from ${fromUserId} to ${toUser.id}.`);
      }
      if (report.mode === "apply" && !opts.includeBoardKeys) {
        const boardKeys = report.entries.find((entry) => entry.table === "board_api_keys" && entry.class === "A");
        if (boardKeys && boardKeys.matched > 0) {
          p.log.warn(`${boardKeys.matched} board API key(s) were left on ${fromUserId}. Use --include-board-keys to move them.`);
        }
      }
    }
    return report;
  } catch (err) {
    if (err instanceof IdentityReconciliationError) {
      const remedy = err.remedy ? ` Run: ${err.remedy}` : "";
      throw new ReconcileIdentityCommandError(`${err.message}${remedy}`);
    }
    throw err;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
