import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockAgentManager = vi.hoisted(() => ({
  resolveActiveAgentManagerUserId: vi.fn(),
  assertHumanManagerEligible: vi.fn(),
}));
const mockDecisionPolicies = vi.hoisted(() => ({ get: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/agent-manager.js", () => mockAgentManager);
  vi.doMock("../services/approval-decision-policy.js", () => ({
    approvalDecisionPolicyService: () => mockDecisionPolicies,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler, approvalRoutes };
});

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve([{ name: "Dana Operator", email: "dana@example.com" }]),
        })),
      })),
    })),
  } as any;
}

function appFor(actor: Record<string, unknown>) {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

const boardActor = (userId: string) => ({
  type: "board",
  userId,
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
});

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
};

const pendingApproval = (addresseeUserId: string | null) => ({
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "pending",
  payload: {},
  requestedByAgentId: "agent-1",
  addresseeUserId,
});

describe("approval addressee and decision policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "company_scope:read", reason: "allow_test", explanation: "" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockDecisionPolicies.get.mockResolvedValue({ policy: "any_board" });
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-new",
      companyId: "company-1",
      ...input,
    }));
    // Agent runs pass the run-context gate without a real run row.
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
  });

  it("addresses a board user's request to nobody unless they say otherwise", async () => {
    const res = await request(appFor(boardActor("user-1")))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "x" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ addresseeUserId: null }));
    expect(mockAgentManager.resolveActiveAgentManagerUserId).not.toHaveBeenCalled();
  });

  it("lets a board user address an eligible member explicitly", async () => {
    mockAgentManager.assertHumanManagerEligible.mockResolvedValue({ status: "active", membershipRole: "operator" });
    const res = await request(appFor(boardActor("user-1")))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {}, addresseeUserId: "user-2" });

    expect(res.status).toBe(201);
    expect(mockAgentManager.assertHumanManagerEligible).toHaveBeenCalledWith(expect.anything(), "company-1", "user-2");
    expect(mockApprovalService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ addresseeUserId: "user-2" }));
  });

  it("refuses an agent addressing anyone but its own manager", async () => {
    mockAgentManager.resolveActiveAgentManagerUserId.mockResolvedValue("manager-1");
    const res = await request(appFor({ ...agentActor, runId: null }))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {}, addresseeUserId: "user-9" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("approval_addressee_not_allowed");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("blocks other board users when the addressee chose addressee_only, naming them", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval("manager-1"));
    mockDecisionPolicies.get.mockResolvedValue({ policy: "addressee_only" });

    const res = await request(appFor(boardActor("user-2")))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_addressee_only");
    // The error handler forwards only `code` from details; the message names
    // the addressee so the UI can say who to ask.
    expect(res.body.error).toContain("Dana Operator");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("lets the addressee decide, and anyone under any_board", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval("manager-1"));
    mockApprovalService.reject.mockResolvedValue({ approval: { ...pendingApproval("manager-1"), status: "rejected" }, applied: true });
    mockDecisionPolicies.get.mockResolvedValue({ policy: "addressee_only" });

    const mine = await request(appFor(boardActor("manager-1")))
      .post("/api/approvals/approval-1/reject")
      .send({});
    expect(mine.status).toBe(200);

    mockDecisionPolicies.get.mockResolvedValue({ policy: "any_board" });
    const other = await request(appFor(boardActor("user-2")))
      .post("/api/approvals/approval-1/reject")
      .send({});
    expect(other.status).toBe(200);
  });

  it("does not consult the policy for approvals with no addressee", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval(null));
    mockApprovalService.requestRevision.mockResolvedValue({ ...pendingApproval(null), status: "revision_requested" });

    const res = await request(appFor(boardActor("user-2")))
      .post("/api/approvals/approval-1/request-revision")
      .send({});

    expect(res.status).toBe(200);
    expect(mockDecisionPolicies.get).not.toHaveBeenCalled();
  });
});
