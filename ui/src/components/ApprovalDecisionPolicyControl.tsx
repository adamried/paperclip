import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save, ShieldCheck } from "lucide-react";
import type { ApprovalDecisionPolicy, ApprovalDecisionPolicyMode } from "@paperclipai/shared";
import { approvalDecisionPolicyApi } from "@/api/approval-decision-policy";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";

const POLICY_OPTIONS: RadioCardOption[] = [
  {
    value: "any_board",
    title: "Anyone on the Board can decide",
    description: "Approvals from the agents you manage land in your inbox first, but any Board member may approve or reject them. Good cover when you are out.",
  },
  {
    value: "addressee_only",
    title: "Only I can decide",
    description: "Other Board members see these approvals but cannot decide them. Flip this back when you want cover.",
  },
];

/**
 * "Who may decide approvals addressed to me" user-settings control. A single
 * two-state policy round-tripped through the per-user endpoints.
 */
export function ApprovalDecisionPolicyControl({ companyId }: { companyId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ApprovalDecisionPolicyMode | null>(null);
  const lastServerValueRef = useRef<ApprovalDecisionPolicyMode | null>(null);

  const policyQuery = useQuery({
    queryKey: companyId ? queryKeys.approvalDecisionPolicy.mine(companyId) : ["approval-decision-policy", "none"],
    queryFn: () => approvalDecisionPolicyApi.getMine(companyId!),
    enabled: !!companyId,
  });
  const policy = policyQuery.data;

  // Adopt server state on first load, or on refetch when the user has not
  // diverged from the previously-synced value.
  useEffect(() => {
    if (!policy) return;
    setDraft((current) => (current === null || current === lastServerValueRef.current ? policy.policy : current));
    lastServerValueRef.current = policy.policy;
  }, [policy]);

  const updateMutation = useMutation({
    mutationFn: (next: ApprovalDecisionPolicyMode) =>
      approvalDecisionPolicyApi.updateMine(companyId!, { policy: next }),
    onSuccess: (saved) => {
      queryClient.setQueryData<ApprovalDecisionPolicy>(queryKeys.approvalDecisionPolicy.mine(companyId!), saved);
    },
  });

  const isDirty = Boolean(draft && policy && draft !== policy.policy);

  if (policyQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {policyQuery.error instanceof Error ? policyQuery.error.message : "Failed to load approval decision policy."}
      </div>
    );
  }

  if (policyQuery.isLoading || !draft) {
    return <div className="text-sm text-muted-foreground">Loading approval decision policy…</div>;
  }

  return (
    <section className="space-y-4" aria-label="Who may decide approvals addressed to me">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Who may decide approvals addressed to me</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          When an agent that reports to you asks for Board approval, the request is addressed to you. Choose whether other Board members may decide it on your behalf.
        </p>
      </div>

      <RadioCardGroup
        ariaLabel="Approval decision policy"
        value={draft}
        onValueChange={(value) => setDraft(value === "addressee_only" ? "addressee_only" : "any_board")}
        options={POLICY_OPTIONS}
        className="max-w-2xl"
      />

      {updateMutation.error ? (
        <div className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {updateMutation.error instanceof Error ? updateMutation.error.message : "Failed to save approval decision policy."}
        </div>
      ) : null}

      <div className="flex max-w-2xl items-center justify-end gap-3">
        {updateMutation.isSuccess && !isDirty ? (
          <span className="text-xs text-muted-foreground" role="status">Saved</span>
        ) : null}
        <Button
          type="button"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => draft && updateMutation.mutate(draft)}
        >
          {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
