import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  userApprovalDecisionPolicies,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { approvalDecisionPolicyRoutes } from "../routes/approval-decision-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("approval decision policy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-decision-policy-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(userApprovalDecisionPolicies);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(approvalDecisionPolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Policy ${companyId}`,
      issuePrefix: `AP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values([
      { id: userId, name: "User", email: `${userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now },
      { id: otherUserId, name: "Other", email: `${otherUserId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId, principalType: "user", principalId: otherUserId, membershipRole: "operator", status: "active" },
    ]);
    return { companyId, userId, otherUserId };
  }

  const boardActor = (companyId: string, userId: string): Express.Request["actor"] => ({
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
  } as unknown as Express.Request["actor"]);

  it("reads the default and round-trips the addressee-only policy for the current user", async () => {
    const { companyId, userId } = await seed();
    const app = appFor(boardActor(companyId, userId));

    const initial = await request(app).get(`/companies/${companyId}/users/me/approval-decision-policy`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ policy: "any_board", materialized: false, userId });

    const updated = await request(app)
      .put(`/companies/${companyId}/users/me/approval-decision-policy`)
      .send({ policy: "addressee_only" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ policy: "addressee_only", materialized: true });

    const reread = await request(app).get(`/companies/${companyId}/users/me/approval-decision-policy`);
    expect(reread.body.policy).toBe("addressee_only");

    const activity = await db.select().from(activityLog);
    expect(activity.some((row) => row.action === "approval.decision_policy_updated")).toBe(true);
  });

  it("rejects an unknown policy and refuses non-admins editing someone else", async () => {
    const { companyId, userId, otherUserId } = await seed();
    const app = appFor(boardActor(companyId, userId));

    const invalid = await request(app)
      .put(`/companies/${companyId}/users/me/approval-decision-policy`)
      .send({ policy: "everyone" });
    expect(invalid.status).toBe(400);

    const forbidden = await request(app)
      .put(`/companies/${companyId}/users/${otherUserId}/approval-decision-policy`)
      .send({ policy: "addressee_only" });
    expect(forbidden.status).toBe(403);
  });
});
