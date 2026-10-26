/**
 * Operator identity model (doc/DEPLOYMENT-MODES.md section 6).
 *
 * A fresh local_trusted instance gets a dedicated operator user; the agent
 * sentinel `local-board` exists only as a foreign-key target. A legacy instance
 * (sentinel still admin, nothing recorded) is classified and left byte-identical
 * across startup. Header-less local requests act as the operator, except an
 * agent run's header-less request (X-Paperclip-Run-Id) which stays under the
 * sentinel so comment attribution keeps deriving the agent from the run.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  instanceUserRoles,
  issues,
} from "@paperclipai/db";
import { AGENT_SENTINEL_USER_ID } from "@paperclipai/shared";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ensureOperatorIdentity,
  getOperatorIdentity,
  isLocalTrustedOperator,
  OPERATOR_USER_NAME,
  readRecordedOperatorUserId,
  resolveOperatorIdentity,
  setOperatorIdentity,
} from "../operator-identity.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "../routes/health.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// Each test starts its own cluster and runs every migration; the package
// default (15s) is sized for mocked suites.
vi.setConfig({ testTimeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, hookTimeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function countRows(db: Db) {
  const [users, roles, memberships, settings, issueRows] = await Promise.all([
    db.select({ n: count() }).from(authUsers).then((rows) => Number(rows[0]?.n ?? 0)),
    db.select({ n: count() }).from(instanceUserRoles).then((rows) => Number(rows[0]?.n ?? 0)),
    db.select({ n: count() }).from(companyMemberships).then((rows) => Number(rows[0]?.n ?? 0)),
    db.select({ n: count() }).from(instanceSettings).then((rows) => Number(rows[0]?.n ?? 0)),
    db.select({ n: count() }).from(issues).then((rows) => Number(rows[0]?.n ?? 0)),
  ]);
  return { users, roles, memberships, settings, issueRows };
}

async function insertCompany(db: Db, name: string) {
  const id = randomUUID();
  await db.insert(companies).values({
    id,
    name,
    issuePrefix: name.slice(0, 3).toUpperCase(),
    requireBoardApprovalForNewAgents: false,
  });
  return id;
}

function createLocalApp(db: Db) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "local_trusted", resolveSession: async () => null }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.use(
    "/api/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      runtimeEnv: {},
    }),
  );
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("operator identity", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  afterEach(() => {
    setOperatorIdentity(null);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it(
    "creates a dedicated operator on a fresh local instance and keeps the sentinel grant-free",
    async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-fresh-");
      const db = createDb(tempDb.connectionString);
      const companyId = await insertCompany(db, "Fresh");

      const first = await ensureOperatorIdentity(db, { deploymentMode: "local_trusted", instanceId: "test-inst" });
      expect(first.kind).toBe("dedicated");
      expect(first.created).toBe(true);
      expect(first.userId).toBeTruthy();
      expect(first.userId).not.toBe(AGENT_SENTINEL_USER_ID);
      expect(first.userName).toBe(OPERATOR_USER_NAME);
      expect(first.userEmail).toBe("operator@test-inst.paperclip.local");

      const operatorId = first.userId!;
      expect(await readRecordedOperatorUserId(db)).toBe(operatorId);
      expect(getOperatorIdentity()).toMatchObject({ kind: "dedicated", userId: operatorId });
      expect(isLocalTrustedOperator(operatorId)).toBe(true);
      expect(isLocalTrustedOperator(AGENT_SENTINEL_USER_ID)).toBe(false);

      // The operator holds exactly what the sentinel used to receive.
      const roles = await db.select().from(instanceUserRoles);
      expect(roles.map((row) => [row.userId, row.role])).toEqual([[operatorId, "instance_admin"]]);
      const memberships = await db.select().from(companyMemberships);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        companyId,
        principalType: "user",
        principalId: operatorId,
        membershipRole: "owner",
        status: "active",
      });

      // The sentinel exists as a row and nothing more.
      const sentinel = await db.select().from(authUsers).where(eq(authUsers.id, AGENT_SENTINEL_USER_ID));
      expect(sentinel).toHaveLength(1);
      expect(roles.some((row) => row.userId === AGENT_SENTINEL_USER_ID)).toBe(false);
      expect(memberships.some((row) => row.principalId === AGENT_SENTINEL_USER_ID)).toBe(false);

      // The record is server-managed metadata, not a general setting.
      const general = await instanceSettingsService(db).getGeneral();
      expect(Object.prototype.hasOwnProperty.call(general, "operatorUserId")).toBe(false);
      // ...and a general-settings write does not drop it.
      await instanceSettingsService(db).updateGeneral({ keyboardShortcuts: true });
      expect(await readRecordedOperatorUserId(db)).toBe(operatorId);

      // A second start only re-asserts grants for a company created since.
      const secondCompanyId = await insertCompany(db, "Later");
      const before = await countRows(db);
      const second = await ensureOperatorIdentity(db, { deploymentMode: "local_trusted", instanceId: "test-inst" });
      expect(second).toMatchObject({ kind: "dedicated", userId: operatorId, created: false });
      const after = await countRows(db);
      expect(after).toEqual({ ...before, memberships: before.memberships + 1 });
      const laterMembership = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.companyId, secondCompanyId));
      expect(laterMembership.map((row) => row.principalId)).toEqual([operatorId]);

      // Header-less local requests act as the operator...
      const app = createLocalApp(db);
      const operatorActor = await request(app).get("/actor");
      expect(operatorActor.status).toBe(200);
      expect(operatorActor.body).toMatchObject({
        type: "board",
        source: "local_implicit",
        userId: operatorId,
        userName: OPERATOR_USER_NAME,
        isInstanceAdmin: true,
      });
      // ...while an agent run's header-less request stays under the sentinel.
      const runId = randomUUID();
      const runActor = await request(app).get("/actor").set("X-Paperclip-Run-Id", runId);
      expect(runActor.body).toMatchObject({
        type: "board",
        source: "local_implicit",
        userId: AGENT_SENTINEL_USER_ID,
        runId,
      });

      const health = await request(app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body.operatorIdentity).toBe("dedicated");
      expect(health.body.bootstrapStatus).toBe("ready");

      // Zero operational rows reference the sentinel.
      const sentinelRoles = await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, AGENT_SENTINEL_USER_ID));
      const sentinelMemberships = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.principalId, AGENT_SENTINEL_USER_ID));
      expect(sentinelRoles).toHaveLength(0);
      expect(sentinelMemberships).toHaveLength(0);

      // Enabling login later classifies the same instance as dedicated without writing.
      const authenticated = await resolveOperatorIdentity(db, { deploymentMode: "authenticated" });
      expect(authenticated).toMatchObject({ kind: "dedicated", userId: operatorId, deploymentMode: "authenticated" });

      await tempDb.cleanup();
      tempDb = null;
    },
  );

  it(
    "leaves a legacy instance byte-identical and reports it as legacy",
    async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-legacy-");
      const db = createDb(tempDb.connectionString);

      // The shape `ensureLocalTrustedBoardPrincipal` produced before dedicated
      // operators existed: the sentinel is a real admin with owner memberships
      // and operational references, and nothing is recorded in settings.
      const now = new Date();
      await db.insert(authUsers).values({
        id: AGENT_SENTINEL_USER_ID,
        name: "Board",
        email: "local@paperclip.local",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(instanceUserRoles).values({ userId: AGENT_SENTINEL_USER_ID, role: "instance_admin" });
      const companyId = await insertCompany(db, "Legacy");
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: AGENT_SENTINEL_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: "Assigned to the legacy operator",
        status: "todo",
        priority: "medium",
        assigneeUserId: AGENT_SENTINEL_USER_ID,
      });

      const before = await countRows(db);
      const usersBefore = await db.select().from(authUsers);

      const identity = await ensureOperatorIdentity(db, { deploymentMode: "local_trusted", instanceId: "legacy-inst" });
      expect(identity).toMatchObject({
        kind: "legacy",
        userId: AGENT_SENTINEL_USER_ID,
        userName: "Board",
        created: false,
      });

      const after = await countRows(db);
      expect(after).toEqual(before);
      expect(await db.select().from(authUsers)).toEqual(usersBefore);
      expect(await readRecordedOperatorUserId(db)).toBeNull();
      expect(isLocalTrustedOperator(AGENT_SENTINEL_USER_ID)).toBe(true);

      const app = createLocalApp(db);
      const actor = await request(app).get("/actor");
      expect(actor.body).toMatchObject({ type: "board", source: "local_implicit", userId: AGENT_SENTINEL_USER_ID });

      const health = await request(app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body.operatorIdentity).toBe("legacy");

      // Running the same instance in authenticated mode is still read-only.
      const authenticated = await ensureOperatorIdentity(db, { deploymentMode: "authenticated", instanceId: "legacy-inst" });
      expect(authenticated.kind).toBe("legacy");
      expect(await countRows(db)).toEqual(before);

      await tempDb.cleanup();
      tempDb = null;
    },
  );

  it(
    "reports no operator for a fresh authenticated install and writes nothing",
    async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-none-");
      const db = createDb(tempDb.connectionString);
      const before = await countRows(db);

      const identity = await ensureOperatorIdentity(db, { deploymentMode: "authenticated", instanceId: "auth-inst" });
      expect(identity).toMatchObject({ kind: "none", userId: null, created: false });
      expect(await countRows(db)).toEqual(before);

      await tempDb.cleanup();
      tempDb = null;
    },
  );
});
