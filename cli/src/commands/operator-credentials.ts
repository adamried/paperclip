import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, ne, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import {
  authAccounts,
  authUsers,
  createDb,
  instanceSettings,
  instanceUserRoles,
} from "@paperclipai/db";
import { AGENT_SENTINEL_USER_ID } from "@paperclipai/shared";
import { loadPaperclipEnvFile } from "../config/env.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { resolveDatabaseUrlFromConfig, resolveDbUrl as resolveLocalDatabaseUrl } from "../config/db-url.js";

/**
 * Operator credentials: turning the implicit local operator into a login.
 *
 * In `local_trusted` mode the operator is a dedicated `user` row recorded in
 * `instance_settings.general.operatorUserId` (see `doc/DEPLOYMENT-MODES.md`
 * section 6). Enabling `authenticated` mode must not create a second human, so
 * this module attaches a Better Auth credential account to that same row. The
 * password is hashed with Better Auth's own exported hasher and the account row
 * follows the conventions documented on `authAccounts` in
 * `packages/db/src/schema/auth.ts`, so the normal sign-in endpoint accepts it.
 *
 * Nothing here touches bind, host, or exposure.
 */

/** Better Auth stamps `local:<providerId>` on local (non-OAuth) accounts. */
export const CREDENTIAL_ACCOUNT_ISSUER = "local:credential";
export const CREDENTIAL_PROVIDER_ID = "credential";
/** Better Auth's `emailAndPassword` defaults, which the server does not override. */
export const MIN_OPERATOR_PASSWORD_LENGTH = 8;
export const MAX_OPERATOR_PASSWORD_LENGTH = 128;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type DbClient = ReturnType<typeof createDb>;
type ClosableDb = DbClient & {
  $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
};

/**
 * The database the local instance uses, resolved the same way the server does
 * (explicit flag, DATABASE_URL, external connection string, embedded cluster).
 */
export { resolveLocalDatabaseUrl, resolveDatabaseUrlFromConfig };

export type OperatorIdentitySnapshot =
  | {
      kind: "dedicated";
      userId: string;
      name: string | null;
      email: string | null;
      /** Whether a credential account already exists for the operator. */
      hasCredential: boolean;
    }
  | { kind: "legacy"; userId: typeof AGENT_SENTINEL_USER_ID }
  | { kind: "none" };

type OperatorQueryDb = Pick<DbClient, "select">;

/**
 * Classify the instance the way the server does at startup: a recorded
 * operator is `dedicated`; an unrecorded instance whose agent sentinel still
 * holds `instance_admin` is `legacy`; anything else has no operator.
 */
export async function inspectOperatorIdentity(db: OperatorQueryDb): Promise<OperatorIdentitySnapshot> {
  const settingsRow = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .then((rows) => rows[0] ?? null);
  const general = settingsRow?.general;
  const recorded =
    general && typeof general === "object" && !Array.isArray(general)
      ? (general as Record<string, unknown>).operatorUserId
      : undefined;
  const operatorUserId = typeof recorded === "string" && recorded.trim() ? recorded.trim() : null;

  if (operatorUserId) {
    const [user, credential] = await Promise.all([
      db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, operatorUserId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, operatorUserId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID)))
        .then((rows) => rows[0] ?? null),
    ]);
    return {
      kind: "dedicated",
      userId: operatorUserId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      hasCredential: Boolean(credential),
    };
  }

  const sentinelAdmin = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, AGENT_SENTINEL_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  if (sentinelAdmin) return { kind: "legacy", userId: AGENT_SENTINEL_USER_ID };
  return { kind: "none" };
}

export type OperatorCredentialErrorCode =
  | "legacy_operator"
  | "no_operator"
  | "operator_missing"
  | "invalid_email"
  | "email_in_use"
  | "weak_password";

export class OperatorCredentialError extends Error {
  code: OperatorCredentialErrorCode;
  constructor(code: OperatorCredentialErrorCode, message: string) {
    super(message);
    this.name = "OperatorCredentialError";
    this.code = code;
  }
}

