import type { ApprovalDecisionPolicy, UpdateApprovalDecisionPolicy } from "@paperclipai/shared";
import { api } from "./client";

/**
 * "Who may decide approvals addressed to me" setting. `any_board` (default)
 * lets any Board member decide; `addressee_only` reserves the decision for the
 * addressee.
 */
export const approvalDecisionPolicyApi = {
  getMine: (companyId: string) =>
    api.get<ApprovalDecisionPolicy>(`/companies/${companyId}/users/me/approval-decision-policy`),
  updateMine: (companyId: string, input: UpdateApprovalDecisionPolicy) =>
    api.put<ApprovalDecisionPolicy>(`/companies/${companyId}/users/me/approval-decision-policy`, input),
};
