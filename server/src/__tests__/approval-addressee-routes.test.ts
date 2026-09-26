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
  assertAgentMayAssignManager: vi.fn(),
}));
const mockDecisionPolicies = vi.hoisted(() => ({ get: vi.fn() }));
const mockAssertDecisionAllowed = vi.hoisted(() => vi.fn());

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
    assertApprovalDecisionAllowed: mockAssertDecisionAllowed,
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
    mockAssertDecisionAllowed.mockResolvedValue(undefined);
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

  it("always addresses an agent's request to its own manager, ignoring the body", async () => {
    mockAgentManager.resolveActiveAgentManagerUserId.mockResolvedValue("manager-1");
    const app = appFor({ ...agentActor, runId: null });

    const explicitNull = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {}, addresseeUserId: null, requestedByAgentId: "00000000-0000-4000-8000-000000000009" });
    expect(explicitNull.status).toBe(201);
    expect(mockAgentManager.resolveActiveAgentManagerUserId).toHaveBeenCalledWith(expect.anything(), "company-1", "agent-1");
    expect(mockApprovalService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      requestedByAgentId: "agent-1",
      addresseeUserId: "manager-1",
    }));

    const someoneElse = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {}, addresseeUserId: "user-9" });
    expect(someoneElse.status).toBe(422);
    expect(someoneElse.body.code).toBe("approval_addressee_not_allowed");
  });

  it("addresses nobody when the agent has no active manager", async () => {
    mockAgentManager.resolveActiveAgentManagerUserId.mockResolvedValue(null);
    const res = await request(appFor({ ...agentActor, runId: null }))
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });
    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ addresseeUserId: null }));
  });

  it("holds an agent-filed hire request to the own-manager rule", async () => {
    const { forbidden } = await import("../errors.js");
    mockAgentManager.resolveActiveAgentManagerUserId.mockResolvedValue("manager-1");
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(async (_companyId: string, payload: unknown) => payload);
    mockAgentManager.assertAgentMayAssignManager.mockRejectedValue(
      forbidden("Agents may only assign their own manager as an agent's manager", { code: "agent_manager_assignment_not_allowed" }),
    );

    const res = await request(appFor({ ...agentActor, runId: null }))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "Helper", role: "general", reportsToUserId: "user-9" } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("agent_manager_assignment_not_allowed");
    expect(mockAgentManager.assertAgentMayAssignManager).toHaveBeenCalledWith(expect.anything(), "company-1", "agent-1", "user-9");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("holds a resubmitted hire payload to the own-manager rule", async () => {
    const { forbidden } = await import("../errors.js");
    mockApprovalService.getById.mockResolvedValue({
      ...pendingApproval(null),
      type: "hire_agent",
      status: "revision_requested",
      payload: { name: "Helper", role: "general" },
    });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(async (_companyId: string, payload: unknown) => payload);
    mockAgentManager.assertAgentMayAssignManager.mockRejectedValue(
      forbidden("Agents may only assign their own manager as an agent's manager", { code: "agent_manager_assignment_not_allowed" }),
    );

    const res = await request(appFor({ ...agentActor, runId: null }))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { name: "Helper", role: "general", reportsToUserId: "user-9" } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("agent_manager_assignment_not_allowed");
    expect(mockAgentManager.assertAgentMayAssignManager).toHaveBeenCalledWith(expect.anything(), "company-1", "agent-1", "user-9");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("runs the shared decision gate before approve, reject, and request-revision", async () => {
    const { forbidden } = await import("../errors.js");
    mockApprovalService.getById.mockResolvedValue(pendingApproval("manager-1"));
    mockAssertDecisionAllowed.mockRejectedValue(
      forbidden("Only Dana Operator can decide this approval.", { code: "approval_addressee_only" }),
    );
    const app = appFor(boardActor("user-2"));

    for (const path of ["approve", "reject", "request-revision"]) {
      const res = await request(app).post(`/api/approvals/approval-1/${path}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("approval_addressee_only");
      // The error handler forwards only `code` from details; the message
      // names the addressee so the UI can say who to ask.
      expect(res.body.error).toContain("Dana Operator");
    }
    expect(mockAssertDecisionAllowed).toHaveBeenCalledTimes(3);
    expect(mockAssertDecisionAllowed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "company-1", addresseeUserId: "manager-1" }),
      "user-2",
    );
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("proceeds when the gate allows", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval("manager-1"));
    mockApprovalService.reject.mockResolvedValue({ approval: { ...pendingApproval("manager-1"), status: "rejected" }, applied: true });

    const res = await request(appFor(boardActor("manager-1")))
      .post("/api/approvals/approval-1/reject")
      .send({});
    expect(res.status).toBe(200);
    expect(mockAssertDecisionAllowed).toHaveBeenCalledWith(expect.anything(), expect.anything(), "manager-1");
  });
});
