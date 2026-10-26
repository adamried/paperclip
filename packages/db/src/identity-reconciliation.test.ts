import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  applyIdentityReconciliation,
  IDENTITY_RECONCILED_ACTIVITY_ACTION,
  IdentityReconciliationError,
  LOCAL_BOARD_USER_ID,
  previewIdentityReconciliation,
  resolveIdentityReconciliationTarget,
  type IdentityReconciliationReport,
} from "./identity-reconciliation.js";
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
  heartbeatRuns,
  instanceUserRoles,
  issueComments,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routines,
  runIdentityContexts,
  toolApplications,
  toolConnections,
  userApprovalDecisionPolicies,
  userSecretDefinitions,
} from "./schema/index.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const TARGET_USER_ID = "target-admin";
const TARGET_EMAIL = "operator@example.test";

type Fixture = {
  companyA: string;
  companyB: string;
  agentA: string;
  openIssue: string;
  doneIssue: string;
  responsibleIssue: string;
  conversationIssue: string;
  pendingApproval: string;
  approvedApproval: string;
  pendingInteraction: string;
  answeredInteraction: string;
  runningRun: string;
  finishedRun: string;
  runningContext: string;
  finishedContext: string;
  orgGrant: string;
  personalGrant: string;
  boardKey: string;
  personalSecret: string;
};

const SNAPSHOT_TABLES = {
  issues,
  approvals,
  issueThreadInteractions,
  agents,
  companies,
  routines,
  agentApiKeys,
  heartbeatRuns,
  runIdentityContexts,
  toolApplications,
  connectionGrants,
  connectionGrantMembers,
  aiConnectionDefaults,
  aiProviderDefaults,
  userApprovalDecisionPolicies,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  agentMemberships,
  boardApiKeys,
  issueComments,
  approvalComments,
  companySecrets,
  activityLog,
  authUsers,
} as const;

async function snapshot(db: Db): Promise<string> {
  const parts: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(SNAPSHOT_TABLES)) {
    const idColumn = (table as unknown as { id: AnyPgColumn }).id;
    parts[name] = await db.select().from(table as AnyPgTable).orderBy(asc(idColumn));
  }
  return JSON.stringify(parts);
}

async function resetDatabase(db: Db): Promise<void> {
  await db.delete(activityLog);
  await db.delete(aiConnectionDefaults);
  await db.delete(aiProviderDefaults);
  await db.delete(connectionGrantMembers);
  await db.delete(connectionGrants);
  await db.delete(toolConnections);
  await db.delete(toolApplications);
  await db.delete(companySecrets);
  await db.delete(userSecretDefinitions);
  await db.delete(boardApiKeys);
  await db.delete(agentApiKeys);
  await db.delete(runIdentityContexts);
  await db.delete(heartbeatRuns);
  await db.delete(approvalComments);
  await db.delete(approvals);
  await db.delete(issueThreadInteractions);
  await db.delete(issueComments);
  await db.delete(issues);
  await db.delete(routines);
  await db.delete(agentMemberships);
  await db.delete(agents);
  await db.delete(userApprovalDecisionPolicies);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
  await db.delete(instanceUserRoles);
  await db.delete(authUsers);
}

async function seedUsers(db: Db, opts: { targetIsAdmin?: boolean; localBoardIsAdmin?: boolean } = {}): Promise<void> {
  const now = new Date();
  await db.insert(authUsers).values([
    { id: LOCAL_BOARD_USER_ID, name: "Board", email: "local@paperclip.local", emailVerified: true, createdAt: now, updatedAt: now },
    { id: TARGET_USER_ID, name: "Operator", email: TARGET_EMAIL, emailVerified: true, createdAt: now, updatedAt: now },
  ]);
  if (opts.targetIsAdmin !== false) {
    await db.insert(instanceUserRoles).values({ userId: TARGET_USER_ID, role: "instance_admin" });
  }
  if (opts.localBoardIsAdmin !== false) {
    await db.insert(instanceUserRoles).values({ userId: LOCAL_BOARD_USER_ID, role: "instance_admin" });
  }
}

