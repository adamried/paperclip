---
title: Approvals
summary: Governance flows for hiring and strategy
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent (typically a manager or CEO) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### CEO Strategy

The CEO's initial strategic plan requires board approval before the CEO can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Who an Approval Is Addressed To

When an agent that reports to a person requests approval, the request is addressed to that person. It lands in their inbox first, and the Approvals page shows an **Addressed to** chip. Requests from agents that report to the Board (or to another agent) are open to the whole Board as before.

Each person chooses, per organization, who may decide approvals addressed to them. Open **Profile settings → Who may decide approvals addressed to me**:

- **Anyone on the Board can decide** (default) — other Board members can approve or reject on your behalf. Use this for cover when you are out.
- **Only I can decide** — other Board members see the approval but get a clear refusal naming you if they try to decide it. Instance admins are not exempt. Flip it back when you want cover; the approval itself does not change.

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