export function normalizeOperatorEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new OperatorCredentialError("invalid_email", `"${raw.trim()}" is not a valid email address.`);
  }
  return email;
}

export function validateOperatorPassword(password: string): string | undefined {
  if (password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_OPERATOR_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_OPERATOR_PASSWORD_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * The two paths for an instance that predates dedicated operators. Attaching
 * a password to `local-board` is never one of them: that row is the agent
 * sentinel, and a login on it would turn every agent-authored row into the
 * operator's.
 */
export function legacyOperatorGuidance(): string[] {
  return [
    "This instance predates dedicated operator identities: the agent sentinel `local-board` is still the",
    "implicit operator and holds instance_admin. Paperclip will not attach a login to that sentinel.",
    "",
    "Choose one of these paths instead:",
    `  1. Start the server in authenticated mode, sign up in the browser, then move ownership into that`,
    `     account on the host: ${pc.cyan("paperclipai auth reconcile-identity --from local-board --to <email> --apply")}`,
    `  2. Start the server in authenticated mode and complete the one-time board-claim URL it prints while`,
    `     signed in (doc/DEPLOYMENT-MODES.md section 7).`,
  ];
}

export type AttachOperatorCredentialsResult = {
  userId: string;
  email: string;
  /** False when an existing credential account had its password replaced. */
  createdAccount: boolean;
};

/**
 * Attach (or replace) the operator's email/password login. Refuses legacy
 * instances and instances without an operator; rejects an email another user
 * already holds; enforces Better Auth's password bounds; runs in one
 * transaction.
 */
export async function attachOperatorCredentials(
  db: DbClient,
  input: { email: string; password: string; name?: string | null },
): Promise<AttachOperatorCredentialsResult> {
  const identity = await inspectOperatorIdentity(db);
  if (identity.kind === "legacy") {
    throw new OperatorCredentialError(
      "legacy_operator",
      "This instance uses the legacy operator identity (local-board); credentials cannot be attached to the agent sentinel.",
    );
  }
  if (identity.kind === "none") {
    throw new OperatorCredentialError(
      "no_operator",
      "No operator is recorded for this instance. Start the server once in local_trusted mode, or use `paperclipai auth bootstrap-ceo`.",
    );
  }
  const email = normalizeOperatorEmail(input.email);
  const passwordProblem = validateOperatorPassword(input.password);
  if (passwordProblem) throw new OperatorCredentialError("weak_password", passwordProblem);

  const passwordHash = await hashPassword(input.password);
  const now = new Date();
  const name = input.name?.trim() || null;

  return db.transaction(async (tx) => {
    const operator = await tx
      .select({ id: authUsers.id, name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, identity.userId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!operator) {
      throw new OperatorCredentialError(
        "operator_missing",
        `The recorded operator user ${identity.userId} does not exist. Start the server once in local_trusted mode to recreate it.`,
      );
    }

    const emailOwner = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(sql`lower(${authUsers.email}) = ${email}`, ne(authUsers.id, identity.userId)))
      .then((rows) => rows[0] ?? null);
    if (emailOwner) {
      throw new OperatorCredentialError("email_in_use", `${email} already belongs to another user on this instance.`);
    }

    await tx
      .update(authUsers)
      .set({
        email,
        // Keep an operator-chosen name; replace only the startup placeholder
        // or a blank name when the caller supplied one.
        ...(name && (!operator.name?.trim() || operator.name.trim() === "Operator") ? { name } : {}),
        emailVerified: false,
        updatedAt: now,
      })
      .where(eq(authUsers.id, identity.userId));

    const existingAccount = await tx
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, identity.userId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID)))
      .then((rows) => rows[0] ?? null);
    if (existingAccount) {
      await tx
        .update(authAccounts)
        .set({ password: passwordHash, updatedAt: now })
        .where(eq(authAccounts.id, existingAccount.id));
      return { userId: identity.userId, email, createdAccount: false };
    }

    await tx.insert(authAccounts).values({
      id: randomUUID(),
      issuer: CREDENTIAL_ACCOUNT_ISSUER,
      accountId: identity.userId,
      providerId: CREDENTIAL_PROVIDER_ID,
      userId: identity.userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    return { userId: identity.userId, email, createdAccount: true };
  });
}

export function loginEnabledMessage(email: string): string {
  return `Login enabled. Sign in as ${pc.cyan(email)}. Your existing companies, tasks, and provider connections stay with this account.`;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function promptEmail(initial?: string | null): Promise<string | null> {
  const value = await p.text({
    message: "Operator email (used to sign in)",
    defaultValue: initial ?? undefined,
    placeholder: "you@example.com",
    validate: (val) => {
      try {
        normalizeOperatorEmail(val ?? "");
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : "Enter a valid email address";
      }
    },
  });
  if (p.isCancel(value)) return null;
  return normalizeOperatorEmail(value);
}

async function promptPassword(): Promise<string | null> {
  const password = await p.password({
    message: "Operator password",
    validate: (val) => validateOperatorPassword(val ?? ""),
  });
  if (p.isCancel(password)) return null;
  const confirm = await p.password({
    message: "Confirm password",
    validate: (val) => (val === password ? undefined : "Passwords do not match"),
  });
  if (p.isCancel(confirm)) return null;
  return password;
}

function readPasswordFromStdin(): string {
  const raw = readFileSync(0, "utf8");
  // One line: a trailing newline from `echo` or a heredoc is not part of the password.
  return raw.replace(/\r?\n$/, "");
}

async function closeDb(db: DbClient) {
  await (db as ClosableDb).$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

function openDb(url: string): DbClient {
  // A short connect timeout: this runs from an interactive prompt, and an
  // embedded cluster that is not running should fail fast with guidance.
  return createDb(url, { connectTimeoutSeconds: 5 });
}

export type OperatorCredentialUpgradeOutcome =
  | "attached"
  | "already_configured"
  | "skipped"
  | "legacy"
  | "no_operator"
  | "unavailable";

/**
 * Offered by `configure --section server` when the mode moves from
 * `local_trusted` to `authenticated`: prompt for email and password and attach
 * them to the existing operator so no browser claim is needed afterwards. The
 * caller saves the config regardless of the outcome; every non-`attached`
 * outcome prints what to do next.
 */
export async function offerOperatorCredentialUpgrade(input: {
  configPath?: string;
  database: PaperclipConfig["database"];
  dbUrl?: string;
}): Promise<OperatorCredentialUpgradeOutcome> {
  const headlessHint = `Run ${pc.cyan("paperclipai auth set-operator-credentials --email <email>")} while the server is running to attach a login to the operator account.`;
  const dbUrl = input.dbUrl ?? resolveDatabaseUrlFromConfig(input.database);
  if (!dbUrl) {
    p.log.warn(`Could not resolve the database connection. ${headlessHint}`);
    return "unavailable";
  }
  if (!isInteractive()) {
    p.log.info(`Login is being enabled without a terminal to prompt in. ${headlessHint}`);
    return "skipped";
  }

  const db = openDb(dbUrl);
  try {
    let identity: OperatorIdentitySnapshot;
    try {
      identity = await inspectOperatorIdentity(db);
    } catch (err) {
      p.log.warn(
        `Could not reach the database (${err instanceof Error ? err.message : String(err)}). ` +
          `If this instance uses embedded PostgreSQL, start Paperclip first. ${headlessHint}`,
      );
      return "unavailable";
    }

    if (identity.kind === "legacy") {
      p.note(legacyOperatorGuidance().join("\n"), "Legacy operator identity");
      return "legacy";
    }
    if (identity.kind === "none") {
      p.log.info(
        "No operator is recorded for this instance, so there is no account to keep. " +
          `The first admin is created through the browser setup screen or ${pc.cyan("paperclipai auth bootstrap-ceo")}.`,
      );
      return "no_operator";
    }

    p.log.step(pc.bold("Operator login"));
    p.log.message(
      pc.dim(
        identity.hasCredential
          ? `The operator account (${identity.email ?? identity.userId}) already has a login. You can set a new email and password now, or keep it.`
          : "Login is about to be required. Your companies, tasks, and provider connections belong to the operator account; give it an email and password so you can sign in as it.",
      ),
    );
    const proceed = await p.confirm({
      message: identity.hasCredential ? "Replace the operator login?" : "Set the operator email and password now?",
      initialValue: !identity.hasCredential,
    });
    if (p.isCancel(proceed) || !proceed) {
      if (identity.hasCredential) return "already_configured";
      p.log.warn(`Skipped. Until a login is attached, nobody can sign in as the operator. ${headlessHint}`);
      return "skipped";
    }

    const email = await promptEmail(
      identity.email && !identity.email.endsWith(".paperclip.local") ? identity.email : null,
    );
    if (!email) return "skipped";
    const password = await promptPassword();
    if (!password) return "skipped";

    try {
      const result = await attachOperatorCredentials(db, { email, password });
      p.log.success(loginEnabledMessage(result.email));
      return "attached";
    } catch (err) {
      if (err instanceof OperatorCredentialError) {
        p.log.error(err.message);
        if (err.code === "legacy_operator") {
          p.note(legacyOperatorGuidance().join("\n"), "Legacy operator identity");
          return "legacy";
        }
        p.log.info(headlessHint);
        return "skipped";
      }
      throw err;
    }
  } finally {
    await closeDb(db);
  }
}

/**
 * `paperclipai auth set-operator-credentials --email <email>`: the headless
 * form of the upgrade prompt. The password is prompted, or read from stdin
 * with `--password-stdin`.
 */
export async function setOperatorCredentialsCommand(opts: {
  config?: string;
  email?: string;
  name?: string;
  passwordStdin?: boolean;
  dbUrl?: string;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const config = readConfig(configPath);
  if (!config && !opts.dbUrl && !process.env.DATABASE_URL) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclipai onboard")} first.`);
    process.exitCode = 1;
    return;
  }

  const dbUrl = resolveLocalDatabaseUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve the database connection for this instance.");
    process.exitCode = 1;
    return;
  }

  let email: string;
  try {
    if (opts.email) {
      email = normalizeOperatorEmail(opts.email);
    } else if (isInteractive()) {
      const prompted = await promptEmail();
      if (!prompted) {
        p.cancel("Cancelled.");
        return;
      }
      email = prompted;
    } else {
      p.log.error("--email is required when no terminal is available.");
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let password: string | null;
  if (opts.passwordStdin) {
    password = readPasswordFromStdin();
    const problem = validateOperatorPassword(password);
    if (problem) {
      p.log.error(problem);
      process.exitCode = 1;
      return;
    }
  } else if (isInteractive()) {
    password = await promptPassword();
    if (!password) {
      p.cancel("Cancelled.");
      return;
    }
  } else {
    p.log.error("Pass --password-stdin and pipe the password when no terminal is available.");
    process.exitCode = 1;
    return;
  }

  const db = openDb(dbUrl);
  try {
    const result = await attachOperatorCredentials(db, { email, password, name: opts.name ?? null });
    p.log.success(
      result.createdAccount
        ? loginEnabledMessage(result.email)
        : `Operator login updated. Sign in as ${pc.cyan(result.email)}.`,
    );
    if (config?.server.deploymentMode !== "authenticated") {
      p.log.info(
        `This instance is still in ${config?.server.deploymentMode ?? "local_trusted"} mode. ` +
          `Run ${pc.cyan("paperclipai configure --section server")} to require login; the bind address does not change.`,
      );
    }
  } catch (err) {
    if (err instanceof OperatorCredentialError) {
      p.log.error(err.message);
      if (err.code === "legacy_operator") {
        p.note(legacyOperatorGuidance().join("\n"), "Legacy operator identity");
      }
      process.exitCode = 1;
      return;
    }
    p.log.error(`Could not attach operator credentials: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info("If using embedded PostgreSQL, start the Paperclip server and run this command again.");
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}
