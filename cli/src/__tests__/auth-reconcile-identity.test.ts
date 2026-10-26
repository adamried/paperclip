import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityReconciliationReport } from "@paperclipai/db";
import {
  ReconcileIdentityCommandError,
  reconcileIdentity,
  writeReconciliationReportFile,
} from "../commands/auth-reconcile-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-reconcile-identity-"));
  tempDirs.push(dir);
  return dir;
}

function sampleReport(): IdentityReconciliationReport {
  return {
    mode: "preview",
    generatedAt: "2026-10-26T12:34:56.789Z",
    fromUserId: "local-board",
    toUser: { id: "user-1", email: "operator@example.test", name: "Operator" },
    includeBoardKeys: false,
    companies: [{ id: "company-1", name: "Alpha" }],
    entries: [],
    reauthorize: [],
    defaultsPointingAtPersonalGrants: [],
    sourceUserExists: true,
    sourceHoldsInstanceAdmin: false,
    warnings: [],
    totals: { matched: 0, changed: 0, skipped: 0 },
    activityLogRowsWritten: 0,
  };
}

describe("auth reconcile-identity command", () => {
  it("writes the JSON report under the given directory with a timestamped name", () => {
    const dir = path.join(makeTempDir(), "nested", "data-dir");
    const filePath = writeReconciliationReportFile(sampleReport(), dir);

    expect(path.dirname(filePath)).toBe(dir);
    expect(path.basename(filePath)).toBe("reconcile-identity-2026-10-26T12-34-56-789Z.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as IdentityReconciliationReport;
    expect(parsed.fromUserId).toBe("local-board");
    expect(parsed.toUser.id).toBe("user-1");
  });

  it("rejects missing --from / --to before touching any database", async () => {
    const configDir = makeTempDir();
    const configPath = path.join(configDir, "config.json");

    await expect(
      reconcileIdentity({ config: configPath, to: "operator@example.test", dbUrl: "postgres://unused" }),
    ).rejects.toBeInstanceOf(ReconcileIdentityCommandError);
    await expect(
      reconcileIdentity({ config: configPath, from: "local-board", dbUrl: "postgres://unused" }),
    ).rejects.toThrow(/--to <userId\|email> is required/);
  });

  it("fails with a clear message when no database can be resolved", async () => {
    const configDir = makeTempDir();
    const configPath = path.join(configDir, "missing-config.json");
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(
        reconcileIdentity({ config: configPath, from: "local-board", to: "operator@example.test" }),
      ).rejects.toThrow(/No config found|Could not resolve the database connection/);
    } finally {
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
