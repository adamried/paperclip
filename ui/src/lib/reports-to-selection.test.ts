import { describe, expect, it } from "vitest";
import {
  BOARD_SELECTION,
  selectionFromAgent,
  selectionFromPatch,
  selectionToPatch,
  selectionsEqual,
} from "./reports-to-selection";

describe("reports-to-selection", () => {
  it("reads the Board from an agent with no manager", () => {
    expect(selectionFromAgent({ reportsTo: null, reportsToUserId: null })).toEqual(BOARD_SELECTION);
    expect(selectionFromAgent(null)).toEqual(BOARD_SELECTION);
  });

  it("prefers the agent manager, then the human manager", () => {
    expect(selectionFromAgent({ reportsTo: "a1", reportsToUserId: null })).toEqual({ kind: "agent", id: "a1" });
    expect(selectionFromAgent({ reportsTo: null, reportsToUserId: "u1" })).toEqual({ kind: "user", id: "u1" });
    expect(selectionFromPatch({ reportsToUserId: "u1" })).toEqual({ kind: "user", id: "u1" });
  });

  it("always writes both columns so the other manager is cleared", () => {
    expect(selectionToPatch({ kind: "board" })).toEqual({ reportsTo: null, reportsToUserId: null });
    expect(selectionToPatch({ kind: "agent", id: "a1" })).toEqual({ reportsTo: "a1", reportsToUserId: null });
    expect(selectionToPatch({ kind: "user", id: "u1" })).toEqual({ reportsTo: null, reportsToUserId: "u1" });
  });

  it("compares selections by kind and id", () => {
    expect(selectionsEqual({ kind: "board" }, { kind: "board" })).toBe(true);
    expect(selectionsEqual({ kind: "agent", id: "a1" }, { kind: "agent", id: "a1" })).toBe(true);
    expect(selectionsEqual({ kind: "agent", id: "a1" }, { kind: "user", id: "a1" })).toBe(false);
    expect(selectionsEqual({ kind: "user", id: "u1" }, { kind: "user", id: "u2" })).toBe(false);
  });
});
