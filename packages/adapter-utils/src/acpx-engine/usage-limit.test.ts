import { describe, expect, it } from "vitest";
import {
  acpxTerminalFailureCategory,
  formatUsageLimitErrorMessage,
  isUsageLimitNotice,
} from "./execute.js";

describe("usage limit detection", () => {
  it("recognizes Claude Code's usage-limit notices and nothing else", () => {
    expect(isUsageLimitNotice("You've hit your limit · resets 3pm (America/Chicago)")).toBe(true);
    expect(isUsageLimitNotice("  You've reached your weekly limit")).toBe(true);
    expect(isUsageLimitNotice("You're out of usage credits")).toBe(true);
    expect(isUsageLimitNotice("Sure, here is the plan you asked for.")).toBe(false);
    expect(isUsageLimitNotice("")).toBe(false);
    expect(isUsageLimitNotice(null)).toBe(false);
  });

  it("reads the category out of acpx's typed terminal failure sentence", () => {
    expect(acpxTerminalFailureCategory("ACP agent reported a terminal limit failure.")).toBe("limit");
    expect(acpxTerminalFailureCategory("ACP agent reported a terminal access failure.")).toBe("access");
    expect(acpxTerminalFailureCategory("spawn claude ENOENT")).toBeNull();
  });

  it("leads the run error with Claude's own notice when one was seen", () => {
    expect(formatUsageLimitErrorMessage("You've hit your limit · resets 3pm (America/Chicago)")).toBe(
      "Claude usage limit reached: You've hit your limit · resets 3pm (America/Chicago)",
    );
    expect(formatUsageLimitErrorMessage(null)).toMatch(/^Claude usage limit reached\. /);
  });
});
