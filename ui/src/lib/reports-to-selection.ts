import type { Agent } from "@paperclipai/shared";

/**
 * What an agent reports to, as the picker sees it. Storage is two nullable
 * columns (`reportsTo` for an agent, `reportsToUserId` for a person); both
 * null means the Board.
 */
export type ReportsToSelection =
  | { kind: "board" }
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string };

export type ReportsToPatch = {
  reportsTo: string | null;
  reportsToUserId: string | null;
};

export const BOARD_SELECTION: ReportsToSelection = { kind: "board" };

export function selectionFromAgent(
  agent: Pick<Agent, "reportsTo" | "reportsToUserId"> | null | undefined,
): ReportsToSelection {
  if (agent?.reportsTo) return { kind: "agent", id: agent.reportsTo };
  if (agent?.reportsToUserId) return { kind: "user", id: agent.reportsToUserId };
  return BOARD_SELECTION;
}

export function selectionFromPatch(patch: Partial<ReportsToPatch>): ReportsToSelection {
  return selectionFromAgent({
    reportsTo: patch.reportsTo ?? null,
    reportsToUserId: patch.reportsToUserId ?? null,
  });
}

/** Both fields are always sent so the server clears the one not chosen. */
export function selectionToPatch(selection: ReportsToSelection): ReportsToPatch {
  switch (selection.kind) {
    case "agent":
      return { reportsTo: selection.id, reportsToUserId: null };
    case "user":
      return { reportsTo: null, reportsToUserId: selection.id };
    default:
      return { reportsTo: null, reportsToUserId: null };
  }
}

export function selectionsEqual(left: ReportsToSelection, right: ReportsToSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "board" || right.kind === "board") return true;
  return left.id === right.id;
}
