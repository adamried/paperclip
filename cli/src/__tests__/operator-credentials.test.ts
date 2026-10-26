/**
 * Upgrade in place: enabling login keeps the operator (doc/DEPLOYMENT-MODES.md
 * section 8). Credentials attached by the CLI must be accepted by Better Auth's
 * normal email sign-in and resolve to the pre-upgrade operator user id. On a
 * fresh authenticated install (no operator, no instance admin) the same command
 * creates the operator as the first admin, serialized against the server's
 * first-admin transaction.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  companies,
  companyMemberships,
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
  adminExistsGuidance,
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

/** A sibling setting an operator saved before the first admin existed. */
async function seedUnrelatedGeneralSetting(db: Db) {
  const now = new Date();
  await db
    .insert(instanceSettings)
    .values({ singletonKey: "default", general: { keyboardShortcuts: true }, experimental: {}, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [instanceSettings.singletonKey],
      set: { general: { keyboardShortcuts: true }, updatedAt: now },
    });
}

/** The account a browser claim or bootstrap invite promotes to first admin. */
async function seedClaimedAdmin(db: Db, email = "claimer@example.com") {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: "Claimer",
    email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  return userId;
}

async function countInstanceAdmins(db: Db) {
  return db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"))
    .then((rows) => rows.length);
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
      expect(result).toEqual({ userId: operatorId, email: "founder@example.com", createdAccount: true, createdOperator: false });

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
      expect(replaced).toEqual({ userId: operatorId, email: "founder@example.com", createdAccount: false, createdOperator: false });
      expect(await db.select().from(authAccounts)).toHaveLength(1);
      expect(await db.select().from(authUsers).then((rows) => rows.length)).toBe(2);
      expect((await signIn("founder@example.com", "another-long-password")).body?.user?.id).toBe(operatorId);
      expect((await signIn("founder@example.com", PASSWORD)).status).toBe(401);
    },
  );

  it(
    "creates the operator as the first admin on a fresh authenticated install, with the same grants local_trusted startup gives",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-fresh-");
      databases.push(database);
      const db = createDb(database.connectionString);
      await seedUnrelatedGeneralSetting(db);
      const [acme, beta] = await db
        .insert(companies)
        .values([{ name: "Acme Robotics", issuePrefix: "ACME" }, { name: "Beta Labs", issuePrefix: "BETA" }])
        .returning({ id: companies.id });

      // Nothing recorded, no sentinel admin, no instance_admin at all: bootstrap_pending.
      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });
      expect(await countInstanceAdmins(db)).toBe(0);

      const result = await attachOperatorCredentials(db, { email: "Founder@Example.com", password: PASSWORD, name: "Ada" });
      expect(result).toMatchObject({ email: "founder@example.com", createdAccount: true, createdOperator: true });
      const operatorId = result.userId;
      expect(operatorId).toMatch(/^[0-9a-f-]{36}$/);

      // 1. the user row
      const operator = await db.select().from(authUsers).where(eq(authUsers.id, operatorId)).then((rows) => rows[0]);
      expect(operator).toMatchObject({ name: "Ada", email: "founder@example.com", emailVerified: false });

      // 2. instance_admin, and only this one
      const admins = await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
      expect(admins.map((row) => row.userId)).toEqual([operatorId]);

      // 3. active owner membership in every existing company
      const memberships = await db
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, operatorId)));
      expect(memberships.map((row) => [row.companyId, row.status, row.membershipRole]).sort()).toEqual(
        [
          [acme!.id, "active", "owner"],
          [beta!.id, "active", "owner"],
        ].sort(),
      );

      // 4. recorded, merged into the existing general object
      const settings = await db.select().from(instanceSettings);
      expect(settings).toHaveLength(1);
      expect(settings[0]?.general).toEqual({ keyboardShortcuts: true, operatorUserId: operatorId });
      expect(await inspectOperatorIdentity(db)).toMatchObject({
        kind: "dedicated",
        userId: operatorId,
        email: "founder@example.com",
        hasCredential: true,
      });

      // 5. the credential account, accepted by the normal sign-in with the operator's id
      const accounts = await db.select().from(authAccounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        providerId: CREDENTIAL_PROVIDER_ID,
        accountId: operatorId,
        userId: operatorId,
      });
      const signIn = createSignInHandler(db);
      const ok = await signIn("founder@example.com", PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.body?.user?.id).toBe(operatorId);

      // Re-running replaces the password on the same account; no second human, no second admin.
      const usersBefore = await db.select().from(authUsers).then((rows) => rows.length);
      const replaced = await attachOperatorCredentials(db, { email: "founder@example.com", password: "another-long-password" });
      expect(replaced).toEqual({ userId: operatorId, email: "founder@example.com", createdAccount: false, createdOperator: false });
      expect(await db.select().from(authUsers).then((rows) => rows.length)).toBe(usersBefore);
      expect(await db.select().from(authAccounts)).toHaveLength(1);
      expect(await countInstanceAdmins(db)).toBe(1);
      expect((await signIn("founder@example.com", "another-long-password")).body?.user?.id).toBe(operatorId);
      expect((await signIn("founder@example.com", PASSWORD)).status).toBe(401);

      // A later claim-style check (the server's first-admin transaction) finds the admin and stands down.
      const claimSees = await db.transaction(async (tx) => {
        await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
        return tx
          .select({ userId: instanceUserRoles.userId })
          .from(instanceUserRoles)
          .where(eq(instanceUserRoles.role, "instance_admin"))
          .then((rows) => rows[0]?.userId ?? null);
      });
      expect(claimSees).toBe(operatorId);
    },
  );

  it(
    "creates the operator without a settings row and without companies, using the default name",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-bare-");
      databases.push(database);
      const db = createDb(database.connectionString);
      await db.delete(instanceSettings);

      const result = await attachOperatorCredentials(db, { email: "solo@example.com", password: PASSWORD });
      expect(result).toMatchObject({ createdOperator: true, createdAccount: true });
      const operator = await db.select().from(authUsers).where(eq(authUsers.id, result.userId)).then((rows) => rows[0]);
      expect(operator?.name).toBe("Operator");
      const settings = await db.select().from(instanceSettings);
      expect(settings).toHaveLength(1);
      expect(settings[0]).toMatchObject({ singletonKey: "default", general: { operatorUserId: result.userId } });
      expect(await db.select().from(companyMemberships)).toHaveLength(0);
    },
  );

  it(
    "refuses to create a second human when a browser claim or bootstrap invite already made an admin",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-claimed-");
      databases.push(database);
      const db = createDb(database.connectionString);
      await seedUnrelatedGeneralSetting(db);
      const claimerId = await seedClaimedAdmin(db);
      const usersBefore = await db.select().from(authUsers).then((rows) => rows.length);

      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });

      let error: unknown;
      try {
        await attachOperatorCredentials(db, { email: "founder@example.com", password: PASSWORD });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(OperatorCredentialError);
      expect(error as OperatorCredentialError).toMatchObject({
        code: "admin_exists",
        existingAdmin: { userId: claimerId, email: "claimer@example.com" },
      });
      expect((error as OperatorCredentialError).message).toContain("claimer@example.com");
      expect((error as OperatorCredentialError).message).toContain("reconcile-identity");

      // Nothing was written: no operator, no credential, no record, one admin.
      expect(await db.select().from(authUsers).then((rows) => rows.length)).toBe(usersBefore);
      expect(await db.select().from(authAccounts)).toHaveLength(0);
      expect(await countInstanceAdmins(db)).toBe(1);
      expect(await db.select().from(instanceSettings).then((rows) => rows[0]?.general)).toEqual({ keyboardShortcuts: true });
      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });

      const guidance = adminExistsGuidance((error as OperatorCredentialError).existingAdmin).join("\n");
      expect(guidance).toContain("claimer@example.com");
      expect(guidance).toContain("Sign in as that account");
      expect(guidance).toContain("reconcile-identity");
    },
  );

  it(
    "waits for the server's first-admin transaction and then refuses, so two paths never both create an admin",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-operator-credentials-race-");
      databases.push(database);
      const cliDb = createDb(database.connectionString);
      const serverDb = createDb(database.connectionString);
      const claimerId = randomUUID();

      // The browser claim / bootstrap invite path (`claimFirstInstanceAdmin`):
      // lock, see no admin, insert the admin, and hold the transaction open.
      let releaseClaim!: () => void;
      const claimReleased = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimLocked!: () => void;
      const claimHoldsLock = new Promise<void>((resolve) => {
        claimLocked = resolve;
      });
      const claim = serverDb.transaction(async (tx) => {
        await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
        const existing = await tx
          .select({ userId: instanceUserRoles.userId })
          .from(instanceUserRoles)
          .where(eq(instanceUserRoles.role, "instance_admin"));
        expect(existing).toHaveLength(0);
        const now = new Date();
        await tx.insert(authUsers).values({
          id: claimerId,
          name: "Claimer",
          email: "claimer@example.com",
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(instanceUserRoles).values({ userId: claimerId, role: "instance_admin" });
        claimLocked();
        await claimReleased;
      });
      await claimHoldsLock;

      // The CLI saw `none` before the lock was taken and must now wait on it.
      const attach = attachOperatorCredentials(cliDb, { email: "founder@example.com", password: PASSWORD });
      const outcome = await Promise.race([
        attach.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 750)),
      ]);
      expect(outcome).toBe("blocked");

      releaseClaim();
      await claim;
      await expect(attach).rejects.toMatchObject({
        name: "OperatorCredentialError",
        code: "admin_exists",
        existingAdmin: { userId: claimerId, email: "claimer@example.com" },
      });

      const admins = await cliDb.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
      expect(admins.map((row) => row.userId)).toEqual([claimerId]);
      expect(await cliDb.select().from(authAccounts)).toHaveLength(0);
      expect(await inspectOperatorIdentity(cliDb)).toEqual({ kind: "none" });
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

      // The fresh-install path applies the same email check before creating anything.
      await db.delete(instanceUserRoles);
      await db.update(instanceSettings).set({ general: {} });
      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });
      await expect(attachOperatorCredentials(db, { email: "taken@example.com", password: PASSWORD })).rejects.toMatchObject({
        code: "email_in_use",
      });
      expect(await countInstanceAdmins(db)).toBe(0);
      expect(await db.select().from(instanceSettings).then((rows) => rows[0]?.general)).toEqual({});
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

      // A sentinel row without instance_admin is not legacy: with nothing else
      // recorded this is a fresh install, and the operator is created next to
      // the sentinel, never on it.
      await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, AGENT_SENTINEL_USER_ID));
      expect(await inspectOperatorIdentity(db)).toEqual({ kind: "none" });
      const created = await attachOperatorCredentials(db, { email: "founder@example.com", password: PASSWORD });
      expect(created).toMatchObject({ createdOperator: true, createdAccount: true });
      expect(created.userId).not.toBe(AGENT_SENTINEL_USER_ID);
      const admins = await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
      expect(admins.map((row) => row.userId)).toEqual([created.userId]);
      expect(
        await db
          .select()
          .from(authAccounts)
          .where(eq(authAccounts.userId, AGENT_SENTINEL_USER_ID)),
      ).toHaveLength(0);
    },
  );
});
