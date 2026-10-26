# Deployment Modes

Status: Canonical deployment and auth mode model  
Date: 2026-02-23

## 1. Purpose

Paperclip supports two runtime modes:

1. `local_trusted`
2. `authenticated`

`authenticated` supports two exposure policies:

1. `private`
2. `public`

This keeps one authenticated auth stack while still separating low-friction private-network defaults from internet-facing hardening requirements.

Paperclip now treats **bind** as a separate concern from auth:

- auth model: `local_trusted` vs `authenticated`, plus `private/public`
- reachability model: `server.bind = loopback | lan | tailnet | custom`

## 2. Canonical Model

| Runtime Mode | Exposure | Human auth | Primary use |
|---|---|---|---|
| `local_trusted` | n/a | No login required | Single-operator local machine workflow |
| `authenticated` | `private` | Login required | Private-network access (for example Tailscale/VPN/LAN) |
| `authenticated` | `public` | Login required | Internet-facing/cloud deployment |

## Reachability Model

| Bind | Meaning | Typical use |
|---|---|---|
| `loopback` | Listen on localhost only | default local usage, reverse-proxy deployments |
| `lan` | Listen on all interfaces (`0.0.0.0`) | LAN/VPN/private-network access |
| `tailnet` | Listen on a detected Tailscale IP | Tailscale-only access |
| `custom` | Listen on an explicit host/IP | advanced interface-specific setups |

## 3. Security Policy

## `local_trusted`

- loopback-only host binding
- no human login flow
- optimized for fastest local startup

## `authenticated + private`

- login required
- low-friction URL handling (`auto` base URL mode)
- private-host trust policy required
- Better Auth request rate limiting is off by default for private mode to keep local/LAN repair loops from locking out the operator; set `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=true` to opt in
- bind can be `loopback`, `lan`, `tailnet`, or `custom`

## `authenticated + public`

