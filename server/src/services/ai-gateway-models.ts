import type { AdapterModel } from "@paperclipai/adapter-utils";

// Model discovery against a gateway (LiteLLM, corporate proxy) fronting a
// provider API. The gateway decides which models a key may use, so its list
// is the truth for that connection; the adapter's static catalog is merged in
// afterwards for familiarity. Responses are cached briefly per connection so a
// model picker does not hammer the gateway. Keys never leave this module.

const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const cache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

export type GatewayModelSource = { connectionId: string; baseUrl: string; apiKey: string };

/** Parse an OpenAI-style or Anthropic-style `/v1/models` body into adapter models. */
export function parseGatewayModels(body: unknown): AdapterModel[] {
  const data = (body as { data?: unknown; models?: unknown })?.data ?? (body as { models?: unknown })?.models;
  if (!Array.isArray(data)) return [];
  const models: AdapterModel[] = [];
  for (const entry of data) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id.trim()) continue;
    const label = typeof (entry as { display_name?: unknown })?.display_name === "string"
      ? ((entry as { display_name: string }).display_name)
      : id;
    models.push({ id, label });
  }
  return models;
}

export async function listGatewayModels(
  source: GatewayModelSource,
  options: { refresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<AdapterModel[]> {
  const cached = cache.get(source.connectionId);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.models;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${source.baseUrl.replace(/\/+$/, "")}/v1/models`;
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${source.apiKey}`,
        "x-api-key": source.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return cached?.models ?? [];
    }
    const models = parseGatewayModels(await response.json());
    cache.set(source.connectionId, { expiresAt: Date.now() + CACHE_TTL_MS, models });
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

/** Gateway models first, then the adapter's own catalog, without duplicates. */
export function mergeGatewayModels(gateway: AdapterModel[], catalog: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const merged: AdapterModel[] = [];
  for (const model of [...gateway, ...catalog]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}
