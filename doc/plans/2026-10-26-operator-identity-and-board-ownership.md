# Operator Identity, Ownership Transfer, and Board Visibility

Status: proposed spec set, ordered by priority
Date: 2026-10-26
Verified against: `e4a4acb` (Merge PR #1)

## 0. Why this exists

An operator ran Paperclip in `local_trusted` mode, created companies, issues,
approvals, and per-user model-provider defaults. Later they needed a remote
agent (Hermes, on a VPS, reachable over Tailscale) to join a company. That
required `authenticated` mode and a real login. The operator created an
email/password account and claimed board ownership. Afterwards:

- Model-provider connections appeared broken for the new account.
- Issues assigned to the old local identity could not be acted on.
- Two humans appeared in the instance: `local-board` and the new account.
- There was no screen showing who "the Board" is or how to change it.

Root causes, confirmed in code at the revision above:

| Symptom | Cause | Where |
|---|---|---|
| Provider connections broken | `ai_connection_defaults` and `ai_provider_defaults` are keyed by `userId`. Rows exist for `local-board`, none for the new user. | `packages/db/src/schema/ai_connection_defaults.ts`, `ai_provider_defaults.ts` |
| Old tasks unusable | The mode-switch claim moves only `instance_user_roles` and `company_memberships`. Every other user reference stays on `local-board`. | `server/src/board-claim.ts` `claimBoardOwnership` |
| Two humans | `local-board` is a real `authUsers` row with email `local@paperclip.local`, created at startup in local mode. | `server/src/index.ts` `ensureLocalTrustedBoardPrincipal` |
| Board invisible | "Board" is three unrelated things: an actor type, the `instance_admin` role, and display strings. No screen lists it. | `server/src/middleware/auth.ts`, `server/src/services/org-chart-tree.ts`, `ui/src/pages/InstanceAccess.tsx` |

One more fact shapes the whole design: `local-board` is also the non-human
sentinel that agent subprocesses post comments under
(`NON_HUMAN_SENTINEL_AUTHOR_USER_IDS` in `server/src/services/issues.ts`).
It cannot simply become the operator's login account.

## 1. Principles

1. The operator is one user ID for the life of the instance. Enabling login
   attaches credentials to that ID. It never creates a second human.
2. `local-board` is an agent-posting sentinel, not a seat on the Board.
3. Authentication and network exposure are separate settings. No spec here
   opens a port.
4. History is preserved. Attribution of past actions is never rewritten to
   make lists look clean. Only operational references move.
5. Existing instances are never mutated by starting a new version. Every
   migration of live data is an explicit, previewable, host-authorized action.
6. Agent enrollment stays on its own invite, approval, and credential path.
   No human password or browser session is ever reused for an agent.

## 2. Build order

| # | Spec | Why this position |
|---|---|---|
| 1 | Identity reconciliation command | Repairs the reported instance. Everything else is prevention. |
| 2 | Operator identity model | Makes the split impossible for new local installs. |
| 3 | Upgrade-in-place to login | Enabling auth keeps the operator ID. Depends on 2. |
| 4 | Account profile and email management | Lets the operator change email later for hosted migration. |
| 5 | Harden and surface the legacy claim flow | Legacy instances still need it; it has a race and is console-only. |
| 6 | The Board: definition and management page | Would have shown the split. Cheap once 2 and 5 land. |
| 7 | Identity-first fresh onboarding | Nice for new installs. Irrelevant to the reported case. |

Specs 1 and 5 are independent of 2 through 4 and can ship first.

---

## Spec 1. Identity reconciliation for a populated instance

### Problem

`claimBoardOwnership` transfers roles and memberships only. Operational
references to the old identity remain and block the new account.

### Scope

A host-authorized CLI command that moves operational ownership from a
source user (initially always `local-board`) to a verified target user, with
a dry-run preview, a transactional apply, and a report of what moved and
what needs manual action.

Not a general account-merge tool. Source is restricted to `local-board`
(and, after Spec 2, a legacy operator ID). Target must already hold
`instance_admin`. Merging two named human accounts is out of scope.

### Reference inventory

Classify every user-referencing column in `packages/db/src/schema/`. The
reconciliation moves class A, leaves classes B and C, and reports class D.

**Class A: operational, move to target**

| Table | Columns |
|---|---|
| `issues` | `assigneeUserId`, `responsibleUserId`, `conversationUserId` |
| `issue_tree_hold_members` | `assigneeUserId` |
| `approvals` | `addresseeUserId` (only while status is pending) |
| `issue_thread_interactions` | `addresseeUserId` (only while unresolved) |
| `agents` | `reportsToUserId` |
| `companies` | `defaultResponsibleUserId` |
| `routines` | `responsibleUserId` |
| `decision_queues` | `responsibleUserId` |
| `agent_api_keys` | `responsibleUserId` |
| `heartbeat_runs` | `responsibleUserId` (active runs only) |
| `run_identity_contexts` | `responsibleUserId` (active only) |
| `tool_access` grants | `ownerUserId`, `subjectUserId`, `responsibleUserId` (active grants; see class D) |
| `ai_connection_defaults` | `userId` (upsert into target; unique on company, user, provider, method) |
| `ai_provider_defaults` | `userId` (upsert into target) |
| `user_approval_decision_policies` | `userId` |
| `user_inbox_agent_policies` | `userId` |
| `company_memberships` | `principalId` (already handled by claim; re-verify active owner membership) |
| `instance_user_roles` | `userId` (already handled by claim; re-verify) |
| `principal_permission_grants` | `principalId` (merge; skip rows target already has) |
| `project_memberships`, `document_memberships`, `agent_memberships` | `userId` (merge) |
| `board_api_keys` | `userId` (move only keys the operator confirms in preview) |

**Class B: historical attribution, never move**

`createdByUserId`, `updatedByUserId`, `decidedByUserId`, `resolvedByUserId`,
`approvedByUserId`, `rejectedByUserId`, `revokedByUserId`, `grantedByUserId`,
`archivedByUserId`, `releasedByUserId`, `lockedByUserId`, `invitedByUserId`,
`linkedByUserId`, `startedByUserId`, `addedByUserId`, `setByUserId`,
`decidedByUserId`, `activity_log.actorId`, `secret_access_events.*`,
`pipeline_case_events.actorUserId`, `issue_execution_decisions.actorUserId`,
`cases.actorUserId`, `completion_contracts.createdByActorId`,
`agent_wakeup_requests.requestedByActorId`, resolved approvals and
interactions, finished runs.

**Class C: agent sentinel, never move**

`issue_comments.authorUserId`, `approval_comments.authorUserId`,
`document_annotation_comments.authorUserId`, `feedback_*.authorUserId`
where the row was written through an agent run. These are what the
`NON_HUMAN_SENTINEL_AUTHOR_USER_IDS` logic depends on. A comment the human
typed in the browser while in local mode is indistinguishable from an agent
comment by `authorUserId` alone; use `onBehalfOfUserId` and run linkage where
present, otherwise leave as is and list the count in the report.

**Class D: needs fresh consent, report and do not copy**

A connection grant whose credential is bound to the user's own secret
(`user_secret_definitions`) or whose provider session was established by the
user's browser. Moving `ownerUserId` on such a grant would widen access
without consent. Report these as "reauthorize as the new account" with the
provider and company. `ai_connection_defaults.grantId` rows pointing at a
class D grant are copied to the target but left pointing at the same grant;
the UI already treats a revoked or missing grant as "unavailable default,
never permission to auto-select" (comment in the schema file).

Per-viewer preference tables (`issue_read_states`, `inbox_dismissals`,
`issue_inbox_archives`, `*_sidebar_preferences`, `announcement_dismissals`)
are not moved. They repopulate.

### Command

```sh
paperclipai auth reconcile-identity --from local-board --to <userId|email> [--apply] [--include-board-keys]
```

- Without `--apply`: print the preview grouped by class and table, with row
  counts per company, and exit 0. Never write.
- `--to` resolves email to exactly one `authUsers` row, else fails.
- Target must hold `instance_admin`. Otherwise fail with the exact
  `admin/users` action needed.
- Requires host authority: run on the host with access to the config and
  database, same trust as `auth bootstrap-ceo`. There is no HTTP endpoint
  for this in the first release.
- `--apply` runs one transaction. Lock `instance_user_roles` in share row
  exclusive mode first, as `first-admin-claim.ts` does, so a concurrent claim
  cannot interleave.
- Idempotent: a second `--apply` moves zero rows and reports zero.
- Write one `activity_log` row per company with action
  `identity.reconciled`, actor the target user, details holding the per-table
  counts. Also one instance-level row.
- Never decide, approve, resolve, or complete anything. Pending approvals
  get a new addressee and nothing else.
- Never delete the source user row. Never touch `authAccounts`.
- Print the report at the end and write it to
  `<data dir>/reconcile-identity-<timestamp>.json`.

### Acceptance

- On a fixture built from a local-trusted instance (companies, issues
  assigned to `local-board`, pending approvals, provider defaults, one
  user-bound grant), after `--apply` the target user sees and can act on
  every issue and approval, provider defaults resolve for the target in each
  company, the user-bound grant is listed under "reauthorize", and
  `issue_comments.authorUserId` counts are unchanged.
- Dry run writes nothing (assert row hashes before and after).
- Second apply is a no-op.
- Target without `instance_admin` is rejected.
- Email matching two users is rejected.
- Run against PGlite and Postgres.

### Open questions

- Whether `board_api_keys` should move by default. Default proposed: no,
  listed in preview, moved with `--include-board-keys`.
- Whether class C human-typed comments should get `onBehalfOfUserId` set to
  the target. Proposed: no in first release; count only.

---

## Spec 2. Operator identity model

### Problem

In `local_trusted` mode the implicit actor is `local-board`, which is also
the agent sentinel. The operator has no identity of their own to carry into
authenticated mode.

### Change

**Operator user.** On first start in `local_trusted` mode, when no operator
is recorded, create one `authUsers` row with a random ID, name "Operator",
email `operator@<instanceId>.paperclip.local` (unique, not routable),
`emailVerified: false`. Grant `instance_admin` and owner membership in every
company, exactly as `ensureLocalTrustedBoardPrincipal` does today for
`local-board`. Record the ID in `instance_settings.general.operatorUserId`.

**Sentinel stays.** Keep creating the `local-board` user row, but stop
granting it `instance_admin` and stop giving it company memberships on new
instances. It exists only so agent-authored rows have a valid foreign key
and so existing attribution logic keeps working.

**Actor middleware.** In `local_trusted` mode, `actorMiddleware` sets
`userId` to the operator ID from instance settings, `userName` to the
operator's name, `source: "local_implicit"`. Every `req.actor.userId ??
"local-board"` fallback in routes is reviewed:

- If the actor is a human (board type), the fallback is unreachable after
  this change and is removed.
- If the path is an agent writing a comment or similar, replace the fallback
  with an explicit `AGENT_SENTINEL_USER_ID` constant exported from
  `packages/shared`. Grep targets at this revision: `routes/companies.ts`
  lines 1206, 1266, 1441; `routes/issues.ts` 17056, 18265;
  `routes/activity.ts` 301; `routes/connection-intents.ts` 167;
  `routes/access.ts` 2187, 2831, 3168, 3680;
  `services/connection-intent-delivery.ts` 127.
- `project-tool-context.ts` `localTrusted: userId === "local-board"` must
  key on deployment mode or the operator ID, not the sentinel.

**Display.** Places that render `"Board"` for `local-board`
(`org-chart-tree.ts`, `tool-access.ts`, `tool-connection-activity.ts`,
`approval-decision-policy.ts`) render "Agent runtime" or similar for the
sentinel and the operator's real name for the operator.

**Legacy instances.** An existing `local_trusted` instance where
`local-board` holds `instance_admin` and no `operatorUserId` is recorded is
legacy. Do not migrate it at startup. Set `operatorUserId = "local-board"`
in memory only, log once that the instance uses the legacy operator
identity, and expose that in `/api/health` as `operatorIdentity: "legacy"`.
Spec 1 is the migration path, extended to accept `--from local-board --to
<new operator>` and to record the new `operatorUserId` on success.

### Acceptance

- Fresh local install: `/api/health` reports `operatorIdentity: "dedicated"`.
  Creating a company, assigning an issue to "me", and setting a provider
  default all reference the operator ID. Zero operational rows reference
  `local-board`.
- Agent run posts a comment: `authorUserId` is `local-board`, attribution
  derivation still identifies the agent.
- Legacy fixture starts unchanged: row counts identical before and after
  boot, health reports `legacy`.
- `pnpm test` attribution tests in `issues.ts` pass unchanged.

---

## Spec 3. Upgrade in place: enabling login keeps the operator

### Problem

Switching to `authenticated` today requires a new signup and a claim. Even
with Spec 1, that is a migration. The operator should instead gain a
password.

### Change

When `configure --section server` or `onboard` moves an instance from
`local_trusted` to `authenticated`, and `operatorIdentity` is `dedicated`:

1. Prompt for email and password (confirm password). Email must be unique
   among `authUsers`.
2. Update the operator's `authUsers` row: set `email`, `name` if blank, keep
   `emailVerified: false` unless the deployment has mail configured.
3. Insert one `authAccounts` row for the operator with Better Auth's
   credential provider (`providerId: "credential"`, `accountId` = user ID,
   `password` hashed with the same hasher Better Auth 1.7.2 uses on signup;
   call its exported hash helper rather than reimplementing). Verify the
   `issuer` convention documented in `packages/db/src/schema/auth.ts`.
4. Save config. On next start the operator already holds `instance_admin`,
   so `bootstrapStatus` is `ready` and no claim challenge is issued.
5. Print: "Login enabled. Sign in as `<email>`. Your existing companies,
   tasks, and provider connections stay with this account."

Headless alternative:

```sh
paperclipai auth set-operator-credentials --email <email>   # password prompted or via stdin
```

If `operatorIdentity` is `legacy`, the CLI explains that this instance
predates dedicated operator identities and offers two paths: create a new
account and run Spec 1 reconciliation into it, or continue with the browser
claim (Spec 5). It does not try to attach credentials to `local-board`.

Bind is untouched. If the operator wants Tailscale or LAN reachability, that
is the existing bind prompt and remains a separate question.

### Acceptance

- Fresh local install, create work, run upgrade, restart in
  `authenticated/private` with `bind=loopback`: sign-in with the chosen
  email succeeds, the session's `userId` equals the pre-upgrade operator ID,
  all issues and provider defaults are visible, `/api/health` shows `ready`,
  no claim URL is logged, listening address unchanged.
- Duplicate email rejected. Weak password rejected by Better Auth's policy.
- Legacy fixture: upgrade refuses to attach credentials to `local-board`
  and prints the two paths.

---

## Spec 4. Account profile and email management

### Problem

An operator who starts local and later moves to a hosted instance with
password-reset mail needs to change the account email. Better Auth's
`changeEmail` is not enabled, and there is no admin-side update.

### Change

- Enable `user.changeEmail` in `server/src/auth/better-auth.ts`. While no
  mail transport is configured, the change applies immediately with
  `emailVerified: false`. When mail is configured (future), use Better
  Auth's verification flow unchanged.
- Add `PATCH /api/admin/users/:userId` for instance admins: `name`,
  `email`. Email uniqueness enforced. Writes an `activity_log` row at the
  instance level. Admins cannot change their own email through this route
  without a current password (use Better Auth's own endpoint for self-service).
- Account page in the UI gets name and email fields using the Better Auth
  client. Instance Access user detail gets the admin fields.
- Password reset: document that it requires mail configuration; do not build
  a transport in this spec.

### Acceptance

- Operator changes email in the UI, signs out, signs in with the new email.
  Same `userId`.
- Admin changes another user's email; that user's next request still
  resolves to the same `userId`.
- Changing to an email already in use returns 409.

---

## Spec 5. Harden and surface the legacy claim flow

### Problem

`claimBoardOwnership` in `server/src/board-claim.ts` checks the challenge
before the transaction, keeps the challenge in process memory, and takes no
lock. Two concurrent requests with a valid token can both become admins.
The URL is printed to the console at startup only.

### Change

**Correctness.**
- Move the status check inside the transaction and lock
  `instance_user_roles` in share row exclusive mode, matching
  `first-admin-claim.ts`.
- Persist the challenge in `instance_settings.general.boardClaimChallenge`
  (token hash, code hash, `expiresAt`, `claimedByUserId`) so a restart does
  not reissue and so a multi-process deployment agrees on it. Compare hashes,
  never store plaintext.
- After a successful claim, call Spec 1's reconciliation in preview mode and
  return its summary in the response, so the UI can say what still needs the
  CLI.

**Discoverability.**
- Add `GET /api/board-claim/status` for signed-in session actors in
  `authenticated` mode returning `{ pending: boolean }` only. No token, no
  code.
- When pending, the UI shows a persistent banner for any signed-in user:
  "This instance still has its local placeholder as the only admin. An
  operator must run `paperclipai auth board-claim-url` on the host and open
  the link while signed in here." The banner never reveals the secret.
- Add `paperclipai auth board-claim-url` which prints the current URL from
  the persisted challenge, or issues a new one if expired. Host authority is
  the gate, same as today.

**Fail closed.** Remove every `req.actor.userId ?? "local-board"` fallback
reachable by a board-type actor in `authenticated` mode (list in Spec 2). A
session with no `userId` is a bug and must 401, not act as the sentinel.

### Acceptance

- Two parallel claim requests with the same valid token: exactly one
  succeeds, exactly one `instance_admin` row exists for the winner,
  `local-board` is demoted once.
- Restart between issuing and claiming: the same URL still works.
- Expired token returns 409 and the CLI issues a fresh one.
- Signed-in non-admin sees the banner; the status route returns no secret
  material.
- In `authenticated` mode, a crafted request that reaches a board route with
  no session is rejected and writes nothing attributed to `local-board`.

---

## Spec 6. The Board: definition and management

### Problem

"Board" has three meanings and no screen. The operator cannot see who holds
instance authority or whether agents can.

### Definition

The Board is the set of users holding `instance_admin`, excluding the agent
sentinel. Agents are never Board members. There is no second mechanism.

### Change

- **Instance Access page.** Add a "The Board" section at the top listing
  every `instance_admin` user with name, email, and whether they are the
  recorded operator. Actions: add (search existing users and promote),
  remove (existing demote route). Removing the last member is refused with
  a clear message. The `local-board` sentinel is hidden from this list and
  from the user search; if it still holds `instance_admin` (legacy), show a
  single warning row linking to the Spec 5 banner text.
- **Explainer copy.** One paragraph: Board members administer the whole
  instance, can create companies, and are the fallback addressee for
  approvals that name no one. Agents can report to Board members but cannot
  be Board members. Company-level roles are managed per company.
- **Org chart.** The root node "The Board" lists its members as children
  before the human managers, resolved from the same query. Remove the
  `local-board` special case in `userDisplayName`.
- **Approvals.** `approval-decision-policy.ts` renders the addressee as the
  actual Board member list or the operator's name, never "the Board owner"
  for a sentinel.
- **API.** `GET /api/admin/board` returns the member list. Reuse
  `isInstanceAdmin` and `admin/users`; no new table.

### Acceptance

- After Spec 1 on the reporter's fixture, the Board section shows exactly
  one member: the named account. No placeholder.
- Promote a second user: both appear, org chart root updates.
- Demote the last member: 409.
- Agent detail pages show "Reports to" a Board member but offer no control
  to make an agent a Board member.

---

## Spec 7. Identity-first fresh onboarding

### Problem

The CLI `onboard` asks about reachability first and derives the auth mode
from the bind preset (`buildPresetServerConfig` in
`cli/src/config/server-bind.ts`: loopback means `local_trusted`, everything
else means `authenticated`). There is no way to pick login without picking a
non-loopback bind, even though `authenticated/private` plus `loopback` is a
supported configuration per `doc/DEPLOYMENT-MODES.md`.

### Change

- Decouple mode from bind in `buildPresetServerConfig`: accept
  `{ bind, requireLogin }`. Keep the three existing presets, add one.
- Reword the first question to **"How will you use Paperclip?"** with these
  mappings:

| Choice | Config |
|---|---|
| Only on this computer | `local_trusted`, `bind=loopback` |
| Other devices, teammates, or a remote assistant | `authenticated/private`, bind prompt follows (lan or tailnet) |
| Not sure yet | `authenticated/private`, `bind=loopback` |
| Advanced | existing custom path |

- "Only on this computer" shows: "You can enable login later. Your work
  stays with your account when you do." This is true once Spec 3 ships, and
  the copy ships with Spec 3, not before.
- For authenticated choices, run Spec 3's credential prompt immediately so
  the operator is created with a login from the start. No `bootstrap_pending`
  state is ever visible for CLI-driven fresh installs.
- `BootstrapPendingPage` (browser-first path for appliance installs) keeps
  the existing claim button and gains the same explainer copy.
- `--yes` quickstart keeps today's behavior.

### Acceptance

- "Not sure yet": server listens on `127.0.0.1` only, login required,
  operator can sign in, `/api/health` shows `ready`.
- "Other devices": bind prompt appears; choosing tailnet with no Tailscale
  detected falls back to loopback with the existing warning.
- "Only on this computer": no credential prompt, dedicated operator created
  per Spec 2.
- Snapshot test of the prompt copy.

---

## 3. Cross-cutting test matrix

| Scenario | Specs | Required result |
|---|---|---|
| Populated local instance, reconcile to new account | 1 | Target acts on all issues and pending approvals; provider defaults resolve; user-bound grants listed for reauth; comment attribution unchanged; second apply no-op |
| Fresh local install, work, upgrade to login, restart | 2, 3 | Same `userId` before and after; no claim URL; loopback unchanged |
| Legacy local instance boots on new version | 2 | Zero row changes; health reports legacy |
| Parallel legacy claims | 5 | One winner, one admin row, one demotion |
| Signed-in session with no userId in authenticated mode | 2, 5 | 401, nothing written as sentinel |
| Board page after reconciliation | 6 | One member, no placeholder |
| Fresh "Not sure yet" install | 7 | Login required, loopback only |
| Remote agent joins after upgrade | all | Uses invite/join-request path; no human credential reused; operator identity unchanged |

Use disposable PGlite and Postgres fixtures. Assert on IDs and
authorization outcomes, not labels. Never point tests at a live config or
data directory.

## 4. Explicit non-goals

- Merging two named human accounts.
- Any change to bind, proxy, HTTPS, or Tailscale handling beyond the
  preset decoupling in Spec 7.
- A mail transport for password reset.
- New authentication providers.
- Automatic migration of any existing instance at startup.
- Approving an agent because its host is reachable.

## 5. Docs to update when shipping

- `doc/DEPLOYMENT-MODES.md` sections 6, 7, 8, and 9 (operator identity,
  claim persistence, upgrade in place).
- `doc/CLI.md` for `auth reconcile-identity`, `auth
  set-operator-credentials`, `auth board-claim-url`.
- `doc/SPEC-implementation.md` identity invariants.
- Onboarding help text in the UI and the CLI prompt copy.
