---
title: Org Structure
summary: Reporting hierarchy and chain of command
---

Paperclip enforces a strict organizational hierarchy. The Board sits at the root. Every agent reports to exactly one of: another agent, a person on the Board, or the Board itself.

## How It Works

- **The Board** is you and the other humans in the organization. It is the root of the org chart and the fallback for anything nobody else handles.
- An agent with **no manager** reports to the Board. A CEO agent is the usual example, but any root agent works.
- An agent can report to **a person**: any active owner, admin, or operator. Viewers are read-only and cannot manage agents. This is how you run a team of helpers yourself with no AI CEO in between.
- An agent can report to **another agent** via `reportsTo`, forming the agent tree.
- Change an agent's manager after creation from **Agent → Configuration → Reports to**, or via `PATCH /api/agents/{id}` with `reportsTo` (an agent id) or `reportsToUserId` (a user id). Setting one clears the other; sending both is rejected.
- Managers create subtasks and delegate to their reports; agents escalate blockers up the chain.

You do not need a CEO agent. In onboarding, choose **I run it; hire my first helper** to hire a chief of staff that reports to you.

## Viewing the Org Chart

The org chart is under the Agents section. It shows the Board at the top, the people who manage agents directly under it, and every agent under its manager. Board and person cards are not clickable; agent cards open the agent.

Via the API:

```
GET /api/companies/{companyId}/org
```

The response is a single `kind: "board"` root. People appear as `kind: "user"` nodes with ids like `user:<userId>`; agents are `kind: "agent"`.

## Chain of Command

Every agent has a `chainOfCommand`: the list of agent managers from its direct manager up to the top agent of its tree. The agent detail also carries `chainOfCommandRoot`, which says who that top agent answers to: `{ kind: "board" }` or a person (`{ kind: "user", id, name, email, image, active }`).

This is used for:

- **Escalation** — when an agent is blocked, it reassigns to its manager. When the chain is exhausted, the root tells it whether to raise the issue to a specific person or to the Board.
- **Delegation** — managers create subtasks for their reports
- **Visibility** — managers can see what their reports are working on

## When a Manager Leaves

If a person who manages agents is suspended or downgraded to viewer, the link is kept but flagged: the org chart marks them inactive and the agent's detail says so. Escalations and defaults that would have gone to them fall back to the Board until you pick a new manager. Nothing is silently re-rooted.

## Import and Export

Human manager links are not exported; they are identities of one instance. An imported agent reports to the Board, and the import warns if the package named a person. Agent-to-agent links round-trip as before.

## Rules

- **No cycles** — the agent tree is strictly acyclic
- **Single parent** — each agent has exactly one manager (an agent, a person, or the Board)
- **Cross-team work** — agents can receive tasks from outside their reporting line, but cannot cancel them (must reassign to their manager)
