import { z } from "zod";

export const approvalDecisionPolicyModeSchema = z.enum(["any_board", "addressee_only"]);

export const updateApprovalDecisionPolicySchema = z.object({
  policy: approvalDecisionPolicyModeSchema,
}).strict();

export type UpdateApprovalDecisionPolicy = z.infer<typeof updateApprovalDecisionPolicySchema>;
