import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { updateApprovalDecisionPolicySchema } from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, approvalDecisionPolicyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Per-person "who may decide approvals addressed to me" setting. Same shape
 * and authority model as the inbox agent policy routes: a person edits their
 * own, and permission administrators may edit anyone's.
 */
export function approvalDecisionPolicyRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const policies = approvalDecisionPolicyService(db);

  function selfUserId(req: Request) {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board user context required");
    return req.actor.userId;
  }

  async function assertAdmin(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (!req.actor.userId) throw unauthorized("Board user context required");
      if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    }
    throw forbidden("Approval decision policy administration authority required", {
      code: "approval_decision_policy_admin_required",
    });
  }

  async function assertActiveUserMembership(companyId: string, userId: string) {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") {
      throw notFound("Active company user membership not found");
    }
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

  router.get("/companies/:companyId/users/:userId/approval-decision-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertAdmin(req, companyId);
    await assertActiveUserMembership(companyId, userId);
    res.json(await policies.get(companyId, userId));
  });

  router.put(
    "/companies/:companyId/users/:userId/approval-decision-policy",
    validate(updateApprovalDecisionPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertAdmin(req, companyId);
      await assertActiveUserMembership(companyId, userId);
      res.json(await writePolicy(req, companyId, userId));
    },
  );

  return router;
}
