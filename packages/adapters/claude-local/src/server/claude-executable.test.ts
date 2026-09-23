import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHostClaudeExecutable } from "./claude-executable.js";

describe("resolveHostClaudeExecutable", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "claude-exe-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("finds an executable on the given PATH", async () => {
    const exe = path.join(dir, "claude");
    await writeFile(exe, "#!/bin/sh\n"); await chmod(exe, 0o755);
    expect(resolveHostClaudeExecutable("claude", `${path.join(dir, "missing")}${path.delimiter}${dir}`)).toBe(exe);
  });
  it("ignores non-executable files and returns null when absent", async () => {
    // A unique name so the per-user fallback directories cannot satisfy it.
    await writeFile(path.join(dir, "claude-test-only"), "not executable");
    expect(resolveHostClaudeExecutable("claude-test-only", dir)).toBeNull();
    expect(resolveHostClaudeExecutable("definitely-not-installed-xyz", dir)).toBeNull();
  });
  it("checks an explicit path as given", async () => {
    const exe = path.join(dir, "custom-claude");
    await writeFile(exe, "#!/bin/sh\n"); await chmod(exe, 0o755);
    expect(resolveHostClaudeExecutable(exe, "")).toBe(exe);
    expect(resolveHostClaudeExecutable(path.join(dir, "nope"), "")).toBeNull();
  });
});
