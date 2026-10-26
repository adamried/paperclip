/**
 * Identity reconciliation for a populated instance.
 *
 * Moves operational ownership from a source user (today always `local-board`)
 * to a verified target user that already holds `instance_admin`. Historical
 * attribution (class B) and the agent-posting sentinel (class C) are never
 * rewritten; personal credentials (class D) are reported for re-authorization
 * and never copied.
 *
 * This module lives in `@paperclipai/db` rather than `server/` so that both the
 * CLI (which bundles `@paperclipai/db` and only loads `@paperclipai/server`
 * dynamically at runtime) and the server (for a later preview endpoint) can
 * import it. See `doc/plans/2026-10-26-operator-identity-and-board-ownership.md`
 * Spec 1 for the reference inventory this file implements.
 */
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client.js";
import {
  activityLog,
  agentApiKeys,
  agentMemberships,
  agents,
  aiConnectionDefaults,
  aiProviderDefaults,
  approvalComments,
  approvals,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrantMembers,
  connectionGrants,
  connectionTokenIssuances,
  decisionQueueItems,
  decisionTriage,
  decisionTriageEvents,
  documentAnnotationComments,
  documentMemberships,
  feedbackExports,
  feedbackVotes,
  heartbeatRuns,
  instanceUserRoles,
  issueComments,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issues,
  principalPermissionGrants,
  projectMemberships,
  routineRevisions,
  routineRuns,
  routines,
  runIdentityContexts,
  toolApplications,
  toolConnections,
  userApprovalDecisionPolicies,
  userInboxAgentPolicies,
} from "./schema/index.js";

export const LOCAL_BOARD_USER_ID = "local-board";
export const IDENTITY_RECONCILIATION_SUPPORTED_SOURCE_USER_IDS: readonly string[] = [LOCAL_BOARD_USER_ID];
export const IDENTITY_RECONCILED_ACTIVITY_ACTION = "identity.reconciled";

const ACTIVE_HEARTBEAT_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const OPEN_INTERACTION_STATUSES = ["pending"] as const;

export type IdentityReconciliationErrorCode =
  | "source_not_supported"
  | "source_equals_target"
  | "target_not_found"
  | "target_ambiguous"
  | "target_not_instance_admin";

export class IdentityReconciliationError extends Error {
  readonly code: IdentityReconciliationErrorCode;
  readonly remedy: string | null;

  constructor(code: IdentityReconciliationErrorCode, message: string, remedy: string | null = null) {
    super(message);
    this.name = "IdentityReconciliationError";
    this.code = code;
    this.remedy = remedy;
  }
}

export type IdentityReconciliationClass = "A" | "B" | "C" | "D";

export type IdentityReconciliationAction =
  /** Source rows are rewritten to point at the target. */
  | "move"
  /** Source rows are rewritten unless the target already has an equivalent row (then skipped). */
  | "merge"
  /** Target rows are inserted as copies; source rows are left alone. */
  | "copy"
  /** Target rows are inserted or activated so the target holds the same access. */
  | "ensure"
  /** Counted only. Never written. */
  | "report";

export type IdentityReconciliationEntry = {
  class: IdentityReconciliationClass;
  table: string;
  column: string;
  action: IdentityReconciliationAction;
  /** Rows matching the source user under this entry's predicate. */
  matched: number;
  /** Rows that were (apply) or would be (preview) written. */
  changed: number;
  /** Rows left alone because the target already holds an equivalent row. */
  skipped: number;
  /** Per-company breakdown of `matched`. Instance-level tables use the key `instance`. */
  byCompany: Record<string, number>;
  /** Per-company breakdown of `changed`. */
  changedByCompany: Record<string, number>;
  note?: string;
};

export type IdentityReconciliationReauthorizeItem = {
  kind: "connection_grant" | "company_secret";
  companyId: string;
  id: string;
  name: string;
  detail: string;
  status: string;
  reason: string;
};

export type IdentityReconciliationUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type IdentityReconciliationReport = {
  mode: "preview" | "apply";
  generatedAt: string;
  fromUserId: string;
  toUser: IdentityReconciliationUser;
  includeBoardKeys: boolean;
  companies: Array<{ id: string; name: string }>;
  entries: IdentityReconciliationEntry[];
  reauthorize: IdentityReconciliationReauthorizeItem[];
  /** `ai_*_defaults` rows copied to the target that still point at a class D grant. */
  defaultsPointingAtPersonalGrants: Array<{
    table: "ai_connection_defaults" | "ai_provider_defaults";
    companyId: string;
    provider: string;
    method: string | null;
    grantId: string;
  }>;
  sourceUserExists: boolean;
  sourceHoldsInstanceAdmin: boolean;
  warnings: string[];
  totals: { matched: number; changed: number; skipped: number };
  activityLogRowsWritten: number;
};

type DbExecutor = Pick<Db, "select" | "insert" | "update" | "execute">;

type RefRow = { id: string; companyId: string | null };

type StepContext = {
  exec: DbExecutor;
  fromUserId: string;
  toUserId: string;
  dryRun: boolean;
  entries: IdentityReconciliationEntry[];
  warnings: string[];
};

