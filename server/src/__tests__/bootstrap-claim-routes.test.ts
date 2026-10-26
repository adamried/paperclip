import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { accessRoutes } from "../routes/access.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";

const claimFirstInstanceAdminMock = vi.hoisted(() => vi.fn());
const boardClaimMock = vi.hoisted(() => ({
  claimBoardOwnership: vi.fn(),
  inspectBoardClaimChallenge: vi.fn(),
  isBoardClaimPending: vi.fn(),
}));
const listBoardMembersMock = vi.hoisted(() => vi.fn());
const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
}));

vi.mock("../first-admin-claim.js", () => ({
  claimFirstInstanceAdmin: claimFirstInstanceAdminMock,
}));

vi.mock("../board-claim.js", () => boardClaimMock);

vi.mock("../services/board-members.js", () => ({
  listBoardMembers: listBoardMembersMock,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createCliAuthChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createDb(invite?: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(invite ? [invite] : [])),
      })),
    })),
  } as any;
}

function createApp(input: {
  actor?: Record<string, unknown>;
  deploymentMode?: "authenticated" | "local_trusted";
  deploymentExposure?: "private" | "public";
  guardMutations?: boolean;
  db?: Record<string, unknown>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = input.actor ?? {
      type: "board",
      source: "session",
      userId: "user-1",
    };
    next();
  });
  if (input.guardMutations) {
    app.use(boardMutationGuard());
  }
  app.use(
    "/api",
    accessRoutes(input.db as any ?? createDb(), {
      deploymentMode: input.deploymentMode ?? "authenticated",
      deploymentExposure: input.deploymentExposure ?? "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /bootstrap/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimFirstInstanceAdminMock.mockResolvedValue({
      status: "claimed",
      userId: "user-1",
      value: null,
    });
  });

  it("claims first admin for an authenticated private browser session", async () => {
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true, userId: "user-1" });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(expect.anything(), { userId: "user-1" });
  });

  it("is not exposed in authenticated public mode", async () => {
    const app = createApp({ deploymentExposure: "public" });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("is not exposed in local trusted mode", async () => {
    const app = createApp({ deploymentMode: "local_trusted" });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "none", source: "none" }, "anonymous caller"],
    [{ type: "agent", source: "agent_key", agentId: "agent-1" }, "agent key"],
    [{ type: "board", source: "board_key", userId: "user-1" }, "board API key"],
    [{ type: "board", source: "local_implicit", userId: "local-board" }, "local implicit board"],
  ])("rejects %s before opening the first-admin transaction", async (actor) => {
    const app = createApp({ actor });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(401);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("returns conflict when first admin has already been claimed", async () => {
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });

  it("stays behind the board mutation origin guard", async () => {
    const app = createApp({ guardMutations: true });

    const blocked = await request(app).post("/api/bootstrap/claim").send({});
    expect(blocked.status).toBe(403);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();

    const allowed = await request(app)
      .post("/api/bootstrap/claim")
      .set("Host", "paperclip.local")
      .set("Origin", "http://paperclip.local")
      .send({});
    expect(allowed.status).toBe(200);
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrap invite first-admin acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createBootstrapInvite() {
    return {
      id: "invite-1",
      companyId: null,
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "human",
      tokenHash: hashToken("pcp_invite_test"),
      defaultsPayload: {},
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
  }

  it("uses the shared first-admin helper for bootstrap invite acceptance", async () => {
    const invite = createBootstrapInvite();
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "claimed",
      userId: "user-1",
      value: { ...invite, acceptedAt: new Date("2026-03-07T00:01:00.000Z") },
    });
    const app = createApp({ db: createDb(invite) });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      inviteId: "invite-1",
      inviteType: "bootstrap_ceo",
      bootstrapAccepted: true,
      userId: "user-1",
    });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", onClaim: expect.any(Function) }),
    );
  });

  it("conflicts cleanly when browser claim already won before invite acceptance", async () => {
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({ db: createDb(createBootstrapInvite()) });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });
});

