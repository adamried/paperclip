/**
 * Upgrade in place: enabling login keeps the operator (doc/DEPLOYMENT-MODES.md
 * section 8). Credentials attached by the CLI must be accepted by Better Auth's
 * normal email sign-in and resolve to the pre-upgrade operator user id.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  createDb,
  instanceSettings,
  instanceUserRoles,
} from "@paperclipai/db";
import { AGENT_SENTINEL_USER_ID } from "@paperclipai/shared";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  attachOperatorCredentials,
  CREDENTIAL_ACCOUNT_ISSUER,
  CREDENTIAL_PROVIDER_ID,
  inspectOperatorIdentity,
  legacyOperatorGuidance,
  OperatorCredentialError,
} from "../commands/operator-credentials.js";

// Each test starts its own cluster and runs every migration; the package
// default (15s) is sized for mocked suites.
vi.setConfig({ testTimeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, hookTimeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";

type Db = ReturnType<typeof createDb>;

async function seedDedicatedOperator(db: Db) {
  const operatorId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: operatorId,
    name: "Operator",
    email: "operator@test.paperclip.local",
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(authUsers).values({
    id: AGENT_SENTINEL_USER_ID,
    name: "Agent runtime",
    email: "local@paperclip.local",
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(instanceUserRoles).values({ userId: operatorId, role: "instance_admin" });
  // Migrations seed the singleton settings row; record the operator the way
  // startup does, merged into the existing general object.
  await db
    .insert(instanceSettings)
    .values({
      singletonKey: "default",
      general: { keyboardShortcuts: true, operatorUserId: operatorId },
      experimental: {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [instanceSettings.singletonKey],
      set: { general: { keyboardShortcuts: true, operatorUserId: operatorId }, updatedAt: now },
    });
  return operatorId;
}

/** The server's Better Auth mount, reduced to what sign-in needs. */
function createSignInHandler(db: Db) {
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: "operator-credentials-test-secret-operator-credentials",
    trustedOrigins: [ORIGIN],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    rateLimit: { enabled: false },
  });
  return async (email: string, password: string) => {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }),
    );
    const body = (await response.json().catch(() => null)) as { user?: { id?: string; email?: string } } | null;
    return { status: response.status, body };
  };
}

describeEmbeddedPostgres("operator credentials", () => {
  const databases: Array<Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>> = [];

  afterAll(async () => {
    await Promise.all(databases.map((database) => database.cleanup()));
  });

  it(
    "attaches a credential account the normal sign-in accepts, resolving to the same operator id",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-");
      databases.push(database);
      const db = createDb(database.connectionString);
      const operatorId = await seedDedicatedOperator(db);

      expect(await inspectOperatorIdentity(db)).toMatchObject({ kind: "dedicated", userId: operatorId, hasCredential: false });

      const result = await attachOperatorCredentials(db, { email: "  Founder@Example.com ", password: PASSWORD });
      expect(result).toEqual({ userId: operatorId, email: "founder@example.com", createdAccount: true });

      const accounts = await db.select().from(authAccounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        providerId: CREDENTIAL_PROVIDER_ID,
        accountId: operatorId,
        userId: operatorId,
      });
      expect(accounts[0]?.password).toBeTruthy();
      expect(accounts[0]?.password).not.toContain(PASSWORD);

      const operator = await db.select().from(authUsers).where(eq(authUsers.id, operatorId)).then((rows) => rows[0]);
      expect(operator).toMatchObject({ email: "founder@example.com", emailVerified: false });

      // The stored record and sibling settings survive the upgrade.
      const settings = await db.select().from(instanceSettings).then((rows) => rows[0]);
      expect(settings?.general).toEqual({ keyboardShortcuts: true, operatorUserId: operatorId });
      expect(await inspectOperatorIdentity(db)).toMatchObject({ kind: "dedicated", userId: operatorId, hasCredential: true });

      const signIn = createSignInHandler(db);
      const ok = await signIn("founder@example.com", PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.body?.user?.id).toBe(operatorId);
      expect(ok.body?.user?.email).toBe("founder@example.com");

      const wrong = await signIn("founder@example.com", "not-the-password");
      expect(wrong.status).toBe(401);

      // Re-running replaces the password on the same account instead of adding a second human.
      const replaced = await attachOperatorCredentials(db, { email: "founder@example.com", password: "another-long-password" });
      expect(replaced).toEqual({ userId: operatorId, email: "founder@example.com", createdAccount: false });
      expect(await db.select().from(authAccounts)).toHaveLength(1);
      expect(await db.select().from(authUsers).then((rows) => rows.length)).toBe(2);
      expect((await signIn("founder@example.com", "another-long-password")).body?.user?.id).toBe(operatorId);
      expect((await signIn("founder@example.com", PASSWORD)).status).toBe(401);
    },
  );

  it(
    "rejects an email another user already holds and a password outside Better Auth's bounds",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-dup-");
      databases.push(database);
      const db = createDb(database.connectionString);
      const operatorId = await seedDedicatedOperator(db);
      const now = new Date();
      await db.insert(authUsers).values({
        id: randomUUID(),
        name: "Teammate",
        email: "Taken@Example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });

      await expect(attachOperatorCredentials(db, { email: "taken@example.com", password: PASSWORD })).rejects.toMatchObject({
        name: "OperatorCredentialError",
        code: "email_in_use",
      });
      await expect(attachOperatorCredentials(db, { email: "ok@example.com", password: "short" })).rejects.toMatchObject({
        code: "weak_password",
      });
      await expect(attachOperatorCredentials(db, { email: "not-an-email", password: PASSWORD })).rejects.toMatchObject({
        code: "invalid_email",
      });

      // Nothing was written by the rejected attempts.
      expect(await db.select().from(authAccounts)).toHaveLength(0);
      const operator = await db.select().from(authUsers).where(eq(authUsers.id, operatorId)).then((rows) => rows[0]);
      expect(operator?.email).toBe("operator@test.paperclip.local");
    },
  );

  it(
    "refuses to attach credentials to the legacy sentinel and names the two migration paths",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-legacy-");
      databases.push(database);
      const db = createDb(database.connectionString);
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

      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "legacy", userId: AGENT_SENTINEL_USER_ID });

      let error: unknown;
      try {
        await attachOperatorCredentials(db, { email: "founder@example.com", password: PASSWORD });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(OperatorCredentialError);
      expect((error as OperatorCredentialError).code).toBe("legacy_operator");

      const sentinelAccounts = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, AGENT_SENTINEL_USER_ID), eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID)));
      expect(sentinelAccounts).toHaveLength(0);
      const sentinel = await db.select().from(authUsers).where(eq(authUsers.id, AGENT_SENTINEL_USER_ID)).then((rows) => rows[0]);
      expect(sentinel?.email).toBe("local@paperclip.local");

      const guidance = legacyOperatorGuidance().join("\n");
      expect(guidance).toContain("reconcile-identity");
      expect(guidance).toContain("board-claim");

      // With no operator recorded and no legacy admin there is nothing to attach to either.
      await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, AGENT_SENTINEL_USER_ID));
      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });
      await expect(attachOperatorCredentials(db, { email: "founder@example.com", password: PASSWORD })).rejects.toMatchObject({
        code: "no_operator",
      });
    },
  );
});