async function seedFixture(db: Db): Promise<Fixture> {
  const [companyA, companyB] = await db
    .insert(companies)
    .values([
      { name: "Alpha Co", issuePrefix: `A${randomUUID().slice(0, 5).toUpperCase()}`, defaultResponsibleUserId: LOCAL_BOARD_USER_ID },
      { name: "Beta Co", issuePrefix: `B${randomUUID().slice(0, 5).toUpperCase()}` },
    ])
    .returning({ id: companies.id })
    .then((rows) => rows.map((row) => row.id));

  const agentA = await db
    .insert(agents)
    .values({ companyId: companyA, name: "Agent A", role: "engineer", adapterType: "codex_local", reportsToUserId: LOCAL_BOARD_USER_ID })
    .returning({ id: agents.id })
    .then((rows) => rows[0]!.id);

  const [openIssue, doneIssue, responsibleIssue, conversationIssue, targetConversationIssue] = await db
    .insert(issues)
    .values([
      { companyId: companyA, title: "Open task", status: "todo", assigneeUserId: LOCAL_BOARD_USER_ID, createdByUserId: LOCAL_BOARD_USER_ID },
      { companyId: companyA, title: "Done task", status: "done", assigneeUserId: LOCAL_BOARD_USER_ID, createdByUserId: LOCAL_BOARD_USER_ID },
      { companyId: companyB, title: "Responsible task", status: "in_progress", assigneeAgentId: null, responsibleUserId: LOCAL_BOARD_USER_ID },
      {
        companyId: companyA, title: "Conversation", status: "in_progress", assigneeAgentId: agentA,
        conversationAgentId: agentA, conversationUserId: LOCAL_BOARD_USER_ID, conversationState: "active",
      },
      {
        companyId: companyA, title: "Target conversation", status: "in_progress", assigneeAgentId: agentA,
        conversationAgentId: agentA, conversationUserId: TARGET_USER_ID, conversationState: "active",
      },
    ])
    .returning({ id: issues.id })
    .then((rows) => rows.map((row) => row.id));
  void targetConversationIssue;

  await db.insert(issueComments).values([
    { companyId: companyA, issueId: openIssue, body: "agent said hi", authorUserId: LOCAL_BOARD_USER_ID },
    { companyId: companyA, issueId: doneIssue, body: "agent said bye", authorUserId: LOCAL_BOARD_USER_ID },
    { companyId: companyB, issueId: responsibleIssue, body: "human comment", authorUserId: TARGET_USER_ID },
  ]);

  const [pendingApproval, approvedApproval] = await db
    .insert(approvals)
    .values([
      { companyId: companyA, type: "generic", payload: {}, status: "pending", addresseeUserId: LOCAL_BOARD_USER_ID },
      {
        companyId: companyA, type: "generic", payload: {}, status: "approved",
        addresseeUserId: LOCAL_BOARD_USER_ID, decidedByUserId: LOCAL_BOARD_USER_ID,
      },
    ])
    .returning({ id: approvals.id })
    .then((rows) => rows.map((row) => row.id));
  await db.insert(approvalComments).values({ companyId: companyA, approvalId: pendingApproval, body: "note", authorUserId: LOCAL_BOARD_USER_ID });

  const [pendingInteraction, answeredInteraction] = await db
    .insert(issueThreadInteractions)
    .values([
      { companyId: companyA, issueId: openIssue, kind: "question", status: "pending", payload: {} as never, addresseeUserId: LOCAL_BOARD_USER_ID },
      {
        companyId: companyA, issueId: openIssue, kind: "question", status: "answered", payload: {} as never,
        addresseeUserId: LOCAL_BOARD_USER_ID, resolvedByUserId: LOCAL_BOARD_USER_ID,
      },
    ])
    .returning({ id: issueThreadInteractions.id })
    .then((rows) => rows.map((row) => row.id));

  await db.insert(routines).values({ companyId: companyA, title: "Daily", responsibleUserId: LOCAL_BOARD_USER_ID, createdByUserId: LOCAL_BOARD_USER_ID });

  await db.insert(agentApiKeys).values([
    { agentId: agentA, companyId: companyA, name: "active key", keyHash: `h-${randomUUID()}`, responsibleUserId: LOCAL_BOARD_USER_ID },
    { agentId: agentA, companyId: companyA, name: "revoked key", keyHash: `h-${randomUUID()}`, responsibleUserId: LOCAL_BOARD_USER_ID, revokedAt: new Date() },
  ]);

  const [runningRun, finishedRun] = await db
    .insert(heartbeatRuns)
    .values([
      { companyId: companyA, agentId: agentA, status: "running", responsibleUserId: LOCAL_BOARD_USER_ID },
      { companyId: companyA, agentId: agentA, status: "succeeded", responsibleUserId: LOCAL_BOARD_USER_ID },
    ])
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows.map((row) => row.id));
  const [runningContext, finishedContext] = await db
    .insert(runIdentityContexts)
    .values([
      { companyId: companyA, runId: runningRun, revision: 1, responsibleUserId: LOCAL_BOARD_USER_ID, cause: "instruction", correlationId: "c1", status: "accepted" },
      { companyId: companyA, runId: finishedRun, revision: 1, responsibleUserId: LOCAL_BOARD_USER_ID, cause: "instruction", correlationId: "c2", status: "accepted" },
    ])
    .returning({ id: runIdentityContexts.id })
    .then((rows) => rows.map((row) => row.id));

  const application = await db
    .insert(toolApplications)
    .values({ companyId: companyA, name: "Anthropic", type: "mcp_http", ownerUserId: LOCAL_BOARD_USER_ID })
    .returning({ id: toolApplications.id })
    .then((rows) => rows[0]!.id);
  const [sharedConnection, personalConnection] = await db
    .insert(toolConnections)
    .values([
      { companyId: companyA, applicationId: application, name: "Shared Anthropic", uid: `shared-${randomUUID()}`, transport: "runtime_auth", authKind: "api_key", connectionPurpose: "ai", status: "active", enabled: true },
      { companyId: companyA, applicationId: application, name: "Personal Anthropic", uid: `personal-${randomUUID()}`, transport: "runtime_auth", authKind: "api_key", connectionPurpose: "ai", status: "active", enabled: true },
    ])
    .returning({ id: toolConnections.id })
    .then((rows) => rows.map((row) => row.id));
  const [orgGrant, personalGrant] = await db
    .insert(connectionGrants)
    .values([
      { companyId: companyA, connectionId: sharedConnection, kind: "organization", isDefault: true, credentialSecretRefs: [], createdByUserId: LOCAL_BOARD_USER_ID },
      {
        companyId: companyA, connectionId: personalConnection, kind: "user", subjectUserId: LOCAL_BOARD_USER_ID,
        credentialSecretRefs: [{ name: "ANTHROPIC_API_KEY", secretId: randomUUID(), placement: "header" } as never],
        createdByUserId: LOCAL_BOARD_USER_ID,
      },
    ])
    .returning({ id: connectionGrants.id })
    .then((rows) => rows.map((row) => row.id));
  await db.insert(connectionGrantMembers).values({ companyId: companyA, grantId: orgGrant, subjectType: "user", subjectId: LOCAL_BOARD_USER_ID });

  await db.insert(aiConnectionDefaults).values([
    { companyId: companyA, userId: LOCAL_BOARD_USER_ID, provider: "anthropic", method: "api_key", grantId: personalGrant },
    { companyId: companyA, userId: LOCAL_BOARD_USER_ID, provider: "openai", method: "api_key", grantId: orgGrant },
  ]);
  // The ai_connection_defaults sync trigger (migration 0277) already seeded the
  // source's provider defaults (anthropic -> personal grant, openai -> org grant).
  // The target already chose an openai default: the source copy must not override it.
  await db.insert(aiProviderDefaults).values({ companyId: companyA, userId: TARGET_USER_ID, provider: "openai", grantId: null });

  await db.insert(userApprovalDecisionPolicies).values([
    { companyId: companyA, userId: LOCAL_BOARD_USER_ID, policy: "addressee_only" },
    { companyId: companyB, userId: LOCAL_BOARD_USER_ID, policy: "addressee_only" },
    { companyId: companyB, userId: TARGET_USER_ID, policy: "any_board" },
  ]);

  await db.insert(companyMemberships).values([
    { companyId: companyA, principalType: "user", principalId: LOCAL_BOARD_USER_ID, status: "active", membershipRole: "owner" },
    { companyId: companyB, principalType: "user", principalId: LOCAL_BOARD_USER_ID, status: "active", membershipRole: "owner" },
    { companyId: companyB, principalType: "user", principalId: TARGET_USER_ID, status: "archived", membershipRole: "member" },
  ]);

  await db.insert(principalPermissionGrants).values([
    { companyId: companyA, principalType: "user", principalId: LOCAL_BOARD_USER_ID, permissionKey: "issues.manage" },
    { companyId: companyA, principalType: "user", principalId: LOCAL_BOARD_USER_ID, permissionKey: "agents.manage" },
    { companyId: companyA, principalType: "user", principalId: TARGET_USER_ID, permissionKey: "agents.manage" },
  ]);

  await db.insert(agentMemberships).values({ companyId: companyA, agentId: agentA, userId: LOCAL_BOARD_USER_ID, state: "joined" });

  const boardKey = await db
    .insert(boardApiKeys)
    .values({ userId: LOCAL_BOARD_USER_ID, name: "cli", keyHash: `bk-${randomUUID()}` })
    .returning({ id: boardApiKeys.id })
    .then((rows) => rows[0]!.id);

  const secretDefinition = await db
    .insert(userSecretDefinitions)
    .values({ companyId: companyA, key: "MY_TOKEN", name: "My token" })
    .returning({ id: userSecretDefinitions.id })
    .then((rows) => rows[0]!.id);
  const personalSecret = await db
    .insert(companySecrets)
    .values({
      companyId: companyA, scope: "user", ownerUserId: LOCAL_BOARD_USER_ID, userSecretDefinitionId: secretDefinition,
      key: `MY_TOKEN__${LOCAL_BOARD_USER_ID}`, name: "My token",
    })
    .returning({ id: companySecrets.id })
    .then((rows) => rows[0]!.id);

  return {
    companyA, companyB, agentA, openIssue, doneIssue, responsibleIssue, conversationIssue,
    pendingApproval, approvedApproval, pendingInteraction, answeredInteraction,
    runningRun, finishedRun, runningContext, finishedContext, orgGrant, personalGrant, boardKey, personalSecret,
  };
}

