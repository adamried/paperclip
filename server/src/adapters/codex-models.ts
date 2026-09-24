import type { AdapterModel } from "./types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { codexHomeDir } from "@paperclipai/adapter-codex-local/server";
import { readConfigFile } from "../config-file.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...codexFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The model catalog the host Codex CLI last fetched from OpenAI, cached as
 * `models_cache.json` in the Codex home. Runs use the host CLI, so this is the
 * list of models that CLI can actually start, including ones newer than the
 * static fallback. Only models Codex itself lists (`visibility: "list"`) are
 * returned, in Codex's own priority order. A missing or unreadable cache
 * yields an empty list; the static fallback still covers that case.
 */
export async function readHostCodexModelCatalog(homeDir: string = codexHomeDir()): Promise<AdapterModel[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(homeDir, "models_cache.json"), "utf8"));
  } catch {
    return [];
  }
  const entries = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models)
    ? ((parsed as { models: unknown[] }).models)
    : [];
  const listed: Array<{ id: string; label: string; priority: number }> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown };
    if (typeof record.slug !== "string" || record.slug.trim().length === 0) continue;
    if (record.visibility !== "list") continue;
    listed.push({
      id: record.slug.trim(),
      label: typeof record.display_name === "string" && record.display_name.trim() ? record.display_name.trim() : record.slug.trim(),
      priority: typeof record.priority === "number" && Number.isFinite(record.priority) ? record.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  listed.sort((a, b) => a.priority - b.priority);
  return dedupeModels(listed.map(({ id, label }) => ({ id, label })));
}

async function loadCodexModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const apiKey = resolveOpenAiApiKey();
  // The host CLI's catalog leads, in Codex's order; the static list fills in
  // anything the catalog does not mention.
  const fallback = dedupeModels([...(await readHostCodexModelCatalog()), ...codexFallbackModels]);
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback([...fetched, ...fallback]);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}