function groupByCompany(rows: RefRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.companyId ?? "instance";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function pushEntry(
  ctx: StepContext,
  entry: Omit<IdentityReconciliationEntry, "byCompany" | "changedByCompany" | "matched" | "changed"> & {
    /** Every row matching the predicate. */
    rows: RefRow[];
    /** Rows written (apply) or that would be written (preview). */
    changedRows: RefRow[];
  },
): void {
  const { rows, changedRows, ...rest } = entry;
  ctx.entries.push({
    ...rest,
    matched: rows.length,
    changed: changedRows.length,
    byCompany: groupByCompany(rows),
    changedByCompany: groupByCompany(changedRows),
  });
}

async function selectRefs(
  exec: DbExecutor,
  table: AnyPgTable,
  idColumn: AnyPgColumn,
  companyColumn: AnyPgColumn | null,
  where: SQL,
): Promise<RefRow[]> {
  const rows = await exec
    .select({ id: idColumn, companyId: companyColumn ?? sql<string | null>`null` })
    .from(table)
    .where(where);
  return rows.map((row) => ({
    id: String(row.id),
    companyId: row.companyId == null ? null : String(row.companyId),
  }));
}

async function rewriteUserColumn(
  exec: DbExecutor,
  table: AnyPgTable,
  idColumn: AnyPgColumn,
  userColumn: AnyPgColumn,
  updatedAtColumn: AnyPgColumn | null,
  ids: string[],
  toUserId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const setUpdatedAt = updatedAtColumn ? sql`, ${sql.identifier(updatedAtColumn.name)} = now()` : sql``;
  await exec.execute(
    sql`update ${table} set ${sql.identifier(userColumn.name)} = ${toUserId}${setUpdatedAt} where ${inArray(idColumn, ids)}`,
  );
}

/** Class A "move": rewrite every matching source row to the target. */
async function moveColumn(
  ctx: StepContext,
  spec: {
    table: AnyPgTable;
    tableName: string;
    idColumn: AnyPgColumn;
    companyColumn: AnyPgColumn | null;
    userColumn: AnyPgColumn;
    updatedAtColumn: AnyPgColumn | null;
    extraWhere?: SQL;
    note?: string;
  },
): Promise<RefRow[]> {
  const where = spec.extraWhere
    ? and(eq(spec.userColumn, ctx.fromUserId), spec.extraWhere)!
    : eq(spec.userColumn, ctx.fromUserId);
  const rows = await selectRefs(ctx.exec, spec.table, spec.idColumn, spec.companyColumn, where);
  if (!ctx.dryRun) {
    await rewriteUserColumn(
      ctx.exec,
      spec.table,
      spec.idColumn,
      spec.userColumn,
      spec.updatedAtColumn,
      rows.map((row) => row.id),
      ctx.toUserId,
    );
  }
  pushEntry(ctx, {
    class: "A",
    table: spec.tableName,
    column: spec.userColumn.name,
    action: "move",
    skipped: 0,
    rows,
    changedRows: rows,
    ...(spec.note ? { note: spec.note } : {}),
  });
  return rows;
}

/**
 * Class A "merge": rewrite source rows to the target unless the target already
 * holds a row with the same conflict key. Conflicting source rows are left
 * untouched and counted as skipped.
 */
async function mergeColumn(
  ctx: StepContext,
  spec: {
    table: AnyPgTable;
    tableName: string;
    idColumn: AnyPgColumn;
    companyColumn: AnyPgColumn | null;
    userColumn: AnyPgColumn;
    updatedAtColumn: AnyPgColumn | null;
    /** Columns (other than the user column) that make a row unique. */
    keyColumns: AnyPgColumn[];
    extraWhere?: SQL;
    note?: string;
  },
): Promise<void> {
  const selection: Record<string, AnyPgColumn> = { id: spec.idColumn };
  spec.keyColumns.forEach((column, index) => {
    selection[`k${index}`] = column;
  });
  const keyOf = (row: Record<string, unknown>) =>
    spec.keyColumns.map((_, index) => String(row[`k${index}`] ?? "")).join("\u0000");

  const baseSource = eq(spec.userColumn, ctx.fromUserId);
  const baseTarget = eq(spec.userColumn, ctx.toUserId);
  const sourceRows = (await ctx.exec
    .select({ ...selection, companyId: spec.companyColumn ?? sql<string | null>`null` })
    .from(spec.table)
    .where(spec.extraWhere ? and(baseSource, spec.extraWhere) : baseSource)) as Array<Record<string, unknown>>;
  const targetRows = (await ctx.exec
    .select(selection)
    .from(spec.table)
    .where(spec.extraWhere ? and(baseTarget, spec.extraWhere) : baseTarget)) as Array<Record<string, unknown>>;
  const targetKeys = new Set(targetRows.map(keyOf));

  const movable: RefRow[] = [];
  let skipped = 0;
  const allRows: RefRow[] = [];
  for (const row of sourceRows) {
    const ref: RefRow = {
      id: String(row.id),
      companyId: row.companyId == null ? null : String(row.companyId),
    };
    allRows.push(ref);
    if (targetKeys.has(keyOf(row))) skipped += 1;
    else movable.push(ref);
  }

  if (!ctx.dryRun) {
    await rewriteUserColumn(
      ctx.exec,
      spec.table,
      spec.idColumn,
      spec.userColumn,
      spec.updatedAtColumn,
      movable.map((row) => row.id),
      ctx.toUserId,
    );
  }
  pushEntry(ctx, {
    class: "A",
    table: spec.tableName,
    column: spec.userColumn.name,
    action: "merge",
    skipped,
    rows: allRows,
    changedRows: movable,
    ...(spec.note ? { note: spec.note } : {}),
  });
}

/** Class B/C "report": count matching rows, write nothing. */
async function reportColumn(
  ctx: StepContext,
  spec: {
    class: "B" | "C";
    table: AnyPgTable;
    tableName: string;
    idColumn: AnyPgColumn;
    companyColumn: AnyPgColumn | null;
    userColumn: AnyPgColumn;
    extraWhere?: SQL;
    note?: string;
  },
): Promise<void> {
  const where = spec.extraWhere
    ? and(eq(spec.userColumn, ctx.fromUserId), spec.extraWhere)!
    : eq(spec.userColumn, ctx.fromUserId);
  const rows = await selectRefs(ctx.exec, spec.table, spec.idColumn, spec.companyColumn, where);
  pushEntry(ctx, {
    class: spec.class,
    table: spec.tableName,
    column: spec.userColumn.name,
    action: "report",
    skipped: 0,
    rows,
    changedRows: [],
    ...(spec.note ? { note: spec.note } : {}),
  });
}

async function listActiveRunIds(exec: DbExecutor): Promise<string[]> {
  const rows = await exec
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, [...ACTIVE_HEARTBEAT_RUN_STATUSES]));
  return rows.map((row) => row.id);
}

