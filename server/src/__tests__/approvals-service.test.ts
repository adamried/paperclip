import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
  getById: vi.fn(async () => null),
  validateManagerPatch: vi.fn(async () => undefined),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.validateManagerPatch.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("validates a pending hire's manager fields before the approval flips to approved", async () => {
    const pendingAgent = { id: "agent-1", companyId: "company-1", status: "pending_approval" };
    mockAgentService.getById.mockResolvedValue(pendingAgent as never);
    mockAgentService.validateManagerPatch.mockRejectedValue(new Error("agent_manager_conflict"));
    const payload = { agentId: "agent-1", reportsTo: "ceo-1", reportsToUserId: "user-1" };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload }]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.approve("approval-1", "board", "ship it")).rejects.toThrow("agent_manager_conflict");

    expect(mockAgentService.validateManagerPatch).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      { reportsTo: "ceo-1", reportsToUserId: "user-1" },
      pendingAgent,
    );
    // The status never flipped, so the approval stays decidable.
    expect(dbStub.db.update).not.toHaveBeenCalled();
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });

  it("validates manager fields for a payload-only hire before the status flips", async () => {
    mockAgentService.validateManagerPatch.mockRejectedValue(new Error("agent_manager_not_eligible"));
    const payload = { name: "Helper", role: "general", reportsToUserId: "user-1" };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload }]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.approve("approval-1", "board", "ship it")).rejects.toThrow("agent_manager_not_eligible");

    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockAgentService.validateManagerPatch).toHaveBeenCalledWith("company-1", null, { reportsToUserId: "user-1" });
    expect(dbStub.db.update).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("skips manager validation when the payload's agent is not this approval's pending agent", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "other-company", status: "pending_approval" } as never);
    const approved = { ...createApproval("approved"), payload: { agentId: "agent-1", reportsToUserId: "user-1" } };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.validateManagerPatch).not.toHaveBeenCalled();
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});