- login required
- explicit public URL required
- stricter deployment checks and failures in doctor
- Better Auth request rate limiting is on by default; set `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false` only when an explicit front-door limiter covers the deployment
- recommended bind is `loopback` behind a reverse proxy; direct `lan/custom` is advanced
- local stdio MCP runtime slots fail closed by default; set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` only when a trusted worker/runtime host is configured to supervise those processes. Remote HTTP MCP remains the preferred public-hosted path.

### Paperclip Cloud warm-pool identity

A Cloud-managed warm-pool process initially boots under a `pool-*` origin. It
receives only Cloud's public verification set in
`PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS`. Before Cloud activates a claimed stack,
the existing server-to-server health request carries a short-lived Ed25519 JWS
that binds the immutable `PAPERCLIP_CLOUD_STACK_ID`, pool claim, previous
origin, canonical HTTPS origin, and slug. Paperclip verifies and persists that
one-time assertion, updates its live public/API URL provider, and acknowledges
the exact origin in `/api/health` before the first user request is admitted.

The Harness signing private key is never present in Paperclip, browsers, or
other tenant stacks. A different claim or destination cannot replace the
persisted identity. On restart, the durable identity is loaded before auth,
routes, and child-runtime configuration, even when provider variables are
temporarily stale. Self-hosted deployments continue to use their configured
`PAPERCLIP_PUBLIC_URL` and do not participate in this protocol.

## 4. Onboarding UX Contract

Default onboarding remains interactive and flagless:

```sh
pnpm paperclipai onboard
```

Server prompt behavior:

1. quickstart `--yes` defaults to `server.bind=loopback` and therefore `local_trusted/private`
2. advanced server setup asks reachability first:
- `Trusted local` → `bind=loopback`, `local_trusted/private`
- `Private network` → `bind=lan`, `authenticated/private`
- `Tailnet` → `bind=tailnet`, `authenticated/private`
- `Custom` → manual mode/exposure/host entry
3. raw host entry is only required for the `Custom` path
4. explicit public URL is only required for `authenticated + public`

Examples:

```sh
pnpm paperclipai onboard --yes
npx paperclipai onboard --yes --bind lan
npx paperclipai run --bind tailnet
```

`configure --section server` follows the same interactive behavior.

## 5. Doctor UX Contract

Default doctor remains flagless:

```sh
pnpm paperclipai doctor
```

Doctor reads configured mode/exposure and applies mode-aware checks. Optional override flags are secondary.

## 6. Operator Identity and Board/User Integration Contract

Paperclip identifies the instance's human operator with one user id for the
life of the instance. That id is the implicit actor in `local_trusted` mode
and, once login is enabled, the account that keeps every company, task,
approval, and provider default (section 8). Enabling login never creates a
second human.

### 6.1 The operator user

On the first `local_trusted` start of an instance with no recorded operator,
startup (`ensureOperatorIdentity` in `server/src/operator-identity.ts`) creates
one `authUsers` row:

- random id
- name `Operator`
- email `operator@<instanceId>.paperclip.local` (unique, not routable)
- `emailVerified: false`

It grants that row `instance_admin` and an active `owner` membership in every
company, and records the id in `instance_settings.general.operatorUserId`.
Later starts only re-assert those grants (for example owner membership in a
company created since). The record is server-managed metadata, not a setting:
`GET /api/instance/settings/general` strips it and the general-settings patch
schema rejects it, while general-settings writes preserve it.

Header-less requests in `local_trusted` mode act as the operator
(`req.actor.source = "local_implicit"`, `userId` = the operator id,
`isInstanceAdmin: true`). `/api/auth/get-session` reports the same user, so
"me", user assignment, approvals addressed to the operator, and per-user
provider defaults all key on one id.

### 6.2 The agent sentinel `local-board`

`local-board` (`AGENT_SENTINEL_USER_ID` in `@paperclipai/shared`) is the
non-human sentinel that agent-authored rows are written under. It is a real
`authUsers` row only so those foreign keys resolve. On new instances it holds
no `instance_admin` role and no company membership, and display paths render
it as "Agent runtime". It is never a seat on the Board and never the operator.

In `local_trusted` mode a header-less request that carries
`X-Paperclip-Run-Id` comes from an agent run's subprocess, which reaches the
API without credentials of its own. It is attributed to the sentinel, not the
operator, so comment attribution keeps deriving the agent from the run
(`NON_HUMAN_SENTINEL_AUTHOR_USER_IDS` in `server/src/services/issues.ts`) and
a human operator is never credited with agent output. Authorization is the
same local-implicit board shape either way; only the user identity differs.

Code never falls back to `"local-board"` for a board-typed actor whose
`userId` is missing. Board routes use `requireActorUserId` and fail closed
with 401.

### 6.3 Legacy instances

An instance created before dedicated operators existed has `local-board`
holding `instance_admin` and nothing recorded in
`instance_settings.general.operatorUserId`. Such an instance is **legacy**:

- startup never migrates it: zero rows change on boot
- the sentinel doubles as the operator in memory only, so every request
  resolves exactly as it did before
- startup logs one warning naming this document
- `/api/health` reports `operatorIdentity: "legacy"`

Migration is an explicit host action, never a side effect of upgrading:

1. `paperclipai auth reconcile-identity --from local-board --to <email> --apply`
   moves operational ownership into a real account and records it as the
   operator (reconciliation spec), or
2. the browser claim flow in section 7.

`paperclipai auth set-operator-credentials` refuses a legacy instance and
prints these two paths; it never attaches a password to the sentinel.

### 6.4 `operatorIdentity` in `/api/health`

| Value | Meaning |
|---|---|
| `dedicated` | A dedicated operator user is recorded. Fresh `local_trusted` installs and instances upgraded in place report this. |
| `legacy` | Nothing is recorded and `local-board` still holds `instance_admin` (section 6.3). |
| `none` | Nothing is recorded and the sentinel is not an admin, for example a fresh `authenticated` install whose first admin is a real signup. |

The field rides every response shape that carries `bootstrapStatus`.

### 6.5 Required integration points

Operator identity must be represented by a real DB user principal for
user-based features to work consistently:

- real user row in `authUsers` for the operator
- `instance_user_roles` entry for instance admin authority
- `company_memberships` integration for user-level task assignment and access

This is required because user assignment paths validate active membership for
`assigneeUserId`.

## 7. Local Trusted -> Authenticated Claim Flow (Legacy Instances)

This flow applies to legacy instances (section 6.3). An instance with a
dedicated operator never needs it: the operator already holds
`instance_admin`, so `bootstrapStatus` is `ready` and no claim URL is issued
(section 8.1).

When running `authenticated` mode, if the only instance admin is
`local-board`, Paperclip emits a startup warning with a one-time high-entropy
claim URL.

- URL format: `/board-claim/<token>?code=<code>`
- intended use: signed-in human claims board ownership
- claim action (one locked transaction, same lock as the first-admin claim):
  - promotes current signed-in user to `instance_admin`
  - demotes `local-board` admin role
  - ensures active owner membership for the claiming user across existing companies
  - marks the challenge as claimed, so two concurrent valid claims produce exactly one winner and the loser receives `409`

Challenge persistence:

- the challenge is stored in `instance_settings.general.boardClaimChallenge` as SHA-256 hashes of the token and code plus `expiresAt` / `claimedAt` / `claimedByUserId`; plaintext is never written
- a restart reuses an unexpired, unclaimed challenge instead of reissuing, so a URL printed before the restart still works; multi-process deployments agree on the same record
- only the process that minted the challenge knows the plaintext, so a restarted server prints no URL. Run `paperclipai auth board-claim-url` on the host to issue a fresh challenge (superseding the outstanding one) and print its URL. Host (database) authority is the gate.
- an expired challenge returns `409` on claim; startup or the CLI issues a new one

Discoverability:

- `GET /api/board-claim/status` returns `{ pending: boolean }` to signed-in session actors in `authenticated` mode. It carries no token or code.
- while pending, every signed-in user sees a persistent banner: "This instance still has its local placeholder as the only admin. An operator must run `paperclipai auth board-claim-url` on the host and open the link while signed in here."
- the claim response includes `reconciliationPreview` (currently `null`; the identity-reconciliation summary lands with Spec 1 of `doc/plans/2026-10-26-operator-identity-and-board-ownership.md`)

The Board is the set of users holding `instance_admin`, excluding the `local-board` agent sentinel. `GET /api/admin/board` lists it, the Instance Access page manages it (add via user search and promote, remove via demote; removing the last member is refused with `409`), and the org chart lists its members directly under "The Board". `local-board` is never offered as a Board member.

This prevents lockout when a user migrates from long-running local trusted
usage to authenticated mode. The claim moves roles and memberships only;
operational references (assignments, pending approvals, provider defaults)
are moved by `paperclipai auth reconcile-identity`.

The claim moves roles and memberships only. Operational references created in
local mode (issues assigned to `local-board`, pending approvals addressed to
it, per-user model-provider defaults, and so on) stay on `local-board` until
the operator runs the host-authorized reconciliation command, which previews by
default and applies in one transaction:

```sh
npx paperclipai auth reconcile-identity --from local-board --to <userId|email> [--apply] [--include-board-keys]
```

See `doc/CLI.md` ("Identity reconciliation after moving to authenticated mode")
for what moves, what is only counted, and what must be re-authorized.

## 8. First Admin Setup For Fresh Authenticated Installs

Fresh authenticated installs start in `bootstrap_pending` until the first
`instance_admin` exists.

For `authenticated/private`, Paperclip supports a browser-first setup path:

1. open the Paperclip URL from the private network or appliance UI
2. sign in or create a Paperclip account
3. choose `Claim this instance` on the setup screen

That browser claim promotes the signed-in session user to the first instance
admin and then falls through to normal onboarding. The endpoint is available
only to real browser session actors in `authenticated/private`; unauthenticated
requests, agent keys, board API keys, and local implicit board actors are
rejected.

This is intentionally a first-claim bootstrap contract: before an instance
admin exists, the first authenticated browser session that completes the claim
wins. Operators must keep a `bootstrap_pending` private deployment on a trusted
network and complete setup before admitting untrusted users. This behavior is
not an account-recovery or public-deployment mechanism.

The CLI fallback remains supported in all authenticated setup states:

```sh
pnpm paperclipai auth bootstrap-ceo
```

That command prints a one-time first-admin invite URL. Browser claim and
bootstrap invite acceptance share the same first-admin transaction, so whichever
path wins first makes later attempts return a conflict.

For `authenticated/public`, browser first-admin claim is intentionally disabled.
Public deployments must use the high-entropy bootstrap invite path unless a
future public-hosted setup design explicitly changes this policy.

### 8.1 Upgrade In Place: Enabling Login Keeps The Operator

An instance that started in `local_trusted` mode with a dedicated operator
(section 6.1) does not go through either bootstrap path when login is enabled.
The operator gains a password instead:

1. `paperclipai configure --section server` and choose an authenticated
   reachability (`Private network`, `Tailnet`, or `Custom` with
   `authenticated`). When the mode moves from `local_trusted` to
   `authenticated`, the CLI prompts for the operator's email and password
   (confirmed). The email must be unique among `authUsers`.
2. The operator's `authUsers` row gets the email (`emailVerified` stays
   `false`; there is no mail transport) and one `authAccounts` row with
   Better Auth's credential provider: `providerId: "credential"`,
   `issuer: "local:credential"`, `accountId` = the operator's user id, and a
   password hashed with Better Auth's own exported hasher
   (`hashPassword` from `better-auth/crypto`). The normal
   `/api/auth/sign-in/email` endpoint accepts it and the session's `userId`
   is the pre-upgrade operator id.
3. The config is saved regardless of the prompt's outcome. On next start the
   operator already holds `instance_admin`, so `bootstrapStatus` is `ready`,
   no claim URL is logged, and `/api/health` reports
   `operatorIdentity: "dedicated"`.

Headless alternative (also usable before switching the mode, or after
skipping the prompt):

```sh
paperclipai auth set-operator-credentials --email <email>                  # password prompted
echo "$PASSWORD" | paperclipai auth set-operator-credentials --email <email> --password-stdin
```

Both forms run on the host with database access (an embedded PostgreSQL
cluster must be running). A duplicate email is rejected; the password follows
Better Auth's bounds (8 to 128 characters). Re-running replaces the password
on the same account rather than adding a second human.

Bind is untouched. Enabling login does not change the listening address; LAN
or Tailscale reachability remains the separate bind prompt.

On a legacy instance (section 6.3) the prompt and the command refuse to attach
credentials to `local-board` and print the two migration paths instead.

## 9. Account Profile, Email, and Password Reset

An account is one `authUsers` row for the life of the instance. Changing its
name or email never creates a second user; sessions, memberships, assignments,
and provider defaults keep pointing at the same `userId`.

Self-service (Settings → Profile, `authenticated` mode only):

- Display name goes through `PATCH /api/auth/profile`.
- Email goes through Better Auth's `POST /api/auth/change-email`, enabled in
  `server/src/auth/better-auth.ts` with `updateEmailWithoutVerification`.
  Paperclip configures no mail transport, so for an account whose email is not
  verified the change applies immediately and `emailVerified` stays `false`.
  Better Auth requires a fresh session for this call (`session.freshAge`,
  one day by default); sign out and back in if it refuses. When the new address
  already belongs to another account, Better Auth answers success without
  changing anything, so the page re-reads the session and reports that the
  address did not move.
- In `local_trusted` mode there is no Better Auth mount, so the email field is
  read-only there.

Instance administration (Settings → Instance settings → Access):

- `PATCH /api/admin/users/:userId` lets an instance admin change another user's
  name and email. Email uniqueness is enforced (`409` on conflict), the change
  resets `emailVerified`, and the target's existing sessions keep resolving to
  the same `userId`. One `activity_log` row per company records the change
  (`admin_user.profile_updated`).
- An admin cannot change their own email through this route; that goes
  through the self-service endpoint above, which runs on a fresh session rather
  than on instance authority alone.

Password reset requires mail configuration. Paperclip ships no mail transport,
so Better Auth's forgot-password and email-verification flows are not wired up
and there is no reset link to send. Until an operator configures one (a future
change; see `doc/plans/2026-10-26-operator-identity-and-board-ownership.md`,
Spec 4), recovery for a lost password is operator-side: an instance admin can
move the account to an address the person controls with the admin route above,
but cannot reset the password. Keep at least one working credential for an
instance admin, and treat a verified-email account's inability to change its
own email until mail exists as expected behaviour.

## 10. Current Code Reality (As Of 2026-10-26)

- runtime values are `local_trusted | authenticated`
- `authenticated` uses Better Auth sessions and bootstrap invite flow
- `local_trusted` resolves the operator identity at startup
  (`server/src/operator-identity.ts`): a fresh instance gets a dedicated
  operator user with `instance_user_roles` admin access and owner
  memberships; a legacy instance is classified, logged, and left untouched
- `local-board` is created as a grant-free agent sentinel on new instances
- `/api/health` reports `operatorIdentity: dedicated | legacy | none`
- `paperclipai configure --section server` offers the operator credential
  upgrade when the mode moves to `authenticated`;
  `paperclipai auth set-operator-credentials` is the headless form
- company creation ensures creator membership in `company_memberships` so user assignment/access flows remain consistent

## 11. Naming and Compatibility Policy

- canonical naming is `local_trusted` and `authenticated` with `private/public` exposure
- no long-term compatibility alias layer for discarded naming variants

## 12. Relationship to Other Docs

- implementation plan: `doc/plans/2026-02-23-deployment-auth-mode-consolidation.md`
- V1 contract: `doc/SPEC-implementation.md`
- operator workflows: `doc/DEVELOPING.md` and `doc/CLI.md`
- invite/join state map: `doc/spec/invite-flow.md`
