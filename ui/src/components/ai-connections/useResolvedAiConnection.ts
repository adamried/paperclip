import { useQuery } from "@tanstack/react-query";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { personalAiDefault, type AiConnectionSummary } from "./model";

/**
 * The connection an agent binding resolves to right now: the pinned one for
 * an explicit binding, or the current user's personal default for the
 * provider on a responsible-user binding. Keyed on the same query the
 * connection field uses, so a new sign-in or a default change re-resolves it
 * and anything derived from it (the model list) refetches.
 */
export function useResolvedAiConnection(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  agentId?: string,
): AiConnectionSummary | null {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId!, agentId),
    enabled: Boolean(companyId && binding),
  });
  if (!binding || !accounts.data) return null;
  if ("connectionId" in binding) {
    return accounts.data.connections.find((connection) => connection.id === binding.connectionId) ?? null;
  }
  return personalAiDefault(accounts.data.connections, { companyId: companyId!, provider: binding.provider }, accounts.data.currentUserId) ?? null;
}
