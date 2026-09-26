import { describe, expect, it } from "vitest";
import {
  ORG_CHART_BOARD_NODE_ID,
  buildOrgChartTree,
  orgChartManagerUserIds,
  type OrgChartUserSummary,
} from "../services/org-chart-tree.js";

const agent = (id: string, extra: Partial<{ reportsToUserId: string | null; reports: ReturnType<typeof agent>[] }> = {}) => ({
  id,
  name: id.toUpperCase(),
  role: "general",
  status: "idle",
  reportsToUserId: extra.reportsToUserId ?? null,
  reports: extra.reports ?? [],
});

const users = new Map<string, OrgChartUserSummary>([
  ["u1", { name: "Dana", email: "dana@example.com", image: null, membershipRole: "owner", active: true }],
  ["u2", { name: null, email: null, image: null, membershipRole: "viewer", active: false }],
]);

describe("buildOrgChartTree", () => {
  it("returns an empty forest untouched so the empty state still fires", () => {
    expect(buildOrgChartTree([], users)).toEqual([]);
  });

  it("puts the Board at the root, people under it, and agents under their manager", () => {
    const ceo = agent("ceo", { reports: [agent("eng")] });
    const cos = agent("cos", { reportsToUserId: "u1" });
    const other = agent("other", { reportsToUserId: "u2" });
    const [root] = buildOrgChartTree([ceo, cos, other], users);

    expect(root?.kind).toBe("board");
    expect(root?.id).toBe(ORG_CHART_BOARD_NODE_ID);
    expect(root?.reports.map((node) => [node.kind, node.id])).toEqual([
      ["user", "user:u1"],
      ["user", "user:u2"],
      ["agent", "ceo"],
    ]);
    const dana = root!.reports[0]!;
    expect(dana.name).toBe("Dana");
    expect(dana.role).toBe("owner");
    expect(dana.status).toBe("active");
    expect(dana.reports.map((node) => node.id)).toEqual(["cos"]);
    const inactive = root!.reports[1]!;
    expect(inactive.status).toBe("inactive");
    expect(inactive.name).toBe("u2");
    expect(root!.reports[2]!.reports[0]!.kind).toBe("agent");
  });

  it("labels the local board user and unknown users sensibly", () => {
    const [root] = buildOrgChartTree(
      [agent("a", { reportsToUserId: "local-board" }), agent("b", { reportsToUserId: "0123456789" })],
      new Map(),
    );
    expect(root!.reports.map((node) => node.name).sort()).toEqual(["01234567", "Board"]);
  });

  it("lists the distinct manager ids referenced by roots", () => {
    expect(orgChartManagerUserIds([
      agent("a", { reportsToUserId: "u1" }),
      agent("b", { reportsToUserId: "u1" }),
      agent("c"),
    ])).toEqual(["u1"]);
  });
});
