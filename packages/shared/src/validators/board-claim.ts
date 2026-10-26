import { z } from "zod";

/**
 * The agent-posting sentinel user. In `local_trusted` mode it is also the
 * implicit board principal; it is never a Board member in its own right
 * (see doc/plans/2026-10-26-operator-identity-and-board-ownership.md, Spec 6).
 */
export const LOCAL_BOARD_SENTINEL_USER_ID = "local-board";

/**
 * Key under `instance_settings.general` holding the persisted legacy
 * board-claim challenge. The record never carries plaintext: the token and
 * code are stored as SHA-256 hex digests and compared by hash.
 */
export const BOARD_CLAIM_CHALLENGE_SETTINGS_KEY = "boardClaimChallenge";

export const BOARD_CLAIM_CHALLENGE_TTL_MS = 1000 * 60 * 60 * 24;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const boardClaimChallengeRecordSchema = z
  .object({
    tokenHash: sha256HexSchema,
    codeHash: sha256HexSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    claimedAt: z.string().datetime().nullable().default(null),
    claimedByUserId: z.string().min(1).nullable().default(null),
  })
  .strict();

export type BoardClaimChallengeRecord = z.infer<typeof boardClaimChallengeRecordSchema>;

/**
 * Reads the persisted challenge out of a raw `instance_settings.general`
 * JSON object. Returns `null` when absent or malformed so callers treat a
 * corrupt record as "no challenge" rather than failing the request.
 */
export function readBoardClaimChallengeRecord(general: unknown): BoardClaimChallengeRecord | null {
  if (!general || typeof general !== "object") return null;
  const raw = (general as Record<string, unknown>)[BOARD_CLAIM_CHALLENGE_SETTINGS_KEY];
  if (!raw) return null;
  const parsed = boardClaimChallengeRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
