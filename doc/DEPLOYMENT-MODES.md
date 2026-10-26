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

## 6. Board/User Integration Contract

Board identity must be represented by a real DB user principal for user-based features to work consistently.

Required integration points:

- real user row in `authUsers` for Board identity
- `instance_user_roles` entry for Board admin authority
- `company_memberships` integration for user-level task assignment and access

This is required because user assignment paths validate active membership for `assigneeUserId`.

## 7. Local Trusted -> Authenticated Claim Flow

When running `authenticated` mode, if the only instance admin is `local-board`, Paperclip issues a one-time high-entropy claim challenge and prints its URL in the startup warning.

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

This prevents lockout when a user migrates from long-running local trusted usage to authenticated mode.

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

## 10. Current Code Reality (As Of 2026-02-23)

- runtime values are `local_trusted | authenticated`
- `authenticated` uses Better Auth sessions and bootstrap invite flow
- `local_trusted` ensures a real local Board user principal in `authUsers` with `instance_user_roles` admin access
- company creation ensures creator membership in `company_memberships` so user assignment/access flows remain consistent

## 11. Naming and Compatibility Policy

- canonical naming is `local_trusted` and `authenticated` with `private/public` exposure
- no long-term compatibility alias layer for discarded naming variants

## 12. Relationship to Other Docs

- implementation plan: `doc/plans/2026-02-23-deployment-auth-mode-consolidation.md`
- V1 contract: `doc/SPEC-implementation.md`
- operator workflows: `doc/DEVELOPING.md` and `doc/CLI.md`
- invite/join state map: `doc/spec/invite-flow.md`
