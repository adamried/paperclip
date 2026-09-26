import { describe, expect, it, vi } from "vitest";
import { defaultAgentCardAddressee } from "../services/agent-manager.js";

/**
 * A minimal drizzle-shaped fake: each `select` call answers with the next
 * queued row set, in the order the helper issues its queries:
 * 1. the agent row (reportsToUserId)
 * 2. the manager's membership
 * 3. the source run (responsibleUserId), only when a sourceRunId is given
 * 4. the run user's membership, only when it differs from the manager
 */
function fakeDb(rowSets: unknown[][]) {
  const queue = [...rowSets];
  const chain = () => {
    const rows = queue.shift() ?? [];
    const thenable = {
      where: () => thenable,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return thenable;
  };
  return {
    select: vi.fn(() => ({ from: vi.fn(() => chain()) })),
  } as never;
}

const active = { status: "active", membershipRole: "operator" };

describe("defaultAgentCardAddressee", () => {
  it("gives no default to an agent that reports to the Board or to an agent", async () => {
    const db = fakeDb([[{ reportsToUserId: null }]]);
    expect(await defaultAgentCardAddressee(db, "company-1", "agent-1", "run-1")).toBeNull();
  });

  it("falls back to the manager when there is no source run", async () => {
    const db = fakeDb([[{ reportsToUserId: "manager-1" }], [active]]);
    expect(await defaultAgentCardAddressee(db, "company-1", "agent-1", null)).toBe("manager-1");
  });

  it("prefers the run's responsible user when that person is an active member", async () => {
    const db = fakeDb([
      [{ reportsToUserId: "manager-1" }],
      [active],
      [{ responsibleUserId: "requester-1" }],
      [active],
    ]);
    expect(await defaultAgentCardAddressee(db, "company-1", "agent-1", "run-1")).toBe("requester-1");
  });

  it("skips an inactive run user and a suspended manager", async () => {
    const suspendedRunUser = fakeDb([
      [{ reportsToUserId: "manager-1" }],
      [active],
      [{ responsibleUserId: "requester-1" }],
      [{ status: "suspended", membershipRole: "operator" }],
    ]);
    expect(await defaultAgentCardAddressee(suspendedRunUser, "company-1", "agent-1", "run-1")).toBe("manager-1");

    const suspendedManager = fakeDb([
      [{ reportsToUserId: "manager-1" }],
      [{ status: "suspended", membershipRole: "owner" }],
    ]);
    expect(await defaultAgentCardAddressee(suspendedManager, "company-1", "agent-1", "run-1")).toBeNull();
  });
});
