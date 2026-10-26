import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyMemberships, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import {
  BOARD_CLAIM_CHALLENGE_SETTINGS_KEY,
  AGENT_SENTINEL_USER_ID,
  readBoardClaimChallengeRecord,
  type BoardClaimChallengeRecord,
} from "@paperclipai/shared";
import {
  boardClaimChallengeIsOpen,
  boardClaimChallengeStatus,
  mintBoardClaimChallenge,
} from "@paperclipai/shared/board-claim-challenge";
import { ensureHumanRoleDefaultGrants } from "./services/principal-access-compatibility.js";

/**
 * Legacy claim flow for an instance that switched from `local_trusted` to
 * `authenticated` while the `local-board` sentinel was still its only
 * `instance_admin` (doc/plans/2026-10-26-operator-identity-and-board-ownership.md,
 * Spec 5).
 *
 * The challenge is persisted in `instance_settings.general.boardClaimChallenge`
 * as hashes (never plaintext) so a restart does not reissue it and every
 * process of a multi-process deployment agrees on it. Plaintext exists only in
 * the memory of the process that minted the challenge, for the startup banner;
 * any other process (or a restarted one) mints a fresh challenge through
 * `paperclipai auth board-claim-url` when an operator needs the URL again.
 */

type BoardClaimReadRunner = Pick<Db, "select">;
type BoardClaimWriteRunner = Pick<Db, "select" | "insert" | "update">;

const INSTANCE_SETTINGS_SINGLETON_KEY = "default";

type MintedPlaintext = {
  token: string;
  code: string;
  tokenHash: string;
  expiresAt: Date;
};

/** Plaintext of the challenge this process minted, if any. Never persisted. */
let mintedPlaintext: MintedPlaintext | null = null;

async function readPersistedChallenge(runner: BoardClaimReadRunner): Promise<BoardClaimChallengeRecord | null> {
  const row = await runner
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return readBoardClaimChallengeRecord(row?.general);
}

/**
 * Merges the record into the `general` JSON column without touching any other
 * key. The row is created when the instance has never saved settings.
 */
async function writePersistedChallenge(runner: BoardClaimWriteRunner, record: BoardClaimChallengeRecord): Promise<void> {
  const now = new Date();
  await runner
    .insert(instanceSettings)
    .values({
      singletonKey: INSTANCE_SETTINGS_SINGLETON_KEY,
      general: {},
      experimental: {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
  const patch = JSON.stringify({ [BOARD_CLAIM_CHALLENGE_SETTINGS_KEY]: record });
  await runner
    .update(instanceSettings)
    .set({
      general: sql`coalesce(${instanceSettings.general}, '{}'::jsonb) || ${patch}::jsonb`,
      updatedAt: now,
    })
    .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY));
}

/**
 * The legacy condition the whole flow keys on: `local-board` is the one and
 * only `instance_admin`.
 */
export async function isLegacyLocalBoardOnlyAdmin(runner: BoardClaimReadRunner): Promise<boolean> {
  const admins = await runner
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));
  return admins.length === 1 && admins[0]?.userId === AGENT_SENTINEL_USER_ID;
}

/**
 * Mints a fresh challenge, persists its hashes, and remembers the plaintext in
 * this process only. Any outstanding challenge is superseded.
 */
