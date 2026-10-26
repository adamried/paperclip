import { describe, expect, it } from "vitest";
import {
  boardClaimChallengeIsOpen,
  boardClaimChallengeStatus,
  buildBoardClaimUrl,
  hashBoardClaimSecret,
  mintBoardClaimChallenge,
} from "./board-claim-challenge.js";
import {
  BOARD_CLAIM_CHALLENGE_SETTINGS_KEY,
  readBoardClaimChallengeRecord,
} from "./validators/board-claim.js";

describe("board claim challenge helpers", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("mints a record that stores hashes only and round-trips through the settings reader", () => {
    const minted = mintBoardClaimChallenge({ now, ttlMs: 60_000 });
    expect(minted.record.tokenHash).toBe(hashBoardClaimSecret(minted.token));
    expect(minted.record.codeHash).toBe(hashBoardClaimSecret(minted.code));
    expect(JSON.stringify(minted.record)).not.toContain(minted.token);
    expect(JSON.stringify(minted.record)).not.toContain(minted.code);
    expect(minted.record.expiresAt).toBe("2026-10-26T12:01:00.000Z");

    const general = { keyboardShortcuts: true, [BOARD_CLAIM_CHALLENGE_SETTINGS_KEY]: minted.record };
    expect(readBoardClaimChallengeRecord(general)).toEqual(minted.record);
    expect(readBoardClaimChallengeRecord({ keyboardShortcuts: true })).toBeNull();
    expect(readBoardClaimChallengeRecord({ [BOARD_CLAIM_CHALLENGE_SETTINGS_KEY]: { tokenHash: "nope" } })).toBeNull();
    expect(readBoardClaimChallengeRecord(null)).toBeNull();
  });

  it("resolves status by hash comparison and never distinguishes a wrong code from a wrong token", () => {
    const minted = mintBoardClaimChallenge({ now, ttlMs: 60_000 });
    expect(boardClaimChallengeStatus(minted.record, minted.token, minted.code, now)).toBe("available");
    expect(boardClaimChallengeStatus(minted.record, minted.token, "wrong", now)).toBe("invalid");
    expect(boardClaimChallengeStatus(minted.record, minted.token, undefined, now)).toBe("invalid");
    expect(boardClaimChallengeStatus(minted.record, "wrong", minted.code, now)).toBe("invalid");
    expect(boardClaimChallengeStatus(null, minted.token, minted.code, now)).toBe("invalid");
    expect(
      boardClaimChallengeStatus(minted.record, minted.token, minted.code, new Date(now.getTime() + 60_000)),
    ).toBe("expired");
    expect(
      boardClaimChallengeStatus(
        { ...minted.record, claimedAt: now.toISOString(), claimedByUserId: "user-1" },
        minted.token,
        minted.code,
        now,
      ),
    ).toBe("claimed");
  });

  it("treats claimed or expired records as closed", () => {
    const minted = mintBoardClaimChallenge({ now, ttlMs: 60_000 });
    expect(boardClaimChallengeIsOpen(minted.record, now)).toBe(true);
    expect(boardClaimChallengeIsOpen(minted.record, new Date(now.getTime() + 60_000))).toBe(false);
    expect(boardClaimChallengeIsOpen({ ...minted.record, claimedAt: now.toISOString() }, now)).toBe(false);
    expect(boardClaimChallengeIsOpen(null, now)).toBe(false);
  });

  it("builds the claim URL without a double slash", () => {
    expect(buildBoardClaimUrl("http://localhost:3100/", "tok", "c0de")).toBe(
      "http://localhost:3100/board-claim/tok?code=c0de",
    );
  });
});