describe("GET /board-claim/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardClaimMock.isBoardClaimPending.mockResolvedValue(true);
  });

  it("returns only the pending flag to a signed-in session actor", async () => {
    const res = await request(createApp({})).get("/api/board-claim/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: true });
    expect(Object.keys(res.body)).toEqual(["pending"]);
    expect(JSON.stringify(res.body)).not.toMatch(/token|code|url/i);
  });

  it("is not exposed in local trusted mode", async () => {
    const res = await request(createApp({ deploymentMode: "local_trusted" })).get("/api/board-claim/status");

    expect(res.status).toBe(404);
    expect(boardClaimMock.isBoardClaimPending).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "none", source: "none" }, "anonymous caller"],
    [{ type: "agent", source: "agent_key", agentId: "agent-1" }, "agent key"],
    [{ type: "board", source: "board_key", userId: "user-1" }, "board API key"],
    [{ type: "board", source: "local_implicit", userId: "local-board" }, "local implicit board"],
  ])("rejects %s", async (actor) => {
    const res = await request(createApp({ actor })).get("/api/board-claim/status");

    expect(res.status).toBe(401);
    expect(boardClaimMock.isBoardClaimPending).not.toHaveBeenCalled();
  });
});

describe("POST /board-claim/:token/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the winner with a reconciliation preview placeholder", async () => {
    boardClaimMock.claimBoardOwnership.mockResolvedValueOnce({
      status: "claimed",
      claimedByUserId: "user-1",
      reconciliationPreview: null,
    });

    const res = await request(createApp({})).post("/api/board-claim/tok/claim").send({ code: "c0de" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true, userId: "user-1", reconciliationPreview: null });
    expect(boardClaimMock.claimBoardOwnership).toHaveBeenCalledWith(expect.anything(), {
      token: "tok",
      code: "c0de",
      userId: "user-1",
    });
  });

  it("conflicts for the loser of a race and for an expired challenge", async () => {
    boardClaimMock.claimBoardOwnership.mockResolvedValueOnce({
      status: "already_claimed",
      claimedByUserId: "user-2",
      reconciliationPreview: null,
    });
    const lost = await request(createApp({})).post("/api/board-claim/tok/claim").send({ code: "c0de" });
    expect(lost.status).toBe(409);
    expect(lost.body.error).toContain("already been claimed");

    boardClaimMock.claimBoardOwnership.mockResolvedValueOnce({
      status: "expired",
      claimedByUserId: null,
      reconciliationPreview: null,
    });
    const expired = await request(createApp({})).post("/api/board-claim/tok/claim").send({ code: "c0de" });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toContain("paperclipai auth board-claim-url");
  });

  it("requires a signed-in browser session", async () => {
    const res = await request(createApp({ actor: { type: "board", source: "board_key", userId: "user-1" } }))
      .post("/api/board-claim/tok/claim")
      .send({ code: "c0de" });

    expect(res.status).toBe(401);
    expect(boardClaimMock.claimBoardOwnership).not.toHaveBeenCalled();
  });
});

describe("GET /admin/board", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBoardMembersMock.mockResolvedValue({
      members: [{ id: "user-1", name: "Dana", email: "dana@example.test", image: null, isOperator: null }],
      operatorUserId: null,
      legacySentinelHoldsAdmin: false,
    });
  });

  it("returns the Board to an instance admin", async () => {
    accessServiceMock.isInstanceAdmin.mockResolvedValue(true);

    const res = await request(createApp({})).get("/api/admin/board");

    expect(res.status).toBe(200);
    expect(res.body.members.map((member: { id: string }) => member.id)).toEqual(["user-1"]);
    expect(res.body.legacySentinelHoldsAdmin).toBe(false);
  });

  it("is forbidden for a signed-in non-admin", async () => {
    accessServiceMock.isInstanceAdmin.mockResolvedValue(false);

    const res = await request(createApp({})).get("/api/admin/board");

    expect(res.status).toBe(403);
    expect(listBoardMembersMock).not.toHaveBeenCalled();
  });

  it("refuses to seat the agent sentinel on the Board", async () => {
    accessServiceMock.isInstanceAdmin.mockResolvedValue(true);

    const res = await request(createApp({})).post("/api/admin/users/local-board/promote-instance-admin").send({});

    expect(res.status).toBe(409);
    expect(accessServiceMock.promoteInstanceAdmin).not.toHaveBeenCalled();
  });

  it("surfaces the last-member refusal from the access service as 409", async () => {
    accessServiceMock.isInstanceAdmin.mockResolvedValue(true);
    const { conflict } = await import("../errors.js");
    accessServiceMock.demoteInstanceAdmin.mockRejectedValueOnce(
      conflict("The Board must keep at least one member.", { code: "board_last_member" }),
    );

    const res = await request(createApp({})).post("/api/admin/users/user-1/demote-instance-admin").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("at least one member");
  });
});
