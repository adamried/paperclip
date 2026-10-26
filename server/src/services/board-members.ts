import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import {
  AGENT_SENTINEL_USER_ID,
  type BoardMember,
  type BoardMembersResponse,
} from "@paperclipai/shared";

/**
 * The Board is the set of users holding `instance_admin`, excluding the
 * `local-board` agent-posting sentinel. Agents are never Board members and
 * there is no second mechanism (doc/plans/2026-10-26-operator-identity-and-
 * board-ownership.md, Spec 6). Every surface that needs "who is the Board"
 * (Instance Access page, org chart root, approval addressee copy) resolves it
 * through this module so they cannot drift.
 */

type BoardMembersRunner = Pick<Db, "select">;

const INSTANCE_SETTINGS_SINGLETON_KEY = "default";

/**
 * Spec 2 records the operator in `instance_settings.general.operatorUserId`.
 * That field is owned by another change, so it is read defensively here: a
 * missing or malformed value means "unknown", never "nobody".
 */
export async function readRecordedOperatorUserId(db: BoardMembersRunner): Promise<string | null> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const general = row?.general;
  if (!general || typeof general !== "object") return null;
  const value = (general as Record<string, unknown>).operatorUserId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function boardMemberDisplayName(member: { id: string; name: string | null; email: string | null }): string {
  return member.name?.trim() || member.email?.trim() || member.id.slice(0, 8);
}

export async function listBoardMembers(db: BoardMembersRunner): Promise<BoardMembersResponse> {
  const [roles, operatorUserId] = await Promise.all([
    db
      .select({ userId: instanceUserRoles.userId, createdAt: instanceUserRoles.createdAt })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin")),
    readRecordedOperatorUserId(db),
  ]);

  const legacySentinelHoldsAdmin = roles.some((role) => role.userId === AGENT_SENTINEL_USER_ID);
  const memberRoles = roles.filter((role) => role.userId !== AGENT_SENTINEL_USER_ID);
  const userIds = memberRoles.map((role) => role.userId);
  const users = userIds.length
    ? await db
        .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name, image: authUsers.image })
        .from(authUsers)
        .where(inArray(authUsers.id, userIds))
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));

  const members: BoardMember[] = memberRoles
    .map((role) => {
      const user = userById.get(role.userId) ?? null;
      return {
        id: role.userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        image: user?.image ?? null,
        isOperator: operatorUserId ? operatorUserId === role.userId : null,
        memberSince: role.createdAt,
      };
    })
    .sort((left, right) => boardMemberDisplayName(left).localeCompare(boardMemberDisplayName(right)));

  return { members, operatorUserId, legacySentinelHoldsAdmin };
}

/**
 * How an approval addressed to the sentinel names who may decide it: the
 * recorded operator when they sit on the Board, otherwise the real member
 * list ("Dana or Lee"), never "the Board owner" for a sentinel.
 */
export async function describeBoardAddressee(db: BoardMembersRunner): Promise<string> {
  const { members, operatorUserId } = await listBoardMembers(db);
  const operator = operatorUserId ? members.find((member) => member.id === operatorUserId) : null;
  if (operator) return boardMemberDisplayName(operator);
  if (members.length === 0) return "a Board member";
  const names = members.map(boardMemberDisplayName);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
