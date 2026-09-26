import { describe, expect, it } from "vitest";
import { boardContactAgent } from "./board-contact-agent";

function agent(overrides: Partial<{
  id: string;
  role: string;
  status: string;
  reportsTo: string | null;
  reportsToUserId: string | null;
  metadata: Record<string, unknown> | null;
}>) {
  return {
    id: "a",
    role: "general",
    status: "idle",
    reportsTo: null,
    reportsToUserId: null,
    metadata: null,
    ...overrides,
  } as never;
}

describe("boardContactAgent", () => {
  it("prefers a live CEO", () => {
    const ceo = agent({ id: "ceo", role: "ceo" });
    const other = agent({ id: "other" });
    expect(boardContactAgent([other, ceo], null)).toBe(ceo);
    expect(boardContactAgent([agent({ id: "dead", role: "ceo", status: "terminated" }), other], null)).toBe(other);
  });

  it("falls back to the single root agent that reports to the Board", () => {
    const root = agent({ id: "root", role: "chief_of_staff" });
    const child = agent({ id: "child", reportsTo: "root" });
    const builtIn = agent({ id: "coach", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } } });
    expect(boardContactAgent([child, builtIn, root], null)).toBe(root);
    expect(boardContactAgent([root, agent({ id: "root2" })], null)).toBeNull();
  });

  it("falls back to a root agent the current person manages", () => {
    const mine = agent({ id: "mine", reportsToUserId: "me" });
    const theirs = agent({ id: "theirs", reportsToUserId: "them" });
    expect(boardContactAgent([theirs, mine], "me")).toBe(mine);
    expect(boardContactAgent([theirs, mine], null)).toBeNull();
  });
});
