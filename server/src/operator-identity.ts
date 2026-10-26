import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceSettings,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  AGENT_SENTINEL_USER_ID,
  type DeploymentMode,
  type OperatorIdentityKind,
} from "@paperclipai/shared";
import { instanceSettingsService } from "./services/instance-settings.js";

/**
 * Operator identity.
 *
 * The operator is one user id for the life of the instance: the implicit human
 * actor in `local_trusted` mode, and the account that keeps every company,
 * task, and provider default when login is enabled later (the CLI attaches a
 * credential account to this same row; see `paperclipai auth
 * set-operator-credentials`).
 *
 * `local-board` (`AGENT_SENTINEL_USER_ID`) is a different thing: the non-human
 * sentinel that agent-authored rows are written under. On new instances it
 * exists only so those foreign keys resolve. It holds no `instance_admin` role
 * and no company membership.
 *
 * Instances created before dedicated operators exist are *legacy*: the
 * sentinel holds `instance_admin` and nothing is recorded in
 * `instance_settings.general.operatorUserId`. Startup never migrates them. The
 * sentinel doubles as the operator in memory only, so every request keeps
 * resolving exactly as before, and `/api/health` reports
 * `operatorIdentity: "legacy"` so the operator can pick a migration path.
 */

export const OPERATOR_USER_NAME = "Operator";
export const AGENT_SENTINEL_USER_NAME = "Agent runtime";
/** Legacy instances created the sentinel row with this display name. */
export const LEGACY_SENTINEL_USER_NAME = "Board";
const AGENT_SENTINEL_USER_EMAIL = "local@paperclip.local";

export type OperatorIdentity = {
  kind: OperatorIdentityKind;
  /** The operator's user id; null only for `none`. */
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  deploymentMode: DeploymentMode;
};

/**
 * Unique, non-routable placeholder email for the operator row. The instance id
 * is already restricted to path-safe characters, so it is safe inside a label.
 */
export function operatorPlaceholderEmail(instanceId: string): string {
  return `operator@${instanceId}.paperclip.local`;
}

export function legacyOperatorIdentity(deploymentMode: DeploymentMode): OperatorIdentity {
  return {
    kind: "legacy",
    userId: AGENT_SENTINEL_USER_ID,
    userName: LEGACY_SENTINEL_USER_NAME,
    userEmail: null,
    deploymentMode,
  };
}

let current: OperatorIdentity | null = null;

/**
 * The identity resolved at startup. `ensureOperatorIdentity` /
 * `resolveOperatorIdentity` always run before the HTTP listener binds; until
 * then (which in practice means only in unit tests that mount middleware
 * without booting) the legacy identity applies, which is exactly the
 * pre-operator behaviour.
 */
export function getOperatorIdentity(): OperatorIdentity {
  return current ?? legacyOperatorIdentity("local_trusted");
}

export function setOperatorIdentity(identity: OperatorIdentity | null): void {
  current = identity;
}

/**
 * Whether `userId` is the implicit local operator: the identity the deployment
 * trusts without login. Used where "local trusted" used to be spelled as
 * `userId === "local-board"`; keyed on deployment mode and the resolved
 * operator id, never on the sentinel.
 */
export function isLocalTrustedOperator(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const identity = getOperatorIdentity();
  return identity.deploymentMode === "local_trusted" && identity.userId === userId;
}

type OperatorDb = Pick<Db, "select" | "insert" | "update">;

type UserRow = { id: string; name: string | null; email: string | null };

async function loadUser(db: OperatorDb, userId: string): Promise<UserRow | null> {
  return db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
}

async function loadUserByEmail(db: OperatorDb, email: string): Promise<UserRow | null> {
  return db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .then((rows) => rows[0] ?? null);
}

