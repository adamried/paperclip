import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BOARD_CLAIM_CHALLENGE_TTL_MS,
  type BoardClaimChallengeRecord,
} from "./validators/board-claim.js";

/**
 * Node-only helpers for the legacy board-claim challenge, shared by the
 * server (`server/src/board-claim.ts`) and the CLI
 * (`paperclipai auth board-claim-url`) so both mint and verify the same
 * persisted record shape. Import via `@paperclipai/shared/board-claim-challenge`;
 * this module is deliberately kept out of the browser-safe index.
 */

export type BoardClaimChallengeStatus = "available" | "claimed" | "expired" | "invalid";

export type MintedBoardClaimChallenge = {
  /** Plaintext token. Only ever held in memory by the process that minted it. */
  token: string;
  /** Plaintext code. Only ever held in memory by the process that minted it. */
  code: string;
  /** The hash-only record to persist in `instance_settings.general`. */
  record: BoardClaimChallengeRecord;
};

export function hashBoardClaimSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesMatch(expectedHex: string, actual: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const candidate = Buffer.from(hashBoardClaimSecret(actual), "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

export function mintBoardClaimChallenge(
  options: { now?: Date; ttlMs?: number } = {},
): MintedBoardClaimChallenge {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? BOARD_CLAIM_CHALLENGE_TTL_MS;
  const token = randomBytes(24).toString("hex");
  const code = randomBytes(12).toString("hex");
  return {
    token,
    code,
    record: {
      tokenHash: hashBoardClaimSecret(token),
      codeHash: hashBoardClaimSecret(code),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      claimedAt: null,
      claimedByUserId: null,
    },
  };
}

export function boardClaimChallengeIsOpen(
  record: BoardClaimChallengeRecord | null,
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  if (record.claimedAt) return false;
  return new Date(record.expiresAt).getTime() > now.getTime();
}

/**
 * Resolves the status of a presented token/code pair against the persisted
 * record. Hash comparison only; a mismatch on either half is `invalid` so the
 * response never distinguishes "right token, wrong code".
 */
export function boardClaimChallengeStatus(
  record: BoardClaimChallengeRecord | null,
  token: string,
  code: string | undefined,
  now: Date = new Date(),
): BoardClaimChallengeStatus {
  if (!record) return "invalid";
  if (!token || !hashesMatch(record.tokenHash, token)) return "invalid";
  if (!hashesMatch(record.codeHash, code ?? "")) return "invalid";
  if (record.claimedAt) return "claimed";
  if (new Date(record.expiresAt).getTime() <= now.getTime()) return "expired";
  return "available";
}

export function buildBoardClaimUrl(baseUrl: string, token: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/board-claim/${token}?code=${code}`;
}
