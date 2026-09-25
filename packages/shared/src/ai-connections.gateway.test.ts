import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_CAPABILITIES,
  createAiConnectionSchema,
  gatewayModelsForAdapter,
  isAiConnectionCompatible,
  stripGatewayModelPrefix,
} from "./ai-connections.js";

describe("custom gateway provider", () => {
  const binding = { provider: "gateway", method: "api_key", mode: "responsible_user" } as const;

  it("is compatible with the harnesses it lists, and only with models each can run", () => {
    expect(AI_CONNECTION_CAPABILITIES.gateway.methods.api_key?.adapters).toEqual(["claude_local", "codex_local", "opencode_local", "pi_local"]);
    expect(isAiConnectionCompatible(binding, "grok_local")).toBe(false);
    expect(isAiConnectionCompatible(binding, "codex_local", "kimi-k2.5")).toBe(true);
    expect(isAiConnectionCompatible(binding, "claude_local", "claude-sonnet-5")).toBe(true);
    expect(isAiConnectionCompatible(binding, "claude_local", "kimi-k2.5")).toBe(false);
    expect(isAiConnectionCompatible(binding, "claude_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "opencode_local", "gateway/kimi-k2.5")).toBe(true);
    expect(isAiConnectionCompatible(binding, "opencode_local", "kimi-k2.5")).toBe(false);
    expect(isAiConnectionCompatible(binding, "pi_local", "gateway/qwen3-coder")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "gateway/qwen3-coder", "opencode")).toBe(true);
  });

  it("presents gateway models in the id form each harness expects", () => {
    const models = [{ id: "kimi-k2.5", label: "Kimi" }, { id: "claude-sonnet-5", label: "Sonnet" }];
    expect(gatewayModelsForAdapter(models, "codex_local")).toEqual(models);
    expect(gatewayModelsForAdapter(models, "claude_local")).toEqual([{ id: "claude-sonnet-5", label: "Sonnet" }]);
    expect(gatewayModelsForAdapter(models, "pi_local").map((m) => m.id)).toEqual(["gateway/kimi-k2.5", "gateway/claude-sonnet-5"]);
    expect(stripGatewayModelPrefix("gateway/kimi-k2.5")).toBe("kimi-k2.5");
    expect(stripGatewayModelPrefix("kimi-k2.5")).toBe("kimi-k2.5");
  });

  it("requires a base URL when creating a gateway connection", () => {
    const base = { provider: "gateway", method: "api_key", name: "LiteLLM", ownership: "shared", apiKey: "k", agentIds: [], allAgents: true } as const;
    expect(createAiConnectionSchema.safeParse(base).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...base, baseUrl: "https://llm.example.com" }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...base, method: "subscription" }).success).toBe(false);
  });
});