async function hasInstanceAdminRole(db: OperatorDb, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

/**
 * Read the recorded operator id without creating the settings row: a legacy
 * instance that has no settings row yet must stay byte-identical across boot.
 */
export async function readRecordedOperatorUserId(db: OperatorDb): Promise<string | null> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .then((rows) => rows[0] ?? null);
  const general = row?.general;
  if (!general || typeof general !== "object" || Array.isArray(general)) return null;
  const value = (general as Record<string, unknown>).operatorUserId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The sentinel row exists so agent-authored rows have a valid foreign key. Nothing else. */
async function ensureAgentSentinelUser(db: OperatorDb): Promise<void> {
  const existing = await loadUser(db, AGENT_SENTINEL_USER_ID);
  if (existing) return;
  const now = new Date();
  await db.insert(authUsers).values({
    id: AGENT_SENTINEL_USER_ID,
    name: AGENT_SENTINEL_USER_NAME,
    email: AGENT_SENTINEL_USER_EMAIL,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function ensureInstanceAdmin(db: OperatorDb, userId: string): Promise<void> {
  if (await hasInstanceAdminRole(db, userId)) return;
  await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
}

async function ensureOwnerMemberships(db: OperatorDb, userId: string): Promise<void> {
  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (membership) continue;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
  }
}

function dedicatedIdentity(user: UserRow, deploymentMode: DeploymentMode): OperatorIdentity {
  return {
    kind: "dedicated",
    userId: user.id,
    userName: user.name?.trim() || OPERATOR_USER_NAME,
    userEmail: user.email?.trim() || null,
    deploymentMode,
  };
}

/**
 * Read-only classification of the instance. Used in `authenticated` mode,
 * where startup grants nothing, and by the legacy branch of
 * `ensureOperatorIdentity`.
 */
export async function resolveOperatorIdentity(
  db: OperatorDb,
  opts: { deploymentMode: DeploymentMode },
): Promise<OperatorIdentity> {
  const recorded = await readRecordedOperatorUserId(db);
  if (recorded) {
    const user = await loadUser(db, recorded);
    if (user) return dedicatedIdentity(user, opts.deploymentMode);
    // Recorded but the row is gone: report what is recorded so an operator can
    // see the inconsistency, rather than silently falling back to the sentinel.
    return {
      kind: "dedicated",
      userId: recorded,
      userName: null,
      userEmail: null,
      deploymentMode: opts.deploymentMode,
    };
  }
  if (await hasInstanceAdminRole(db, AGENT_SENTINEL_USER_ID)) {
    const sentinel = await loadUser(db, AGENT_SENTINEL_USER_ID);
    return {
      ...legacyOperatorIdentity(opts.deploymentMode),
      userName: sentinel?.name?.trim() || LEGACY_SENTINEL_USER_NAME,
      userEmail: sentinel?.email?.trim() || null,
    };
  }
  return { kind: "none", userId: null, userName: null, userEmail: null, deploymentMode: opts.deploymentMode };
}

/**
 * Adopt an operator recorded after startup. `authenticated` startup classifies
 * the instance once, and a fresh install resolves to `none`; `paperclipai auth
 * set-operator-credentials` can then create and record the operator while the
 * server runs (doc/DEPLOYMENT-MODES.md section 8). A caller that sees `none`
 * re-reads the record and adopts it, so `/api/health` reports `dedicated`
 * without a restart. Only a recorded operator is adopted: the sentinel's role
 * is never re-evaluated here, so a legacy classification stays as startup made
 * it, and anything other than `none` is returned untouched.
 */
export async function adoptRecordedOperatorIdentity(db: OperatorDb): Promise<OperatorIdentity> {
  const cached = getOperatorIdentity();
  if (cached.kind !== "none") return cached;
  const recorded = await readRecordedOperatorUserId(db);
  if (!recorded) return cached;
  const user = await loadUser(db, recorded);
  const identity: OperatorIdentity = user
    ? dedicatedIdentity(user, cached.deploymentMode)
    : { kind: "dedicated", userId: recorded, userName: null, userEmail: null, deploymentMode: cached.deploymentMode };
  setOperatorIdentity(identity);
  return identity;
}

export type EnsureOperatorIdentityResult = OperatorIdentity & {
  /** True when this call created the dedicated operator (first local start). */
  created: boolean;
};

/**
 * `local_trusted` startup. Three outcomes, chosen in this order:
 *
 * 1. An operator is recorded: make sure its row, `instance_admin` role and
 *    owner membership in every company exist (the same grants the sentinel
 *    used to receive), and make sure the sentinel row exists.
 * 2. Nothing is recorded and the sentinel holds `instance_admin`: legacy.
 *    Write nothing. The sentinel is the operator in memory only.
 * 3. Nothing is recorded and the sentinel is not an admin: a fresh instance.
 *    Create the sentinel row (no grants) and a dedicated operator with a
 *    random id, grant it `instance_admin` and owner membership in every
 *    company, and record its id.
 *
 * A fresh instance whose settings row was lost but whose operator row (found
 * by the placeholder email) still holds `instance_admin` re-adopts that row
 * instead of creating a second human.
 */
export async function ensureOperatorIdentity(
  db: OperatorDb,
  opts: { deploymentMode: DeploymentMode; instanceId: string },
): Promise<EnsureOperatorIdentityResult> {
  if (opts.deploymentMode !== "local_trusted") {
    const resolved = await resolveOperatorIdentity(db, opts);
    setOperatorIdentity(resolved);
    return { ...resolved, created: false };
  }

  const recorded = await readRecordedOperatorUserId(db);
  if (recorded) {
    await ensureAgentSentinelUser(db);
    let user = await loadUser(db, recorded);
    if (!user) {
      const now = new Date();
      await db.insert(authUsers).values({
        id: recorded,
        name: OPERATOR_USER_NAME,
        email: operatorPlaceholderEmail(opts.instanceId),
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      user = await loadUser(db, recorded);
    }
    await ensureInstanceAdmin(db, recorded);
    await ensureOwnerMemberships(db, recorded);
    const identity = dedicatedIdentity(user!, opts.deploymentMode);
    setOperatorIdentity(identity);
    return { ...identity, created: false };
  }

  if (await hasInstanceAdminRole(db, AGENT_SENTINEL_USER_ID)) {
    const identity = await resolveOperatorIdentity(db, opts);
    setOperatorIdentity(identity);
    return { ...identity, created: false };
  }

  await ensureAgentSentinelUser(db);
  const placeholderEmail = operatorPlaceholderEmail(opts.instanceId);
  const adoptable = await loadUserByEmail(db, placeholderEmail);
  let created = false;
  let user: UserRow;
  if (adoptable && (await hasInstanceAdminRole(db, adoptable.id))) {
    user = adoptable;
  } else {
    const now = new Date();
    const id = randomUUID();
    await db.insert(authUsers).values({
      id,
      name: OPERATOR_USER_NAME,
      email: placeholderEmail,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    user = { id, name: OPERATOR_USER_NAME, email: placeholderEmail };
    created = true;
  }
  await ensureInstanceAdmin(db, user.id);
  await ensureOwnerMemberships(db, user.id);
  await instanceSettingsService(db as Db).recordOperatorUserId(user.id, { db });
  const identity = dedicatedIdentity(user, opts.deploymentMode);
  setOperatorIdentity(identity);
  return { ...identity, created };
}