export async function issueBoardClaimChallenge(
  db: BoardClaimWriteRunner,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<{ token: string; code: string; expiresAt: Date }> {
  const minted = mintBoardClaimChallenge(options);
  await writePersistedChallenge(db, minted.record);
  const expiresAt = new Date(minted.record.expiresAt);
  mintedPlaintext = {
    token: minted.token,
    code: minted.code,
    tokenHash: minted.record.tokenHash,
    expiresAt,
  };
  return { token: minted.token, code: minted.code, expiresAt };
}

export async function initializeBoardClaimChallenge(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Promise<void> {
  if (opts.deploymentMode !== "authenticated") {
    mintedPlaintext = null;
    return;
  }

  if (!(await isLegacyLocalBoardOnlyAdmin(db))) {
    mintedPlaintext = null;
    return;
  }

  const persisted = await readPersistedChallenge(db);
  if (boardClaimChallengeIsOpen(persisted)) {
    // Reuse the outstanding challenge. The plaintext is only known if this
    // very process minted it; otherwise the startup banner stays silent and
    // the operator uses `paperclipai auth board-claim-url`.
    if (mintedPlaintext?.tokenHash !== persisted!.tokenHash) mintedPlaintext = null;
    return;
  }

  await issueBoardClaimChallenge(db);
}

export function getBoardClaimWarningUrl(host: string, port: number): string | null {
  if (!mintedPlaintext) return null;
  if (mintedPlaintext.expiresAt.getTime() <= Date.now()) return null;
  const visibleHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${visibleHost}:${port}/board-claim/${mintedPlaintext.token}?code=${mintedPlaintext.code}`;
}

/** `{ pending }` for the signed-in banner. Carries no secret material. */
export async function isBoardClaimPending(db: BoardClaimReadRunner): Promise<boolean> {
  return isLegacyLocalBoardOnlyAdmin(db);
}

export async function inspectBoardClaimChallenge(db: BoardClaimReadRunner, token: string, code: string | undefined) {
  const record = await readPersistedChallenge(db);
  const status = boardClaimChallengeStatus(record, token, code);
  if (status === "invalid") {
    return { status, requiresSignIn: true as const, expiresAt: null, claimedByUserId: null };
  }
  return {
    status,
    requiresSignIn: true as const,
    expiresAt: record?.expiresAt ?? null,
    claimedByUserId: record?.claimedByUserId ?? null,
  };
}

/**
 * TODO(spec-1): replace with the identity-reconciliation preview summary once
 * `reconcile-identity` lands (another agent is building that module). The
 * claim response carries `reconciliationPreview: null` until then so the UI
 * contract is already in place.
 */
export type BoardClaimReconciliationPreview = null;

export type BoardClaimResult =
  | {
      status: "claimed";
      claimedByUserId: string;
      reconciliationPreview: BoardClaimReconciliationPreview;
    }
  | {
      /**
       * `already_claimed` covers both a replay by the winner and a concurrent
       * loser that waited on the lock and then found the challenge spent.
       */
      status: "already_claimed" | "expired" | "invalid";
      claimedByUserId: string | null;
      reconciliationPreview: BoardClaimReconciliationPreview;
    };

export async function claimBoardOwnership(
  db: Db,
  opts: { token: string; code: string | undefined; userId: string },
): Promise<BoardClaimResult> {
  const outcome = await db.transaction(async (tx) => {
    // Same lock as first-admin-claim.ts: serializes every claim attempt so the
    // status check below and the role writes are one atomic step.
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);

    const record = await readPersistedChallenge(tx);
    const status = boardClaimChallengeStatus(record, opts.token, opts.code);
    if (status !== "available") {
      return {
        status: status === "claimed" ? ("already_claimed" as const) : status,
        claimedByUserId: record?.claimedByUserId ?? null,
        claimedCompanyIds: [] as string[],
      };
    }

    const existingTargetAdmin = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, opts.userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (!existingTargetAdmin) {
      await tx.insert(instanceUserRoles).values({
        userId: opts.userId,
        role: "instance_admin",
      });
    }

    await tx
      .delete(instanceUserRoles)
      .where(
        and(eq(instanceUserRoles.userId, AGENT_SENTINEL_USER_ID), eq(instanceUserRoles.role, "instance_admin")),
      );

    const claimedCompanyIds: string[] = [];
    const allCompanies = await tx.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      claimedCompanyIds.push(company.id);
      const existing = await tx
        .select({ id: companyMemberships.id, status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, opts.userId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        await tx.insert(companyMemberships).values({
          companyId: company.id,
          principalType: "user",
          principalId: opts.userId,
          status: "active",
          membershipRole: "owner",
        });
        continue;
      }

      if (existing.status !== "active") {
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id));
      }
    }

    await writePersistedChallenge(tx, {
      ...record!,
      claimedAt: new Date().toISOString(),
      claimedByUserId: opts.userId,
    });

    return { status: "claimed" as const, claimedByUserId: opts.userId, claimedCompanyIds };
  });

  if (outcome.status !== "claimed") {
    return { status: outcome.status, claimedByUserId: outcome.claimedByUserId, reconciliationPreview: null };
  }

  for (const companyId of outcome.claimedCompanyIds) {
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: opts.userId,
      membershipRole: "owner",
      grantedByUserId: opts.userId,
    });
  }

  if (mintedPlaintext && mintedPlaintext.token === opts.token) {
    mintedPlaintext = null;
  }

  // TODO(spec-1): run the identity reconciliation in preview mode here and
  // return its summary so the UI can say what still needs the CLI.
  return { status: "claimed", claimedByUserId: opts.userId, reconciliationPreview: null };
}