function entry(report: IdentityReconciliationReport, table: string, column: string, klass?: string) {
  const found = report.entries.find(
    (candidate) => candidate.table === table && candidate.column === column && (klass ? candidate.class === klass : true),
  );
  if (!found) throw new Error(`missing report entry ${table}.${column}`);
  return found;
}

describeEmbeddedPostgres("identity reconciliation", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-identity-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves the target by id or by case-insensitive email and rejects ambiguity", async () => {
    await seedUsers(db);
    expect((await resolveIdentityReconciliationTarget(db, TARGET_USER_ID)).id).toBe(TARGET_USER_ID);
    expect((await resolveIdentityReconciliationTarget(db, TARGET_EMAIL.toUpperCase())).id).toBe(TARGET_USER_ID);

    const now = new Date();
    await db.insert(authUsers).values({ id: "dup-user", name: "Dup", email: TARGET_EMAIL, emailVerified: true, createdAt: now, updatedAt: now });
    await expect(resolveIdentityReconciliationTarget(db, TARGET_EMAIL)).rejects.toMatchObject({
      name: "IdentityReconciliationError",
      code: "target_ambiguous",
    });
    await expect(resolveIdentityReconciliationTarget(db, "nobody@example.test")).rejects.toMatchObject({ code: "target_not_found" });
  });

  it("rejects a target without instance_admin and names the remedy", async () => {
    await seedUsers(db, { targetIsAdmin: false });
    await seedFixture(db);
    const toUser = await resolveIdentityReconciliationTarget(db, TARGET_USER_ID);
    const before = await snapshot(db);
    let caught: unknown = null;
    try {
      await applyIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IdentityReconciliationError);
    expect((caught as IdentityReconciliationError).code).toBe("target_not_instance_admin");
    expect((caught as IdentityReconciliationError).remedy).toBe(`paperclipai admin user promote ${TARGET_USER_ID}`);
    await expect(previewIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser })).rejects.toMatchObject({
      code: "target_not_instance_admin",
    });
    expect(await snapshot(db)).toBe(before);
  });

  it("rejects an unsupported source and a target equal to the source", async () => {
    await seedUsers(db);
    const toUser = await resolveIdentityReconciliationTarget(db, TARGET_USER_ID);
    await expect(previewIdentityReconciliation(db, { fromUserId: "someone-else", toUser })).rejects.toMatchObject({
      code: "source_not_supported",
    });
    await db.insert(instanceUserRoles).values({ userId: "x", role: "instance_admin" }).onConflictDoNothing();
    await expect(
      previewIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser: { id: LOCAL_BOARD_USER_ID, email: null, name: null } }),
    ).rejects.toMatchObject({ code: "source_equals_target" });
  });

  it("dry run writes nothing and reports what would move", async () => {
    await seedUsers(db);
    const fixture = await seedFixture(db);
    const toUser = await resolveIdentityReconciliationTarget(db, TARGET_USER_ID);
    const before = await snapshot(db);

    const report = await previewIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });

    expect(await snapshot(db)).toBe(before);
    expect(report.mode).toBe("preview");
    expect(report.activityLogRowsWritten).toBe(0);
    expect(report.totals.changed).toBeGreaterThan(0);

    expect(entry(report, "issues", "assignee_user_id")).toMatchObject({ matched: 2, changed: 2, byCompany: { [fixture.companyA]: 2 } });
    expect(entry(report, "issues", "responsible_user_id")).toMatchObject({ matched: 1, changed: 1, byCompany: { [fixture.companyB]: 1 } });
    expect(entry(report, "issues", "conversation_user_id")).toMatchObject({ matched: 1, changed: 0, skipped: 1 });
    expect(entry(report, "approvals", "addressee_user_id", "A")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "approvals", "addressee_user_id", "B")).toMatchObject({ matched: 1, changed: 0 });
    expect(entry(report, "issue_thread_interactions", "addressee_user_id", "A")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "heartbeat_runs", "responsible_user_id", "A")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "heartbeat_runs", "responsible_user_id", "B")).toMatchObject({ matched: 1 });
    expect(entry(report, "run_identity_contexts", "responsible_user_id", "A")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "agent_api_keys", "responsible_user_id", "A")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "agent_api_keys", "responsible_user_id", "B")).toMatchObject({ matched: 1 });
    expect(entry(report, "ai_connection_defaults", "user_id")).toMatchObject({ matched: 2, changed: 2, skipped: 0 });
    expect(entry(report, "ai_provider_defaults", "user_id")).toMatchObject({ matched: 2, changed: 1, skipped: 1 });
    expect(entry(report, "user_approval_decision_policies", "user_id")).toMatchObject({ matched: 2, changed: 1, skipped: 1 });
    expect(entry(report, "company_memberships", "principal_id")).toMatchObject({ matched: 2, changed: 2 });
    expect(entry(report, "principal_permission_grants", "principal_id")).toMatchObject({ matched: 2, changed: 1, skipped: 1 });
    expect(entry(report, "agent_memberships", "user_id")).toMatchObject({ matched: 1, changed: 1 });
    expect(entry(report, "board_api_keys", "user_id", "A")).toMatchObject({ matched: 1, changed: 0, action: "report" });
    expect(entry(report, "issue_comments", "author_user_id")).toMatchObject({ class: "C", matched: 2, changed: 0 });
    expect(entry(report, "connection_grants", "subject_user_id")).toMatchObject({ class: "D", matched: 1, changed: 0 });
    expect(entry(report, "company_secrets", "owner_user_id")).toMatchObject({ class: "D", matched: 1, changed: 0 });
    expect(report.reauthorize.map((item) => item.id).sort()).toEqual([fixture.personalGrant, fixture.personalSecret].sort());
    expect(report.defaultsPointingAtPersonalGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "ai_connection_defaults", grantId: fixture.personalGrant }),
        expect.objectContaining({ table: "ai_provider_defaults", grantId: fixture.personalGrant }),
      ]),
    );
    expect(report.sourceHoldsInstanceAdmin).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("still holds instance_admin"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("--include-board-keys"))).toBe(true);
  });

  it("apply moves class A, leaves class B/C/D alone, and is idempotent", async () => {
    await seedUsers(db);
    const fixture = await seedFixture(db);
    const toUser = await resolveIdentityReconciliationTarget(db, TARGET_USER_ID);
    const preview = await previewIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });

    const commentAuthorsBefore = await db
      .select({ authorUserId: issueComments.authorUserId })
      .from(issueComments)
      .where(eq(issueComments.authorUserId, LOCAL_BOARD_USER_ID));

    const applied = await applyIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });

    expect(applied.mode).toBe("apply");
    // Apply changes exactly what the preview said it would.
    expect(applied.totals).toEqual(preview.totals);
    expect(applied.entries.map((e) => [e.table, e.column, e.class, e.matched, e.changed, e.skipped])).toEqual(
      preview.entries.map((e) => [e.table, e.column, e.class, e.matched, e.changed, e.skipped]),
    );

    // Class A moved.
    const issueRows = await db.select().from(issues).orderBy(asc(issues.createdAt));
    const byId = new Map(issueRows.map((row) => [row.id, row]));
    expect(byId.get(fixture.openIssue)?.assigneeUserId).toBe(TARGET_USER_ID);
    expect(byId.get(fixture.doneIssue)?.assigneeUserId).toBe(TARGET_USER_ID);
    expect(byId.get(fixture.responsibleIssue)?.responsibleUserId).toBe(TARGET_USER_ID);
    // Conversation collides with the target's existing conversation: skipped.
    expect(byId.get(fixture.conversationIssue)?.conversationUserId).toBe(LOCAL_BOARD_USER_ID);
    // Class B untouched.
    expect(byId.get(fixture.openIssue)?.createdByUserId).toBe(LOCAL_BOARD_USER_ID);

    const approvalRows = await db.select().from(approvals);
    const pending = approvalRows.find((row) => row.id === fixture.pendingApproval)!;
    const approved = approvalRows.find((row) => row.id === fixture.approvedApproval)!;
    expect(pending.addresseeUserId).toBe(TARGET_USER_ID);
    expect(pending.status).toBe("pending");
    expect(pending.decidedByUserId).toBeNull();
    expect(approved.addresseeUserId).toBe(LOCAL_BOARD_USER_ID);
    expect(approved.decidedByUserId).toBe(LOCAL_BOARD_USER_ID);

    const interactionRows = await db.select().from(issueThreadInteractions);
    expect(interactionRows.find((row) => row.id === fixture.pendingInteraction)).toMatchObject({ addresseeUserId: TARGET_USER_ID, status: "pending" });
    expect(interactionRows.find((row) => row.id === fixture.answeredInteraction)).toMatchObject({
      addresseeUserId: LOCAL_BOARD_USER_ID,
      resolvedByUserId: LOCAL_BOARD_USER_ID,
    });

    const runRows = await db.select().from(heartbeatRuns);
    expect(runRows.find((row) => row.id === fixture.runningRun)?.responsibleUserId).toBe(TARGET_USER_ID);
    expect(runRows.find((row) => row.id === fixture.finishedRun)?.responsibleUserId).toBe(LOCAL_BOARD_USER_ID);
    const contextRows = await db.select().from(runIdentityContexts);
    expect(contextRows.find((row) => row.id === fixture.runningContext)?.responsibleUserId).toBe(TARGET_USER_ID);
    expect(contextRows.find((row) => row.id === fixture.finishedContext)?.responsibleUserId).toBe(LOCAL_BOARD_USER_ID);

    expect((await db.select().from(agents))[0]?.reportsToUserId).toBe(TARGET_USER_ID);
    expect((await db.select().from(companies).where(eq(companies.id, fixture.companyA)))[0]?.defaultResponsibleUserId).toBe(TARGET_USER_ID);
    expect((await db.select().from(routines))[0]?.responsibleUserId).toBe(TARGET_USER_ID);
    const keyRows = await db.select().from(agentApiKeys);
    expect(keyRows.find((row) => row.name === "active key")?.responsibleUserId).toBe(TARGET_USER_ID);
    expect(keyRows.find((row) => row.name === "revoked key")?.responsibleUserId).toBe(LOCAL_BOARD_USER_ID);
    expect((await db.select().from(toolApplications))[0]?.ownerUserId).toBe(TARGET_USER_ID);
    expect((await db.select().from(connectionGrantMembers)).map((row) => row.subjectId)).toEqual([TARGET_USER_ID]);

    // Provider defaults resolve for the target; source rows remain.
    const connDefaults = await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.companyId, fixture.companyA));
    const targetConnDefaults = connDefaults.filter((row) => row.userId === TARGET_USER_ID);
    expect(targetConnDefaults).toHaveLength(2);
    expect(targetConnDefaults.find((row) => row.provider === "anthropic")?.grantId).toBe(fixture.personalGrant);
    expect(targetConnDefaults.find((row) => row.provider === "openai")?.grantId).toBe(fixture.orgGrant);
    expect(connDefaults.filter((row) => row.userId === LOCAL_BOARD_USER_ID)).toHaveLength(2);
    const providerDefaults = await db.select().from(aiProviderDefaults).where(eq(aiProviderDefaults.userId, TARGET_USER_ID));
    expect(providerDefaults).toHaveLength(2);
    expect(providerDefaults.find((row) => row.provider === "anthropic")?.grantId).toBe(fixture.personalGrant);
    // The target's pre-existing openai choice was not overridden.
    expect(providerDefaults.find((row) => row.provider === "openai")?.grantId).toBeNull();

    // Policies merged; the conflicting one stays on the source.
    const policies = await db.select().from(userApprovalDecisionPolicies);
    expect(policies.find((row) => row.companyId === fixture.companyA)?.userId).toBe(TARGET_USER_ID);
    expect(policies.filter((row) => row.companyId === fixture.companyB).map((row) => row.userId).sort()).toEqual(
      [LOCAL_BOARD_USER_ID, TARGET_USER_ID].sort(),
    );

    // Memberships ensured; the source keeps its own.
    const memberships = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, TARGET_USER_ID));
    expect(memberships.map((row) => [row.companyId, row.status, row.membershipRole]).sort()).toEqual(
      [[fixture.companyA, "active", "owner"], [fixture.companyB, "active", "owner"]].sort(),
    );
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID))).toHaveLength(2);

    const grants = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, fixture.companyA));
    expect(grants.filter((row) => row.principalId === TARGET_USER_ID).map((row) => row.permissionKey).sort()).toEqual(["agents.manage", "issues.manage"]);
    expect(grants.filter((row) => row.principalId === LOCAL_BOARD_USER_ID).map((row) => row.permissionKey)).toEqual(["agents.manage"]);
    expect((await db.select().from(agentMemberships))[0]?.userId).toBe(TARGET_USER_ID);

    // Board keys stay without --include-board-keys.
    expect((await db.select().from(boardApiKeys))[0]?.userId).toBe(LOCAL_BOARD_USER_ID);

    // Class C: sentinel authorship untouched.
    const commentAuthorsAfter = await db
      .select({ authorUserId: issueComments.authorUserId })
      .from(issueComments)
      .where(eq(issueComments.authorUserId, LOCAL_BOARD_USER_ID));
    expect(commentAuthorsAfter).toHaveLength(commentAuthorsBefore.length);
    expect(commentAuthorsAfter).toHaveLength(2);
    expect((await db.select().from(approvalComments))[0]?.authorUserId).toBe(LOCAL_BOARD_USER_ID);

    // Class D: personal grant and personal secret reported, not moved.
    const personalGrant = (await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.personalGrant)))[0]!;
    expect(personalGrant.subjectUserId).toBe(LOCAL_BOARD_USER_ID);
    expect(personalGrant.status).toBe("active");
    expect(applied.reauthorize.find((item) => item.id === fixture.personalGrant)).toMatchObject({
      kind: "connection_grant",
      companyId: fixture.companyA,
      name: "Personal Anthropic",
    });
    expect((await db.select().from(companySecrets))[0]?.ownerUserId).toBe(LOCAL_BOARD_USER_ID);

    // Source user and its admin role are untouched; authAccounts never touched (none exist).
    expect(await db.select().from(authUsers).where(eq(authUsers.id, LOCAL_BOARD_USER_ID))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin"))),
    ).toHaveLength(1);

    // Activity log: one row per company that changed, actor is the target.
    const activity = await db.select().from(activityLog).where(eq(activityLog.action, IDENTITY_RECONCILED_ACTIVITY_ACTION));
    expect(applied.activityLogRowsWritten).toBe(2);
    expect(activity.map((row) => row.companyId).sort()).toEqual([fixture.companyA, fixture.companyB].sort());
    for (const row of activity) {
      expect(row.actorType).toBe("user");
      expect(row.actorId).toBe(TARGET_USER_ID);
      expect(row.entityType).toBe("company");
      expect(row.entityId).toBe(row.companyId);
      expect(row.details).toMatchObject({ fromUserId: LOCAL_BOARD_USER_ID, toUserId: TARGET_USER_ID });
    }
    const companyADetails = activity.find((row) => row.companyId === fixture.companyA)!.details as { counts: Record<string, { changed: number }> };
    expect(companyADetails.counts["issues.assignee_user_id"]).toEqual({ matched: 2, changed: 2 });

    // Second apply is a no-op.
    const before = await snapshot(db);
    const second = await applyIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });
    expect(second.totals.changed).toBe(0);
    expect(second.activityLogRowsWritten).toBe(0);
    expect(second.entries.every((e) => e.changed === 0)).toBe(true);
    expect(await snapshot(db)).toBe(before);
  });

  it("moves active board API keys only with includeBoardKeys", async () => {
    await seedUsers(db);
    const fixture = await seedFixture(db);
    const toUser = await resolveIdentityReconciliationTarget(db, TARGET_USER_ID);

    const withoutFlag = await applyIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser });
    expect(entry(withoutFlag, "board_api_keys", "user_id", "A")).toMatchObject({ action: "report", matched: 1, changed: 0 });
    expect((await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, fixture.boardKey)))[0]?.userId).toBe(LOCAL_BOARD_USER_ID);

    const withFlag = await applyIdentityReconciliation(db, { fromUserId: LOCAL_BOARD_USER_ID, toUser, includeBoardKeys: true });
    expect(entry(withFlag, "board_api_keys", "user_id", "A")).toMatchObject({ action: "move", matched: 1, changed: 1 });
    expect((await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, fixture.boardKey)))[0]?.userId).toBe(TARGET_USER_ID);
    // Only the key moved on the second run, so only an instance-level change happened: no company activity row.
    expect(withFlag.activityLogRowsWritten).toBe(0);
    expect(withFlag.totals.changed).toBe(1);
  });
});
