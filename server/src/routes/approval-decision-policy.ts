import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { updateApprovalDecisionPolicySchema } from "@paperclipai/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { approvalDecisionPolicyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Per-person "who may decide approvals addressed to me" setting. Self-service
 * only: a person edits their own, per company.
 */
export function approvalDecisionPolicyRoutes(db: Db) {
  const router = Router();
  const policies = approvalDecisionPolicyService(db);

  function selfUserId(req: Request) {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board user context required");
    return req.actor.userId;
  }

  async function writePolicy(req: Request, companyId: string, userId: string) {
    const previous = await policies.get(companyId, userId);
    const policy = await policies.update(companyId, userId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "approval.decision_policy_updated",
      entityType: "user_approval_decision_policy",
      entityId: userId,
      details: {
        userId,
        previousPolicy: previous.policy,
        policy: policy.policy,
      },
    });
    return policy;
  }

  router.get("/companies/:companyId/users/me/approval-decision-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await policies.get(companyId, selfUserId(req)));
  });

  router.put(
    "/companies/:companyId/users/me/approval-decision-policy",
    validate(updateApprovalDecisionPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await writePolicy(req, companyId, selfUserId(req)));
    },
  );

  // Deliberately no `users/:userId` variant: the policy is the person's own
  // consent boundary, and an administrator loosening it would defeat "only I
  // can decide". Administrators change the agent's manager instead.

  return router;
}
