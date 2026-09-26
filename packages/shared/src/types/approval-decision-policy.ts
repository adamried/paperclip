export const APPROVAL_DECISION_POLICIES = ["any_board", "addressee_only"] as const;

export type ApprovalDecisionPolicyMode = (typeof APPROVAL_DECISION_POLICIES)[number];

/**
 * Who may decide approvals addressed to a person. `any_board` (default): any
 * Board member. `addressee_only`: only that person, even instance admins get
 * 403. Set by the person on their own profile, per company.
 */
export interface ApprovalDecisionPolicy {
  companyId: string;
  userId: string;
  policy: ApprovalDecisionPolicyMode;
  materialized: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}
