import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { accessApi } from "../api/access";
import type { HealthStatus } from "../api/health";
import { useAccountIdentity } from "../api/companies-query";
import { queryKeys } from "../lib/queryKeys";
import { InlineBanner } from "./InlineBanner";

export const BOARD_CLAIM_PENDING_COPY =
  "This instance still has its local placeholder as the only admin. An operator must run paperclipai auth board-claim-url on the host and open the link while signed in here.";

/**
 * Persistent notice for every signed-in user of an `authenticated` instance
 * whose only instance admin is still the `local-board` placeholder (legacy
 * claim flow, Spec 5). It asks `/api/board-claim/status`, which returns
 * `{ pending }` and nothing else, so the banner can never leak the claim URL.
 */
export function BoardClaimPendingBanner({ health }: { health?: HealthStatus }) {
  const { userId, settled } = useAccountIdentity();
  const authenticatedMode = health?.deploymentMode === "authenticated";
  const statusQuery = useQuery({
    queryKey: queryKeys.access.boardClaimPending,
    queryFn: () => accessApi.getBoardClaimPendingStatus(),
    enabled: authenticatedMode && settled && Boolean(userId),
    retry: false,
    staleTime: 60_000,
  });

  if (!statusQuery.data?.pending) return null;

  return (
    <InlineBanner
      tone="warning"
      icon={ShieldAlert}
      title="Board ownership has not been claimed"
      compact
      className="rounded-none border-x-0 border-t-0"
    >
      This instance still has its local placeholder as the only admin. An operator must run{" "}
      <code className="font-mono">paperclipai auth board-claim-url</code> on the host and open the link while
      signed in here.
    </InlineBanner>
  );
}
