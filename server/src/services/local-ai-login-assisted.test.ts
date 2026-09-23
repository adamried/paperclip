import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistedLoginManager, parseClaudeLoginUrl } from "./local-ai-login-assisted.js";

describe("parseClaudeLoginUrl", () => {
  it("finds the sign-in URL in the CLI output, ignoring colour codes", () => {
    const output = "Opening browser to sign in…\n\x1b[2mIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\x1b[0m\nPaste code here if prompted > ";
    expect(parseClaudeLoginUrl(output)).toBe("https://claude.com/cai/oauth/authorize?code=true&x=1");
    expect(parseClaudeLoginUrl("nothing yet")).toBeNull();
  });
});

describe("createAssistedLoginManager", () => {
  let dir: string;
  let fakeCli: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assisted-login-"));
    fakeCli = path.join(dir, "fake-claude");
    // Mimics `claude auth login`: prints the URL, waits for a code on stdin,
    // then writes a credential into CLAUDE_CONFIG_DIR and exits 0.
    await writeFile(fakeCli, `#!/bin/sh
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
printf "Paste code here if prompted > "
read code
[ "$code" = "good-code" ] || { echo "Invalid code"; exit 1; }
echo '{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
exit 0
`);
    await chmod(fakeCli, 0o755);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("surfaces the URL, forwards the code, and reports completion", async () => {
    const manager = createAssistedLoginManager({ command: fakeCli });
    const home = path.join(dir, "home");
    await writeFile(path.join(dir, "keep"), "");
    await rm(home, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(home, { recursive: true }));
    expect(manager.ensure("attempt", home).state).toBe("starting");
    await vi.waitFor(() => expect(manager.snapshot("attempt")?.state).toBe("awaiting_code"));
    expect(manager.snapshot("attempt")?.loginUrl).toBe("https://claude.com/cai/oauth/authorize?code=true");
    expect(manager.submitCode("attempt", "good-code").state).toBe("completing");
    await vi.waitFor(() => expect(manager.snapshot("attempt")?.state).toBe("exited"));
    expect(manager.snapshot("attempt")?.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("a");
    manager.stop("attempt");
    expect(manager.snapshot("attempt")).toBeNull();
  });

  it("reports a failed sign-in with the CLI's last line and refuses further codes", async () => {
    const manager = createAssistedLoginManager({ command: fakeCli });
    const home = path.join(dir, "home2");
    await import("node:fs/promises").then((fs) => fs.mkdir(home, { recursive: true }));
    manager.ensure("attempt", home);
    await vi.waitFor(() => expect(manager.snapshot("attempt")?.state).toBe("awaiting_code"));
    manager.submitCode("attempt", "bad-code");
    await vi.waitFor(() => expect(manager.snapshot("attempt")?.state).toBe("exited"));
    expect(manager.snapshot("attempt")?.exitCode).toBe(1);
    expect(manager.snapshot("attempt")?.error).toBe("Invalid code");
    expect(() => manager.submitCode("attempt", "again")).toThrow(/not running/);
  });

  it("marks a missing command as exited with an error", async () => {
    const manager = createAssistedLoginManager({ command: path.join(dir, "does-not-exist") });
    manager.ensure("attempt", dir);
    await vi.waitFor(() => expect(manager.snapshot("attempt")?.state).toBe("exited"));
    expect(manager.snapshot("attempt")?.error).toMatch(/ENOENT/);
  });
});
