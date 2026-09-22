import { describe, expect, it } from "vitest";
import { deriveApplyState, parseGitHubRemote, pickLatestReleaseTag } from "./fork-update.js";

describe("parseGitHubRemote", () => {
  it("accepts https and ssh GitHub remotes with or without .git", () => {
    for (const url of [
      "https://github.com/adamried/paperclip.git",
      "https://github.com/adamried/paperclip",
      "git@github.com:adamried/paperclip.git",
      "ssh://git@github.com/adamried/paperclip",
    ]) {
      expect(parseGitHubRemote(url)).toEqual({ owner: "adamried", repo: "paperclip", url: "https://github.com/adamried/paperclip" });
    }
  });
  it("rejects non-GitHub remotes", () => {
    expect(parseGitHubRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseGitHubRemote("/local/path")).toBeNull();
  });
});

describe("pickLatestReleaseTag", () => {
  it("orders by numeric parts and ignores nightlies and odd shapes", () => {
    expect(pickLatestReleaseTag(["v2026.831.1", "v2026.916.0", "v2026.916.1", "nightly/v2026.916.0-nightly.1", "v2026.99.9-rc"]))
      .toBe("v2026.916.1");
    // 2026.1000.0 sorts after 2026.916.1 numerically, not lexically.
    expect(pickLatestReleaseTag(["v2026.916.1", "v2026.1000.0"])).toBe("v2026.1000.0");
    expect(pickLatestReleaseTag([])).toBeNull();
  });
});

describe("deriveApplyState", () => {
  const meta = { startedAt: "2026-09-22T00:00:00.000Z", pid: 123, targetCommit: "abc1234" };
  it("reports running while the script is alive and no exit code exists", () => {
    const state = deriveApplyState({ meta, exitCode: null, exitAt: null, pidAlive: true, log: "::step::fetch\nhello\n::step::pull\n" });
    expect(state.phase).toBe("running");
    expect(state.step).toBe("pull");
    expect(state.logTail).toBe("hello");
    expect(state.finishedAt).toBeNull();
  });
  it("reports succeeded or failed from the exit code", () => {
    expect(deriveApplyState({ meta, exitCode: 0, exitAt: "t", pidAlive: false, log: "" }).phase).toBe("succeeded");
    expect(deriveApplyState({ meta, exitCode: 1, exitAt: "t", pidAlive: false, log: "" }).phase).toBe("failed");
  });
  it("treats a dead script without an exit code as failed", () => {
    expect(deriveApplyState({ meta, exitCode: null, exitAt: null, pidAlive: false, log: "" }).phase).toBe("failed");
  });
});