async function loadPersonalGrantIds(exec: DbExecutor, fromUserId: string): Promise<Set<string>> {
  const rows = await exec
    .select({ id: connectionGrants.id })
    .from(connectionGrants)
    .where(and(eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, fromUserId)));
  return new Set(rows.map((row) => row.id));
}

export async function resolveIdentityReconciliationTarget(
  db: DbExecutor,
  toRef: string,
): Promise<IdentityReconciliationUser> {
  const needle = toRef.trim();
  if (!needle) {
    throw new IdentityReconciliationError("target_not_found", "A target user id or email is required.");
  }

  const byId = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, needle))
    .then((rows) => rows[0] ?? null);
  if (byId) return byId;

  const byEmail = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = lower(${needle})`);
  if (byEmail.length === 1) return byEmail[0]!;
  if (byEmail.length > 1) {
    throw new IdentityReconciliationError(
      "target_ambiguous",
      `Email ${needle} matches ${byEmail.length} users (${byEmail.map((row) => row.id).join(", ")}). Pass --to <userId> instead.`,
    );
  }
  throw new IdentityReconciliationError("target_not_found", `No user matches ${needle} by id or email.`);
}

async function targetHoldsInstanceAdmin(exec: DbExecutor, userId: string): Promise<boolean> {
  const row = await exec
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

function assertSupportedSource(fromUserId: string): void {
  if (!IDENTITY_RECONCILIATION_SUPPORTED_SOURCE_USER_IDS.includes(fromUserId)) {
    throw new IdentityReconciliationError(
      "source_not_supported",
      `Only ${IDENTITY_RECONCILIATION_SUPPORTED_SOURCE_USER_IDS.map((id) => `--from ${id}`).join(", ")} is supported. Merging two named human accounts is out of scope.`,
    );
  }
}

async function assertTargetEligible(exec: DbExecutor, fromUserId: string, toUser: IdentityReconciliationUser): Promise<void> {
  if (toUser.id === fromUserId) {
    throw new IdentityReconciliationError("source_equals_target", "Source and target are the same user.");
  }
  if (!(await targetHoldsInstanceAdmin(exec, toUser.id))) {
    throw new IdentityReconciliationError(
      "target_not_instance_admin",
      `Target user ${toUser.id} does not hold instance_admin.`,
      `paperclipai admin user promote ${toUser.id}`,
    );
  }
}

export type IdentityReconciliationInput = {
  fromUserId: string;
  /** Resolved target user. Use `resolveIdentityReconciliationTarget` to turn an id or email into one. */
  toUser: IdentityReconciliationUser;
  includeBoardKeys?: boolean;
};

async function runReconciliation(
  exec: DbExecutor,
  input: IdentityReconciliationInput,
  dryRun: boolean,
): Promise<Omit<IdentityReconciliationReport, "mode" | "activityLogRowsWritten">> {
  const fromUserId = input.fromUserId;
  const toUserId = input.toUser.id;
  const includeBoardKeys = input.includeBoardKeys === true;
  const ctx: StepContext = { exec, fromUserId, toUserId, dryRun, entries: [], warnings: [] };

  const companyRows = await exec.select({ id: companies.id, name: companies.name }).from(companies);
  const sourceUser = await exec
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, fromUserId))
    .then((rows) => rows[0] ?? null);
  if (!sourceUser) {
    ctx.warnings.push(
      `Source user ${fromUserId} has no auth user row. References are reconciled anyway; nothing is created for the source.`,
    );
  }

  const activeRunIds = await listActiveRunIds(exec);
  const personalGrantIds = await loadPersonalGrantIds(exec, fromUserId);

  // ---------------------------------------------------------------------
  // Class A: operational references, move to target.
  // ---------------------------------------------------------------------
  await moveColumn(ctx, {
    table: issues, tableName: "issues", idColumn: issues.id, companyColumn: issues.companyId,
    userColumn: issues.assigneeUserId, updatedAtColumn: issues.updatedAt,
  });
  await moveColumn(ctx, {
    table: issues, tableName: "issues", idColumn: issues.id, companyColumn: issues.companyId,
    userColumn: issues.responsibleUserId, updatedAtColumn: issues.updatedAt,
  });
  await mergeColumn(ctx, {
    table: issues, tableName: "issues", idColumn: issues.id, companyColumn: issues.companyId,
    userColumn: issues.conversationUserId, updatedAtColumn: issues.updatedAt,
    keyColumns: [issues.companyId, issues.conversationAgentId],
    note: "A conversation the target already has with the same agent is skipped (unique per company, agent, user).",
  });
  await moveColumn(ctx, {
    table: issueTreeHoldMembers, tableName: "issue_tree_hold_members", idColumn: issueTreeHoldMembers.id,
    companyColumn: issueTreeHoldMembers.companyId, userColumn: issueTreeHoldMembers.assigneeUserId, updatedAtColumn: null,
  });
  await moveColumn(ctx, {
    table: approvals, tableName: "approvals", idColumn: approvals.id, companyColumn: approvals.companyId,
    userColumn: approvals.addresseeUserId, updatedAtColumn: approvals.updatedAt,
    extraWhere: inArray(approvals.status, [...OPEN_APPROVAL_STATUSES]),
    note: "Open approvals only (pending, revision_requested). The addressee changes; nothing is decided.",
  });
  await moveColumn(ctx, {
    table: issueThreadInteractions, tableName: "issue_thread_interactions", idColumn: issueThreadInteractions.id,
    companyColumn: issueThreadInteractions.companyId, userColumn: issueThreadInteractions.addresseeUserId,
    updatedAtColumn: issueThreadInteractions.updatedAt,
    extraWhere: inArray(issueThreadInteractions.status, [...OPEN_INTERACTION_STATUSES]),
    note: "Unresolved interactions only. Nothing is resolved.",
  });
  await moveColumn(ctx, {
    table: agents, tableName: "agents", idColumn: agents.id, companyColumn: agents.companyId,
    userColumn: agents.reportsToUserId, updatedAtColumn: agents.updatedAt,
  });
  await moveColumn(ctx, {
    table: companies, tableName: "companies", idColumn: companies.id, companyColumn: companies.id,
    userColumn: companies.defaultResponsibleUserId, updatedAtColumn: companies.updatedAt,
  });
  await moveColumn(ctx, {
    table: routines, tableName: "routines", idColumn: routines.id, companyColumn: routines.companyId,
    userColumn: routines.responsibleUserId, updatedAtColumn: routines.updatedAt,
  });
  await moveColumn(ctx, {
    table: agentApiKeys, tableName: "agent_api_keys", idColumn: agentApiKeys.id, companyColumn: agentApiKeys.companyId,
    userColumn: agentApiKeys.responsibleUserId, updatedAtColumn: null,
    extraWhere: isNull(agentApiKeys.revokedAt),
    note: "Active (non-revoked) keys only.",
  });
  await moveColumn(ctx, {
    table: heartbeatRuns, tableName: "heartbeat_runs", idColumn: heartbeatRuns.id, companyColumn: heartbeatRuns.companyId,
    userColumn: heartbeatRuns.responsibleUserId, updatedAtColumn: heartbeatRuns.updatedAt,
    extraWhere: inArray(heartbeatRuns.status, [...ACTIVE_HEARTBEAT_RUN_STATUSES]),
    note: "Active runs only (queued, scheduled_retry, running).",
  });
  await moveColumn(ctx, {
    table: runIdentityContexts, tableName: "run_identity_contexts", idColumn: runIdentityContexts.id,
    companyColumn: runIdentityContexts.companyId, userColumn: runIdentityContexts.responsibleUserId, updatedAtColumn: null,
    extraWhere: activeRunIds.length > 0 ? inArray(runIdentityContexts.runId, activeRunIds) : sql`false`,
    note: "Contexts of active runs only.",
  });
  await moveColumn(ctx, {
    table: toolApplications, tableName: "tool_applications", idColumn: toolApplications.id,
    companyColumn: toolApplications.companyId, userColumn: toolApplications.ownerUserId,
    updatedAtColumn: toolApplications.updatedAt,
    extraWhere: isNull(toolApplications.archivedAt),
    note: "Non-archived applications only.",
  });
  await mergeColumn(ctx, {
    table: connectionGrantMembers, tableName: "connection_grant_members", idColumn: connectionGrantMembers.id,
    companyColumn: connectionGrantMembers.companyId, userColumn: connectionGrantMembers.subjectId, updatedAtColumn: null,
    keyColumns: [connectionGrantMembers.grantId, connectionGrantMembers.subjectType],
    extraWhere: eq(connectionGrantMembers.subjectType, "user"),
    note: "Membership in shared (organization) grants. The credential itself is not personal.",
  });
  await mergeColumn(ctx, {
    table: userApprovalDecisionPolicies, tableName: "user_approval_decision_policies",
    idColumn: userApprovalDecisionPolicies.id, companyColumn: userApprovalDecisionPolicies.companyId,
    userColumn: userApprovalDecisionPolicies.userId, updatedAtColumn: userApprovalDecisionPolicies.updatedAt,
    keyColumns: [userApprovalDecisionPolicies.companyId],
  });
  await mergeColumn(ctx, {
    table: userInboxAgentPolicies, tableName: "user_inbox_agent_policies",
    idColumn: userInboxAgentPolicies.id, companyColumn: userInboxAgentPolicies.companyId,
    userColumn: userInboxAgentPolicies.userId, updatedAtColumn: userInboxAgentPolicies.updatedAt,
    keyColumns: [userInboxAgentPolicies.companyId],
  });
  await mergeColumn(ctx, {
    table: principalPermissionGrants, tableName: "principal_permission_grants",
    idColumn: principalPermissionGrants.id, companyColumn: principalPermissionGrants.companyId,
    userColumn: principalPermissionGrants.principalId, updatedAtColumn: principalPermissionGrants.updatedAt,
    keyColumns: [principalPermissionGrants.companyId, principalPermissionGrants.principalType, principalPermissionGrants.permissionKey],
    extraWhere: eq(principalPermissionGrants.principalType, "user"),
  });
  await mergeColumn(ctx, {
    table: projectMemberships, tableName: "project_memberships", idColumn: projectMemberships.id,
    companyColumn: projectMemberships.companyId, userColumn: projectMemberships.userId,
    updatedAtColumn: projectMemberships.updatedAt,
    keyColumns: [projectMemberships.companyId, projectMemberships.projectId],
  });
  await mergeColumn(ctx, {
    table: documentMemberships, tableName: "document_memberships", idColumn: documentMemberships.id,
    companyColumn: documentMemberships.companyId, userColumn: documentMemberships.userId,
    updatedAtColumn: documentMemberships.updatedAt,
    keyColumns: [documentMemberships.companyId, documentMemberships.documentId],
  });
  await mergeColumn(ctx, {
    table: agentMemberships, tableName: "agent_memberships", idColumn: agentMemberships.id,
    companyColumn: agentMemberships.companyId, userColumn: agentMemberships.userId,
    updatedAtColumn: agentMemberships.updatedAt,
    keyColumns: [agentMemberships.companyId, agentMemberships.agentId],
  });

  // ai_connection_defaults / ai_provider_defaults: copy into the target, leave the source rows.
  //
  // Read the target's provider defaults before copying connection defaults: the
  // `ai_connection_defaults_sync_provider` trigger (migration 0277) inserts a
  // provider default for every copied method default. Rows the target chose
  // before this run are preserved; rows the trigger seeds are overwritten below
  // with the source's explicit provider choice so preview and apply agree.
  const defaultsPointingAtPersonalGrants: IdentityReconciliationReport["defaultsPointingAtPersonalGrants"] = [];
  const preExistingTargetProviderDefaults = new Set(
    (
      await exec
        .select({ companyId: aiProviderDefaults.companyId, provider: aiProviderDefaults.provider })
        .from(aiProviderDefaults)
        .where(eq(aiProviderDefaults.userId, toUserId))
    ).map((row) => `${row.companyId}\u0000${row.provider}`),
  );
  {
    const sourceRows = await exec
      .select()
      .from(aiConnectionDefaults)
      .where(eq(aiConnectionDefaults.userId, fromUserId));
    const targetRows = await exec
      .select({ companyId: aiConnectionDefaults.companyId, provider: aiConnectionDefaults.provider, method: aiConnectionDefaults.method })
      .from(aiConnectionDefaults)
      .where(eq(aiConnectionDefaults.userId, toUserId));
    const have = new Set(targetRows.map((row) => `${row.companyId}\u0000${row.provider}\u0000${row.method}`));
    const toCopy = sourceRows.filter((row) => !have.has(`${row.companyId}\u0000${row.provider}\u0000${row.method}`));
    if (!dryRun && toCopy.length > 0) {
      await exec
        .insert(aiConnectionDefaults)
        .values(
          toCopy.map((row) => ({
            companyId: row.companyId,
            userId: toUserId,
            provider: row.provider,
            method: row.method,
            grantId: row.grantId,
          })),
        )
        .onConflictDoNothing();
    }
    for (const row of toCopy) {
      if (row.grantId && personalGrantIds.has(row.grantId)) {
        defaultsPointingAtPersonalGrants.push({
          table: "ai_connection_defaults", companyId: row.companyId, provider: row.provider, method: row.method, grantId: row.grantId,
        });
      }
    }
    pushEntry(ctx, {
      class: "A", table: "ai_connection_defaults", column: "user_id", action: "copy",
      skipped: sourceRows.length - toCopy.length,
      rows: sourceRows.map((row) => ({ id: row.id, companyId: row.companyId })),
      changedRows: toCopy.map((row) => ({ id: row.id, companyId: row.companyId })),
      note: "Copied to the target; source rows are left in place. A copied default that points at a personal grant stays unavailable until re-authorized.",
    });
  }
  {
    const sourceRows = await exec
      .select()
      .from(aiProviderDefaults)
      .where(eq(aiProviderDefaults.userId, fromUserId));
    const toCopy = sourceRows.filter(
      (row) => !preExistingTargetProviderDefaults.has(`${row.companyId}\u0000${row.provider}`),
    );
    if (!dryRun && toCopy.length > 0) {
      await exec
        .insert(aiProviderDefaults)
        .values(
          toCopy.map((row) => ({
            companyId: row.companyId,
            userId: toUserId,
            provider: row.provider,
            grantId: row.grantId,
          })),
        )
        // Overwrite only what the sync trigger seeded moments ago; pre-existing target rows were excluded above.
        .onConflictDoUpdate({
          target: [aiProviderDefaults.companyId, aiProviderDefaults.userId, aiProviderDefaults.provider],
          set: { grantId: sql`excluded.grant_id`, updatedAt: new Date() },
        });
    }
    for (const row of toCopy) {
      if (row.grantId && personalGrantIds.has(row.grantId)) {
        defaultsPointingAtPersonalGrants.push({
          table: "ai_provider_defaults", companyId: row.companyId, provider: row.provider, method: null, grantId: row.grantId,
        });
      }
    }
    pushEntry(ctx, {
      class: "A", table: "ai_provider_defaults", column: "user_id", action: "copy",
      skipped: sourceRows.length - toCopy.length,
      rows: sourceRows.map((row) => ({ id: row.id, companyId: row.companyId })),
      changedRows: toCopy.map((row) => ({ id: row.id, companyId: row.companyId })),
      note: "Copied to the target; source rows are left in place.",
    });
  }

  // company_memberships: ensure the target holds an active owner membership wherever the source does.
  {
    const sourceMemberships = await exec
      .select({ id: companyMemberships.id, companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, fromUserId),
          eq(companyMemberships.status, "active"),
        ),
      );
    const targetMemberships = await exec
      .select({ id: companyMemberships.id, companyId: companyMemberships.companyId, status: companyMemberships.status })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, toUserId)));
    const targetByCompany = new Map(targetMemberships.map((row) => [row.companyId, row]));
    const needsInsert: string[] = [];
    const needsActivate: string[] = [];
    const changedRows: RefRow[] = [];
    for (const membership of sourceMemberships) {
      const existing = targetByCompany.get(membership.companyId);
      if (!existing) {
        needsInsert.push(membership.companyId);
        changedRows.push({ id: membership.id, companyId: membership.companyId });
      } else if (existing.status !== "active") {
        needsActivate.push(existing.id);
        changedRows.push({ id: existing.id, companyId: membership.companyId });
      }
    }
    if (!dryRun) {
      if (needsInsert.length > 0) {
        await exec
          .insert(companyMemberships)
          .values(
            needsInsert.map((companyId) => ({
              companyId,
              principalType: "user",
              principalId: toUserId,
              status: "active",
              membershipRole: "owner",
            })),
          )
          .onConflictDoNothing();
      }
      if (needsActivate.length > 0) {
        await exec
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(inArray(companyMemberships.id, needsActivate));
      }
    }
    pushEntry(ctx, {
      class: "A", table: "company_memberships", column: "principal_id", action: "ensure",
      skipped: sourceMemberships.length - changedRows.length,
      rows: sourceMemberships.map((row) => ({ id: row.id, companyId: row.companyId })),
      changedRows,
      note: "Target gets an active owner membership in every company where the source is an active member. Source memberships are left in place.",
    });
  }

  // instance_user_roles: the target is verified before this runs; the source role is reported, never removed.
  const sourceHoldsInstanceAdmin = await targetHoldsInstanceAdmin(exec, fromUserId);
  pushEntry(ctx, {
    class: "A", table: "instance_user_roles", column: "user_id", action: "report",
    skipped: 0,
    rows: sourceHoldsInstanceAdmin ? [{ id: fromUserId, companyId: null }] : [],
    changedRows: [],
    note: sourceHoldsInstanceAdmin
      ? "Source still holds instance_admin. Left unchanged: the local board needs it while the instance runs in local_trusted mode. The board-claim flow or `admin user demote` removes it."
      : "Target holds instance_admin (verified). Source holds no instance_admin role.",
  });
  if (sourceHoldsInstanceAdmin) {
    ctx.warnings.push(
      `${fromUserId} still holds instance_admin. This command never removes it; demote it with the board-claim flow or \`paperclipai admin user demote ${fromUserId}\` once the instance runs in authenticated mode.`,
    );
  }

  // board_api_keys: instance-level, moved only on explicit request.
  {
    const rows = await selectRefs(
      exec, boardApiKeys, boardApiKeys.id, null,
      and(eq(boardApiKeys.userId, fromUserId), isNull(boardApiKeys.revokedAt))!,
    );
    if (includeBoardKeys && !dryRun) {
      await rewriteUserColumn(exec, boardApiKeys, boardApiKeys.id, boardApiKeys.userId, null, rows.map((row) => row.id), toUserId);
    }
    pushEntry(ctx, {
      class: "A", table: "board_api_keys", column: "user_id", action: includeBoardKeys ? "move" : "report",
      skipped: 0, rows, changedRows: includeBoardKeys ? rows : [],
      note: includeBoardKeys
        ? "Active board API keys moved to the target (--include-board-keys)."
        : "Active board API keys are listed only. Pass --include-board-keys to move them.",
    });
    if (!includeBoardKeys && rows.length > 0) {
      ctx.warnings.push(
        `${rows.length} active board API key(s) still belong to ${fromUserId}. Re-run with --include-board-keys to move them, or revoke them.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Class B: historical attribution, counted only (representative columns).
  // ---------------------------------------------------------------------
  await reportColumn(ctx, {
    class: "B", table: issues, tableName: "issues", idColumn: issues.id, companyColumn: issues.companyId,
    userColumn: issues.createdByUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: approvals, tableName: "approvals", idColumn: approvals.id, companyColumn: approvals.companyId,
    userColumn: approvals.addresseeUserId, extraWhere: notInArray(approvals.status, [...OPEN_APPROVAL_STATUSES]),
    note: "Resolved approvals keep their original addressee.",
  });
  await reportColumn(ctx, {
    class: "B", table: approvals, tableName: "approvals", idColumn: approvals.id, companyColumn: approvals.companyId,
    userColumn: approvals.decidedByUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: approvals, tableName: "approvals", idColumn: approvals.id, companyColumn: approvals.companyId,
    userColumn: approvals.requestedByUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: issueThreadInteractions, tableName: "issue_thread_interactions", idColumn: issueThreadInteractions.id,
    companyColumn: issueThreadInteractions.companyId, userColumn: issueThreadInteractions.addresseeUserId,
    extraWhere: notInArray(issueThreadInteractions.status, [...OPEN_INTERACTION_STATUSES]),
    note: "Resolved interactions keep their original addressee.",
  });
  await reportColumn(ctx, {
    class: "B", table: issueThreadInteractions, tableName: "issue_thread_interactions", idColumn: issueThreadInteractions.id,
    companyColumn: issueThreadInteractions.companyId, userColumn: issueThreadInteractions.resolvedByUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: heartbeatRuns, tableName: "heartbeat_runs", idColumn: heartbeatRuns.id, companyColumn: heartbeatRuns.companyId,
    userColumn: heartbeatRuns.responsibleUserId, extraWhere: notInArray(heartbeatRuns.status, [...ACTIVE_HEARTBEAT_RUN_STATUSES]),
    note: "Finished runs.",
  });
  await reportColumn(ctx, {
    class: "B", table: runIdentityContexts, tableName: "run_identity_contexts", idColumn: runIdentityContexts.id,
    companyColumn: runIdentityContexts.companyId, userColumn: runIdentityContexts.responsibleUserId,
    extraWhere: activeRunIds.length > 0 ? notInArray(runIdentityContexts.runId, activeRunIds) : sql`true`,
    note: "Contexts of finished or deleted runs.",
  });
  await reportColumn(ctx, {
    class: "B", table: routineRevisions, tableName: "routine_revisions", idColumn: routineRevisions.id,
    companyColumn: routineRevisions.companyId, userColumn: routineRevisions.responsibleUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: routineRuns, tableName: "routine_runs", idColumn: routineRuns.id,
    companyColumn: routineRuns.companyId, userColumn: routineRuns.responsibleUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: decisionQueueItems, tableName: "decision_queue_items", idColumn: decisionQueueItems.id,
    companyColumn: decisionQueueItems.companyId, userColumn: decisionQueueItems.responsibleUserId,
    note: "Provenance of queue membership (doc/DATABASE.md, decision queues and triage provenance).",
  });
  await reportColumn(ctx, {
    class: "B", table: decisionTriage, tableName: "decision_triage", idColumn: decisionTriage.id,
    companyColumn: decisionTriage.companyId, userColumn: decisionTriage.responsibleUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: decisionTriageEvents, tableName: "decision_triage_events", idColumn: decisionTriageEvents.id,
    companyColumn: decisionTriageEvents.companyId, userColumn: decisionTriageEvents.responsibleUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: activityLog, tableName: "activity_log", idColumn: activityLog.id, companyColumn: activityLog.companyId,
    userColumn: activityLog.actorId, extraWhere: eq(activityLog.actorType, "user"),
  });
  await reportColumn(ctx, {
    class: "B", table: connectionTokenIssuances, tableName: "connection_token_issuances", idColumn: connectionTokenIssuances.id,
    companyColumn: connectionTokenIssuances.companyId, userColumn: connectionTokenIssuances.responsibleUserId,
  });
  await reportColumn(ctx, {
    class: "B", table: agentApiKeys, tableName: "agent_api_keys", idColumn: agentApiKeys.id, companyColumn: agentApiKeys.companyId,
    userColumn: agentApiKeys.responsibleUserId, extraWhere: isNotNull(agentApiKeys.revokedAt), note: "Revoked keys.",
  });
  await reportColumn(ctx, {
    class: "B", table: toolApplications, tableName: "tool_applications", idColumn: toolApplications.id,
    companyColumn: toolApplications.companyId, userColumn: toolApplications.ownerUserId,
    extraWhere: isNotNull(toolApplications.archivedAt), note: "Archived applications.",
  });
  await reportColumn(ctx, {
    class: "B", table: boardApiKeys, tableName: "board_api_keys", idColumn: boardApiKeys.id, companyColumn: null,
    userColumn: boardApiKeys.userId, extraWhere: isNotNull(boardApiKeys.revokedAt), note: "Revoked keys.",
  });

  // ---------------------------------------------------------------------
  // Class C: agent sentinel authorship, counted only.
  // ---------------------------------------------------------------------
  const sentinelNote =
    "Comments posted through agent runs carry the sentinel author. A human comment typed in local mode is indistinguishable by author alone, so nothing is rewritten.";
  await reportColumn(ctx, {
    class: "C", table: issueComments, tableName: "issue_comments", idColumn: issueComments.id,
    companyColumn: issueComments.companyId, userColumn: issueComments.authorUserId, note: sentinelNote,
  });
  await reportColumn(ctx, {
    class: "C", table: issueComments, tableName: "issue_comments", idColumn: issueComments.id,
    companyColumn: issueComments.companyId, userColumn: issueComments.onBehalfOfUserId,
  });
  await reportColumn(ctx, {
    class: "C", table: approvalComments, tableName: "approval_comments", idColumn: approvalComments.id,
    companyColumn: approvalComments.companyId, userColumn: approvalComments.authorUserId,
  });
  await reportColumn(ctx, {
    class: "C", table: documentAnnotationComments, tableName: "document_annotation_comments",
    idColumn: documentAnnotationComments.id, companyColumn: documentAnnotationComments.companyId,
    userColumn: documentAnnotationComments.authorUserId,
  });
  await reportColumn(ctx, {
    class: "C", table: feedbackVotes, tableName: "feedback_votes", idColumn: feedbackVotes.id,
    companyColumn: feedbackVotes.companyId, userColumn: feedbackVotes.authorUserId,
  });
  await reportColumn(ctx, {
    class: "C", table: feedbackExports, tableName: "feedback_exports", idColumn: feedbackExports.id,
    companyColumn: feedbackExports.companyId, userColumn: feedbackExports.authorUserId,
  });

  // ---------------------------------------------------------------------
  // Class D: personal credentials, reported for re-authorization, never copied.
  // ---------------------------------------------------------------------
  const reauthorize: IdentityReconciliationReauthorizeItem[] = [];
  {
    const grantRows = await exec
      .select({
        id: connectionGrants.id,
        companyId: connectionGrants.companyId,
        status: connectionGrants.status,
        credentialSecretRefs: connectionGrants.credentialSecretRefs,
        externalCredential: connectionGrants.externalCredential,
        providerTenant: connectionGrants.providerTenant,
        connectionName: toolConnections.name,
        connectionPurpose: toolConnections.connectionPurpose,
        authKind: toolConnections.authKind,
        applicationName: toolApplications.name,
      })
      .from(connectionGrants)
      .innerJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId))
      .innerJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
      .where(
        and(
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, fromUserId),
          ne(connectionGrants.status, "revoked"),
        ),
      );
    for (const grant of grantRows) {
      const bindings: string[] = [];
      if ((grant.credentialSecretRefs ?? []).length > 0) bindings.push("vault secret");
      if (grant.externalCredential) bindings.push("external credential");
      if (grant.providerTenant?.oauth) bindings.push("OAuth session");
      reauthorize.push({
        kind: "connection_grant",
        companyId: grant.companyId,
        id: grant.id,
        name: grant.connectionName,
        detail: `${grant.applicationName} (${grant.connectionPurpose}, ${grant.authKind}${bindings.length ? `; ${bindings.join(", ")}` : ""})`,
        status: grant.status,
        reason: "Personal grant bound to the source identity. Moving it would widen access without consent. Re-authorize as the target account.",
      });
    }
    pushEntry(ctx, {
      class: "D", table: "connection_grants", column: "subject_user_id", action: "report",
      skipped: 0,
      rows: grantRows.map((row) => ({ id: row.id, companyId: row.companyId })),
      changedRows: [],
      note: "Personal (kind = user) grants that are not revoked.",
    });
  }
  {
    const secretRows = await exec
      .select({ id: companySecrets.id, companyId: companySecrets.companyId, key: companySecrets.key, name: companySecrets.name, status: companySecrets.status })
      .from(companySecrets)
      .where(and(eq(companySecrets.scope, "user"), eq(companySecrets.ownerUserId, fromUserId), isNull(companySecrets.deletedAt)));
    for (const secret of secretRows) {
      reauthorize.push({
        kind: "company_secret",
        companyId: secret.companyId,
        id: secret.id,
        name: secret.name,
        detail: `key ${secret.key}`,
        status: secret.status,
        reason: "Personal secret owned by the source identity. Re-create it under the target account.",
      });
    }
    pushEntry(ctx, {
      class: "D", table: "company_secrets", column: "owner_user_id", action: "report",
      skipped: 0,
      rows: secretRows.map((row) => ({ id: row.id, companyId: row.companyId })),
      changedRows: [],
      note: "User-scoped secrets that are not deleted.",
    });
  }

  const totals = ctx.entries.reduce(
    (acc, entry) => ({
      matched: acc.matched + entry.matched,
      changed: acc.changed + entry.changed,
      skipped: acc.skipped + entry.skipped,
    }),
    { matched: 0, changed: 0, skipped: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    fromUserId,
    toUser: input.toUser,
    includeBoardKeys,
    companies: companyRows,
    entries: ctx.entries,
    reauthorize,
    defaultsPointingAtPersonalGrants,
    sourceUserExists: sourceUser !== null,
    sourceHoldsInstanceAdmin,
    warnings: ctx.warnings,
    totals,
  };
}

/** Dry run. Reads only; never writes. */
export async function previewIdentityReconciliation(
  db: Db,
  input: IdentityReconciliationInput,
): Promise<IdentityReconciliationReport> {
  assertSupportedSource(input.fromUserId);
  await assertTargetEligible(db, input.fromUserId, input.toUser);
  const report = await runReconciliation(db, input, true);
  return { mode: "preview", activityLogRowsWritten: 0, ...report };
}

/**
 * Apply in one transaction. Locks `instance_user_roles` first (as
 * `first-admin-claim.ts` does) so a concurrent claim cannot interleave, then
 * re-verifies the target before writing. Idempotent: a second apply changes
 * zero rows.
 */
export async function applyIdentityReconciliation(
  db: Db,
  input: IdentityReconciliationInput,
): Promise<IdentityReconciliationReport> {
  assertSupportedSource(input.fromUserId);
  await assertTargetEligible(db, input.fromUserId, input.toUser);

  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
    await assertTargetEligible(tx, input.fromUserId, input.toUser);

    const report = await runReconciliation(tx, input, false);

    let activityLogRowsWritten = 0;
    const classAEntries = report.entries.filter((entry) => entry.class === "A");
    for (const company of report.companies) {
      const counts: Record<string, { matched: number; changed: number }> = {};
      let changedInCompany = 0;
      for (const entry of classAEntries) {
        const matched = entry.byCompany[company.id] ?? 0;
        const changed = entry.changedByCompany[company.id] ?? 0;
        if (matched === 0 && changed === 0) continue;
        counts[`${entry.table}.${entry.column}`] = { matched, changed };
        changedInCompany += changed;
      }
      // A company with nothing changed gets no row, so a repeated (no-op) apply does not spam the activity log.
      if (changedInCompany === 0) continue;
      await tx.insert(activityLog).values({
        companyId: company.id,
        actorType: "user",
        actorId: input.toUser.id,
        action: IDENTITY_RECONCILED_ACTIVITY_ACTION,
        entityType: "company",
        entityId: company.id,
        responsibleUserId: input.toUser.id,
        details: {
          fromUserId: input.fromUserId,
          toUserId: input.toUser.id,
          includeBoardKeys: report.includeBoardKeys,
          counts,
          reauthorize: report.reauthorize
            .filter((item) => item.companyId === company.id)
            .map((item) => ({ kind: item.kind, id: item.id, name: item.name })),
          instance: {
            boardApiKeysMoved: classAEntries.find((entry) => entry.table === "board_api_keys")?.changed ?? 0,
            sourceHoldsInstanceAdmin: report.sourceHoldsInstanceAdmin,
          },
        },
      });
      activityLogRowsWritten += 1;
    }

    return { mode: "apply", activityLogRowsWritten, ...report };
  });
}

/** Human-readable rendering shared by the CLI and tests. */
export function formatIdentityReconciliationReport(report: IdentityReconciliationReport): string {
  const lines: string[] = [];
  const title = report.mode === "preview" ? "Identity reconciliation preview (nothing written)" : "Identity reconciliation applied";
  lines.push(title);
  lines.push(`  from: ${report.fromUserId}`);
  lines.push(`  to:   ${report.toUser.id}${report.toUser.email ? ` <${report.toUser.email}>` : ""}`);
  lines.push(`  companies: ${report.companies.length}`);
  const companyName = new Map(report.companies.map((company) => [company.id, company.name]));
  const describe = (entry: IdentityReconciliationEntry) => {
    const perCompany = Object.entries(entry.byCompany)
      .map(([companyId, count]) => `${companyId === "instance" ? "instance" : companyName.get(companyId) ?? companyId}=${count}`)
      .join(", ");
    const verb = report.mode === "preview" ? "would change" : "changed";
    const skipped = entry.skipped ? `, skipped ${entry.skipped}` : "";
    return `  ${entry.table}.${entry.column} [${entry.action}] matched ${entry.matched}, ${verb} ${entry.changed}${skipped}${perCompany ? ` (${perCompany})` : ""}`;
  };
  const sections: Array<[IdentityReconciliationClass, string]> = [
    ["A", "Class A: operational references (moved)"],
    ["B", "Class B: historical attribution (never moved)"],
    ["C", "Class C: agent sentinel authorship (never moved)"],
    ["D", "Class D: personal credentials (re-authorize as the target)"],
  ];
  for (const [klass, heading] of sections) {
    const entries = report.entries.filter((entry) => entry.class === klass);
    lines.push("");
    lines.push(heading);
    if (entries.length === 0) lines.push("  (none)");
    for (const entry of entries) lines.push(describe(entry));
  }
  if (report.reauthorize.length > 0) {
    lines.push("");
    lines.push("Re-authorize as the new account:");
    for (const item of report.reauthorize) {
      lines.push(`  [${item.kind}] ${item.name} — ${item.detail} — company ${companyName.get(item.companyId) ?? item.companyId} — ${item.status}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  lines.push(
    `Totals: matched ${report.totals.matched}, ${report.mode === "preview" ? "would change" : "changed"} ${report.totals.changed}, skipped ${report.totals.skipped}` +
      (report.mode === "apply" ? `, activity log rows ${report.activityLogRowsWritten}` : ""),
  );
  return lines.join("\n");
}
