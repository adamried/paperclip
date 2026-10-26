import * as p from "@clack/prompts";
import pc from "picocolors";
import { eq, sql } from "drizzle-orm";
import { createDb, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import {
  BOARD_CLAIM_CHALLENGE_SETTINGS_KEY,
  BOARD_CLAIM_CHALLENGE_TTL_MS,
  LOCAL_BOARD_SENTINEL_USER_ID,
} from "@paperclipai/shared";
import {
  buildBoardClaimUrl,
  mintBoardClaimChallenge,
} from "@paperclipai/shared/board-claim-challenge";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { resolveBaseUrl, resolveDbUrl } from "./auth-bootstrap-ceo.js";

const INSTANCE_SETTINGS_SINGLETON_KEY = "default";

/**
 * `paperclipai auth board-claim-url`
 *
 * Legacy claim flow (Spec 5): an `authenticated` instance whose only
 * `instance_admin` is still the `local-board` placeholder. The server persists
 * the challenge as hashes only, so no process other than the one that minted
 * it can reproduce the URL. This command therefore always issues a fresh
 * challenge (superseding any outstanding one), persists its hashes in
 * `instance_settings.general.boardClaimChallenge`, and prints the URL once.
 * Host authority (database access) is the gate, exactly like `bootstrap-ceo`.
 */
export async function boardClaimUrl(opts: {
  config?: string;
  expiresHours?: number;
  baseUrl?: string;
  dbUrl?: string;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    return;
  }

  if (config.server.deploymentMode !== "authenticated") {
    p.log.info("Deployment mode is local_trusted. A board claim is only needed in authenticated mode.");
    return;
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve database connection for the board claim.");
    return;
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const admins = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    const onlyLocalBoardAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_SENTINEL_USER_ID;
    if (!onlyLocalBoardAdmin) {
      if (admins.length === 0) {
        p.log.info(
          `No instance admin exists yet. This is a fresh install, not a legacy claim: run ${pc.cyan("paperclipai auth bootstrap-ceo")} instead.`,
        );
      } else {
        p.log.info("No board claim is pending: a real user already holds instance admin.");
      }
      return;
    }

    const now = new Date();
    const expiresHours = Math.max(1, Math.min(24 * 30, opts.expiresHours ?? BOARD_CLAIM_CHALLENGE_TTL_MS / 3_600_000));
    const minted = mintBoardClaimChallenge({ now, ttlMs: expiresHours * 60 * 60 * 1000 });

    await db
      .insert(instanceSettings)
      .values({
        singletonKey: INSTANCE_SETTINGS_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const patch = JSON.stringify({ [BOARD_CLAIM_CHALLENGE_SETTINGS_KEY]: minted.record });
    await db
      .update(instanceSettings)
      .set({
        general: sql`coalesce(${instanceSettings.general}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: now,
      })
      .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY));

    const baseUrl = resolveBaseUrl(configPath, opts.baseUrl);
    p.log.success("Issued a new board claim challenge (any earlier challenge is now void).");
    p.log.message(`Claim URL: ${pc.cyan(buildBoardClaimUrl(baseUrl, minted.token, minted.code))}`);
    p.log.message(`Expires: ${pc.dim(minted.record.expiresAt)}`);
    p.log.message(
      "Sign in to Paperclip in a browser with the account that should own this instance, then open the URL. " +
        "If you are connecting over Tailscale, replace the host with your Tailscale IP/MagicDNS name.",
    );
  } catch (err) {
    p.log.error(`Could not issue board claim challenge: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info("If using embedded-postgres, start the Paperclip server and run this command again.");
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
