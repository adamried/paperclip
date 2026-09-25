import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AI_CONNECTION_CAPABILITIES,
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
} from "@paperclipai/shared";
import { AI_PROVIDERS } from "./model";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

/** The vendor provider a harness signs in with natively, when it has one. */
function nativeAiProviderForAdapter(adapterType: string): AiProvider | undefined {
  return (
    {
      claude_local: "anthropic",
      codex_local: "openai",
      opencode_local: "openrouter",
      grok_local: "xai",
    } as Record<string, AiProvider>
  )[adapterType];
}
/**
 * Every provider whose connections this harness can run: its native vendor
 * first, then a custom gateway when the gateway capability lists the harness.
 */
export function aiProvidersForAdapter(adapterType: string): AiProvider[] {
  const providers: AiProvider[] = [];
  const native = nativeAiProviderForAdapter(adapterType);
  if (native) providers.push(native);
  if (AI_CONNECTION_CAPABILITIES.gateway.methods.api_key?.adapters.includes(adapterType)) providers.push("gateway");
  return providers;
}
/** The provider a harness's connection field opens on. */
export function aiProviderForAdapter(
  adapterType: string,
): AiProvider | undefined {
  return aiProvidersForAdapter(adapterType)[0];
}
export function AiConnectionField({
  companyId,
  agentId,
  agentName,
  adapterType,
  model,
  value,
  onChange,
  environmentId,
  legacy = false,
  readOnly = false,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
}) {
  const providers = aiProvidersForAdapter(adapterType);
  // The binding's own provider wins so an agent on a gateway opens on it; a
  // fresh field opens on the harness's native vendor.
  const [chosenProvider, setChosenProvider] = useState<AiProvider | undefined>();
  const provider = (value?.provider && providers.includes(value.provider) ? value.provider : undefined) ?? chosenProvider ?? providers[0];
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const changeBinding = (next: AiConnectionBinding) => {
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); }
    else onChange(next);
  };
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(provider),
  });
  const method: AiAuthMethod = (value?.mode !== "responsible_user" ? value?.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider === "openrouter" ? "api_key" : "subscription");
  if (!provider) return null;
  if (legacy && !value && !adopting)
    return (
      <AiConnectionLegacyNotice
        readOnly={readOnly}
        onAdopt={() => setAdopting(true)}
      />
    );
  return (
    <div className="space-y-4">
      {providers.length > 1 && !readOnly && (
        <label className="block space-y-2 text-sm">
          <span className="text-muted-foreground">Provider</span>
          <Select value={provider} onValueChange={(next) => { setChosenProvider(next as AiProvider); if (value && value.provider !== next) changeBinding({ provider: next as AiProvider, method: "api_key", mode: "responsible_user" }); }}>
            <SelectTrigger aria-label="AI provider" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{providers.map((candidate) => <SelectItem key={candidate} value={candidate}>{AI_PROVIDERS[candidate].name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
      )}
      {value && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          This connection does not support the current harness and model. Choose
          a compatible connection before saving.
        </p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending}
        error={accounts.error?.message}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onConnect={() => { returnFocus.current = document.activeElement as HTMLElement; setConnecting(true); }}
        onRetry={() => void accounts.refetch()}
      />
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Adopt Connections for {agentName}</DialogTitle>
            <DialogDescription>
              Saving tests this account in {agentName}’s environment before
              replacing its existing authentication. Other agents keep their
              current configuration.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? `Responsible user’s default. For you: ${accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? "Not connected"}. Other users use their own default.`
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            After adoption, missing credentials block execution. Previous
            authentication will not be used as a fallback.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              Use this binding when saved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Connect account</DialogTitle>
          </DialogHeader>
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={method}
            name={`My ${AI_PROVIDERS[provider].name} ${method === "subscription" ? "subscription" : "API"}`}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={false}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={() => {
              void client.invalidateQueries({
                queryKey: ["ai-connections", companyId],
              });
              setConnecting(false);
              changeBinding({ provider, method, mode: "responsible_user" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
