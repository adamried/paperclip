/**
 * Spec 4 (doc/plans/2026-10-26-operator-identity-and-board-ownership.md):
 * account profile and email management.
 *
 * Two paths change an account's email and both must keep the user id stable:
 *
 * - self-service through Better Auth's `/api/auth/change-email`, enabled in
 *   `createBetterAuthInstance` with the immediate (no mail transport) path;
 * - `PATCH /api/admin/users/:userId`, for instance admins editing another
 *   user's name or email.
 *
 * Driven through the real Better Auth mount against the real Drizzle schema on
 * a disposable embedded Postgres, because the behaviour under test (sign-in by
 * the new address, sessions still resolving) lives in Better Auth's own tables.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
} from "../auth/better-auth.js";
import type { Config } from "../config.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";
// The actor-injection header this suite uses in place of the real actor
// middleware; the access router only reads `req.actor`.
const TEST_USER_HEADER = "x-test-user-id";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]!).join("; ");
}

describeEmbeddedPostgres("account email management", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  async function signUp(email: string, name: string) {
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD, name });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { id: res.body.user.id as string, email, cookie: cookieHeader(res) };
  }

  async function signIn(email: string) {
    return request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD });
  }

  async function sessionFor(cookie: string) {
    return request(app).get("/api/auth/get-session").set("origin", ORIGIN).set("cookie", cookie);
  }

  async function makeInstanceAdmin(userId: string) {
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  }

  function adminPatch(actorUserId: string, targetUserId: string, body: Record<string, unknown>) {
    return request(app)
      .patch(`/api/admin/users/${targetUserId}`)
      .set(TEST_USER_HEADER, actorUserId)
      .send(body);
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-account-email-tests";
    // The rate limiter is on by default in `authenticated` mode and would score
    // the back-to-back sign-ups and sign-ins this suite issues.
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-account-email-");
    db = createDb(database.connectionString);

    const [{ accessRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/access.js"),
      import("../middleware/index.js"),
    ]);
    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);

    app = express();
    // Better Auth reads the raw body itself, so it is mounted ahead of the
    // JSON parser, exactly as `createApp` orders it.
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header(TEST_USER_HEADER);
      req.actor = userId
        ? ({
            type: "board",
            userId,
            source: "session",
            companyIds: [],
            memberships: [],
          } as Express.Request["actor"])
        : ({ type: "none" } as Express.Request["actor"]);
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: ["127.0.0.1"],
      }),
    );
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  describe("self-service through Better Auth", () => {
    it("changes the email immediately, keeps the user id, and signs in with the new address", async () => {
      const oldEmail = `operator-${randomUUID()}@example.com`;
      const newEmail = `moved-${randomUUID()}@example.com`;
      const account = await signUp(oldEmail, "Operator");

      const change = await request(app)
        .post("/api/auth/change-email")
        .set("origin", ORIGIN)
        .set("cookie", account.cookie)
        .send({ newEmail });
      expect(change.status, JSON.stringify(change.body)).toBe(200);
      expect(change.body).toMatchObject({ status: true });

      const row = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, account.id))
        .then((rows) => rows[0]);
      expect(row).toBeDefined();
      expect(row!.email).toBe(newEmail);
      // No mail transport exists, so nothing could have verified the address.
      expect(row!.emailVerified).toBe(false);

      // The existing session keeps resolving to the same account.
      const session = await sessionFor(account.cookie);
      expect(session.status).toBe(200);
      expect(session.body.user.id).toBe(account.id);
      expect(session.body.user.email).toBe(newEmail);

      const signInNew = await signIn(newEmail);
      expect(signInNew.status, JSON.stringify(signInNew.body)).toBe(200);
      expect(signInNew.body.user.id).toBe(account.id);

      const signInOld = await signIn(oldEmail);
      expect(signInOld.status).toBe(401);
    }, 30_000);

    it("leaves the account untouched when the new address already belongs to someone else", async () => {
      const taken = await signUp(`taken-${randomUUID()}@example.com`, "Taken");
      const account = await signUp(`mover-${randomUUID()}@example.com`, "Mover");

      // Better Auth deliberately answers 200 here so the endpoint cannot be
      // used to enumerate accounts; the UI re-reads the session to notice that
      // the address did not move.
      const change = await request(app)
        .post("/api/auth/change-email")
        .set("origin", ORIGIN)
        .set("cookie", account.cookie)
        .send({ newEmail: taken.email });
      expect(change.status, JSON.stringify(change.body)).toBe(200);

      const session = await sessionFor(account.cookie);
      expect(session.body.user.id).toBe(account.id);
      expect(session.body.user.email).toBe(account.email);
    }, 30_000);
  });

  describe("PATCH /api/admin/users/:userId", () => {
    it("lets an instance admin change another user's name and email while that user's session keeps its id", async () => {
      const admin = await signUp(`admin-${randomUUID()}@example.com`, "Admin");
      await makeInstanceAdmin(admin.id);
      const target = await signUp(`member-${randomUUID()}@example.com`, "Member");
      const company = await db
        .insert(companies)
        .values({
          name: `Account Email ${randomUUID()}`,
          issuePrefix: `AE${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        })
        .returning()
        .then((rows) => rows[0]!);

      const newEmail = `Renamed-${randomUUID()}@Example.com`;
      const res = await adminPatch(admin.id, target.id, { name: "Renamed Member", email: newEmail });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id: target.id,
        name: "Renamed Member",
        email: newEmail.toLowerCase(),
        isInstanceAdmin: false,
        activeCompanyMembershipCount: 0,
      });

      const row = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, target.id))
        .then((rows) => rows[0]!);
      expect(row.email).toBe(newEmail.toLowerCase());
      expect(row.emailVerified).toBe(false);

      // The target's existing browser session is untouched and still names
      // the same user id.
      const session = await sessionFor(target.cookie);
      expect(session.status).toBe(200);
      expect(session.body.user.id).toBe(target.id);
      expect(session.body.user.email).toBe(newEmail.toLowerCase());

      // The new address signs in; the old one no longer does.
      const signInNew = await signIn(newEmail.toLowerCase());
      expect(signInNew.status, JSON.stringify(signInNew.body)).toBe(200);
      expect(signInNew.body.user.id).toBe(target.id);
      expect((await signIn(target.email)).status).toBe(401);

      // Instance-level audit: one row per company, attributed to the admin.
      const audit = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, target.id));
      expect(audit.some((row) => row.companyId === company.id)).toBe(true);
      for (const row of audit) {
        expect(row).toMatchObject({
          action: "admin_user.profile_updated",
          actorType: "user",
          actorId: admin.id,
          entityType: "user",
        });
        expect(row.details).toMatchObject({
          changedFields: ["name", "email"],
          email: newEmail.toLowerCase(),
          previousEmail: target.email,
        });
      }
    }, 30_000);

    it("returns 409 when the email is already in use, regardless of case", async () => {
      const admin = await signUp(`admin-${randomUUID()}@example.com`, "Admin");
      await makeInstanceAdmin(admin.id);
      const occupant = await signUp(`occupant-${randomUUID()}@example.com`, "Occupant");
      const target = await signUp(`target-${randomUUID()}@example.com`, "Target");

      const res = await adminPatch(admin.id, target.id, { email: occupant.email.toUpperCase() });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "email_in_use" });

      const row = await db
        .select({ email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, target.id))
        .then((rows) => rows[0]!);
      expect(row.email).toBe(target.email);
    }, 30_000);

    it("rejects a non-admin with 403", async () => {
      const bystander = await signUp(`bystander-${randomUUID()}@example.com`, "Bystander");
      const target = await signUp(`target-${randomUUID()}@example.com`, "Target");

      const res = await adminPatch(bystander.id, target.id, { name: "Hijacked" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);

      const row = await db
        .select({ name: authUsers.name })
        .from(authUsers)
        .where(eq(authUsers.id, target.id))
        .then((rows) => rows[0]!);
      expect(row.name).toBe("Target");
    }, 30_000);

    it("refuses an admin's own email change and points at self-service, but allows their own rename", async () => {
      const admin = await signUp(`admin-${randomUUID()}@example.com`, "Admin");
      await makeInstanceAdmin(admin.id);

      const emailRes = await adminPatch(admin.id, admin.id, {
        email: `elsewhere-${randomUUID()}@example.com`,
      });
      expect(emailRes.status, JSON.stringify(emailRes.body)).toBe(403);
      expect(emailRes.body.details).toMatchObject({ code: "self_email_change_not_allowed" });

      const nameRes = await adminPatch(admin.id, admin.id, { name: "Admin Renamed" });
      expect(nameRes.status, JSON.stringify(nameRes.body)).toBe(200);
      expect(nameRes.body).toMatchObject({
        id: admin.id,
        name: "Admin Renamed",
        email: admin.email,
        isInstanceAdmin: true,
      });
    }, 30_000);

    it("returns 404 for an unknown user and 400 for an empty patch", async () => {
      const admin = await signUp(`admin-${randomUUID()}@example.com`, "Admin");
      await makeInstanceAdmin(admin.id);

      const missing = await adminPatch(admin.id, `missing-${randomUUID()}`, { name: "Nobody" });
      expect(missing.status, JSON.stringify(missing.body)).toBe(404);

      const empty = await adminPatch(admin.id, admin.id, {});
      expect(empty.status, JSON.stringify(empty.body)).toBe(400);
    }, 30_000);
  });
});
