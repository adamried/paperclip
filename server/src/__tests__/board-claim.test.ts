import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import { BOARD_CLAIM_CHALLENGE_SETTINGS_KEY, readBoardClaimChallengeRecord } from "@paperclipai/shared";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
  inspectBoardClaimChallenge,
  isBoardClaimPending,
  issueBoardClaimChallenge,
} from "../board-claim.js";
import { accessService } from "../services/access.js";
import { describeBoardAddressee, listBoardMembers } from "../services/board-members.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function parseClaimUrl(url: string) {
  const parsed = new URL(url);
  return {
    token: parsed.pathname.split("/").pop()!,
    code: parsed.searchParams.get("code")!,
  };
}

describeEmbeddedPostgres("board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function createUser(name: string) {
    const now = new Date();
    const userId = `claim-user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  async function seedLegacyInstance() {
    const company = await db
      .insert(companies)
      .values({
        name: "Board Claim Co",
        issuePrefix: `BC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });
    return company;
  }

  async function adminRows(userId: string) {
    return db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  }

  async function persistedRecord() {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .then((rows) => rows[0] ?? null);
    return { raw: row?.general ?? null, record: readBoardClaimChallengeRecord(row?.general) };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lets a signed-in user claim a local-board-only authenticated instance", async () => {
    const company = await seedLegacyInstance();
    const userId = await createUser("Board Claim User");

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect(await isBoardClaimPending(db)).toBe(true);
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();
    const { token, code } = parseClaimUrl(warningUrl!);

    await expect(inspectBoardClaimChallenge(db, token, code)).resolves.toMatchObject({
      status: "available",
      requiresSignIn: true,
      claimedByUserId: null,
    });

    await expect(claimBoardOwnership(db, { token, code, userId })).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userId,
      reconciliationPreview: null,
    });

    await expect(adminRows("local-board")).resolves.toHaveLength(0);
    await expect(adminRows(userId)).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([{ status: "active", membershipRole: "owner" }]);
    await expect(inspectBoardClaimChallenge(db, token, code)).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
    expect(await isBoardClaimPending(db)).toBe(false);
    // The process forgets the plaintext once the challenge is spent.
    expect(getBoardClaimWarningUrl("127.0.0.1", 3197)).toBeNull();
  });

  it("persists only hashes and never the plaintext token or code", async () => {
    await seedLegacyInstance();
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const { token, code } = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);

    const { raw, record } = await persistedRecord();
    expect(record).not.toBeNull();
    expect(record!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(code);
  });

  it("gives exactly one winner when two valid claims race", async () => {
    await seedLegacyInstance();
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const { token, code } = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);

    const [first, second] = await Promise.all([
      claimBoardOwnership(db, { token, code, userId: alice }),
      claimBoardOwnership(db, { token, code, userId: bob }),
    ]);

    const results = [first, second];
    const winners = results.filter((result) => result.status === "claimed");
    const losers = results.filter((result) => result.status === "already_claimed");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winnerId = winners[0]!.claimedByUserId!;
    expect([alice, bob]).toContain(winnerId);
    expect(losers[0]!.claimedByUserId).toBe(winnerId);

    const admins = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    expect(admins.map((row) => row.userId)).toEqual([winnerId]);
    const { record } = await persistedRecord();
    expect(record?.claimedByUserId).toBe(winnerId);
  });

  it("keeps the same URL working across a restart between issue and claim", async () => {
    await seedLegacyInstance();
    const userId = await createUser("Restart User");
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const { token, code } = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    const before = (await persistedRecord()).record!;

    // Simulate a restart: in-process state is dropped, then the server boots
    // again against the persisted settings.
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    expect(getBoardClaimWarningUrl("127.0.0.1", 3197)).toBeNull();
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });

    const after = (await persistedRecord()).record!;
    expect(after.tokenHash).toBe(before.tokenHash);
    // The restarted process does not know the plaintext, so it prints no URL...
    expect(getBoardClaimWarningUrl("127.0.0.1", 3197)).toBeNull();
    // ...but the previously issued link still claims.
    await expect(claimBoardOwnership(db, { token, code, userId })).resolves.toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
  });

  it("reports an expired challenge and lets a fresh issue replace it", async () => {
    await seedLegacyInstance();
    const userId = await createUser("Late User");
    const expired = await issueBoardClaimChallenge(db, { now: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    await expect(inspectBoardClaimChallenge(db, expired.token, expired.code)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(claimBoardOwnership(db, { token: expired.token, code: expired.code, userId })).resolves.toMatchObject({
      status: "expired",
    });
    await expect(adminRows(userId)).resolves.toHaveLength(0);

    // Startup (or the CLI) issues a fresh one because the stored record is spent.
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const fresh = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    expect(fresh.token).not.toBe(expired.token);
    await expect(inspectBoardClaimChallenge(db, expired.token, expired.code)).resolves.toMatchObject({
      status: "invalid",
    });
    await expect(claimBoardOwnership(db, { token: fresh.token, code: fresh.code, userId })).resolves.toMatchObject({
      status: "claimed",
    });
  });

  it("rejects a wrong code without revealing whether the token matched", async () => {
    await seedLegacyInstance();
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const { token } = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    await expect(inspectBoardClaimChallenge(db, token, "nope")).resolves.toEqual({
      status: "invalid",
      requiresSignIn: true,
      expiresAt: null,
      claimedByUserId: null,
    });
  });

  it("does not issue a challenge once a real admin exists", async () => {
    const userId = await createUser("Existing Admin");
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect(getBoardClaimWarningUrl("127.0.0.1", 3197)).toBeNull();
    expect(await isBoardClaimPending(db)).toBe(false);
    expect((await persistedRecord()).record).toBeNull();
  });

  it("survives a user general-settings write", async () => {
    await seedLegacyInstance();
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const { token, code } = parseClaimUrl(getBoardClaimWarningUrl("127.0.0.1", 3197)!);

    const settings = instanceSettingsService(db);
    const updated = await settings.updateGeneral({ keyboardShortcuts: true });
    expect(updated.general.keyboardShortcuts).toBe(true);
    expect((updated.general as Record<string, unknown>)[BOARD_CLAIM_CHALLENGE_SETTINGS_KEY]).toBeUndefined();

    await expect(inspectBoardClaimChallenge(db, token, code)).resolves.toMatchObject({ status: "available" });
  });
});

describeEmbeddedPostgres("the Board", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function createUser(name: string) {
    const now = new Date();
    const userId = `board-user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-members-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists instance admins, excludes the sentinel, and flags the legacy state", async () => {
    const dana = await createUser("Dana");
    const lee = await createUser("Lee");
    await db.insert(instanceUserRoles).values([
      { userId: dana, role: "instance_admin" },
      { userId: lee, role: "instance_admin" },
      { userId: "local-board", role: "instance_admin" },
    ]);

    const board = await listBoardMembers(db);
    expect(board.members.map((member) => member.id)).toEqual([dana, lee]);
    expect(board.members.map((member) => member.isOperator)).toEqual([null, null]);
    expect(board.operatorUserId).toBeNull();
    expect(board.legacySentinelHoldsAdmin).toBe(true);
    expect(await describeBoardAddressee(db)).toBe("Dana or Lee");
  });

  it("marks the recorded operator when instance settings name one", async () => {
    const dana = await createUser("Dana");
    const lee = await createUser("Lee");
    await db.insert(instanceUserRoles).values([
      { userId: dana, role: "instance_admin" },
      { userId: lee, role: "instance_admin" },
    ]);
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { operatorUserId: lee },
      experimental: {},
    });

    const board = await listBoardMembers(db);
    expect(board.operatorUserId).toBe(lee);
    expect(board.members.find((member) => member.id === lee)?.isOperator).toBe(true);
    expect(board.members.find((member) => member.id === dana)?.isOperator).toBe(false);
    expect(board.legacySentinelHoldsAdmin).toBe(false);
    expect(await describeBoardAddressee(db)).toBe("Lee");
  });

  it("refuses to remove the last Board member but still demotes the sentinel", async () => {
    const dana = await createUser("Dana");
    const lee = await createUser("Lee");
    await db.insert(instanceUserRoles).values([
      { userId: dana, role: "instance_admin" },
      { userId: lee, role: "instance_admin" },
      { userId: "local-board", role: "instance_admin" },
    ]);
    const access = accessService(db);

    await expect(access.demoteInstanceAdmin(lee)).resolves.toMatchObject({ userId: lee });
    await expect(access.demoteInstanceAdmin(dana)).rejects.toMatchObject({
      status: 409,
      details: { code: "board_last_member" },
    });
    await expect(access.demoteInstanceAdmin("local-board")).resolves.toMatchObject({ userId: "local-board" });
    await expect(access.demoteInstanceAdmin(dana)).rejects.toMatchObject({ status: 409 });
    await expect(access.demoteInstanceAdmin("missing-user")).resolves.toBeNull();

    const remaining = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    expect(remaining.map((row) => row.userId)).toEqual([dana]);
  });
});
