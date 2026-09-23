import { describe, expect, it, vi } from "vitest";
import { listGatewayModels, mergeGatewayModels, parseGatewayModels } from "./ai-gateway-models.js";

describe("parseGatewayModels", () => {
  it("reads OpenAI-style and Anthropic-style lists", () => {
    expect(parseGatewayModels({ data: [{ id: "claude-opus-5-5" }, { id: "qwen-3", display_name: "Qwen 3" }] }))
      .toEqual([{ id: "claude-opus-5-5", label: "claude-opus-5-5" }, { id: "qwen-3", label: "Qwen 3" }]);
    expect(parseGatewayModels({ models: ["gemma-3"] })).toEqual([{ id: "gemma-3", label: "gemma-3" }]);
    expect(parseGatewayModels({ nope: true })).toEqual([]);
  });
});

describe("listGatewayModels", () => {
  it("queries <baseUrl>/v1/models with both auth header forms and caches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }));
    const source = { connectionId: "c-" + Math.random(), baseUrl: "https://gw.example.com/", apiKey: "k" };
    expect(await listGatewayModels(source, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([{ id: "m1", label: "m1" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    await listGatewayModels(source, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("returns an empty list on a gateway error instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await listGatewayModels({ connectionId: "c-err", baseUrl: "https://gw", apiKey: "k" }, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });
});

describe("mergeGatewayModels", () => {
  it("puts gateway models first and drops duplicates", () => {
    expect(mergeGatewayModels([{ id: "a", label: "A" }], [{ id: "a", label: "A2" }, { id: "b", label: "B" }]))
      .toEqual([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
  });
});
