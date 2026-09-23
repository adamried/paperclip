import { describe, expect, it } from "vitest";
import { describeImportedCredential } from "./local-ai-login-import.js";

describe("describeImportedCredential", () => {
  it("accepts a complete Codex auth.json", () => {
    const content = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", id_token: "i", account_id: "acct" }, last_refresh: "2026-09-01T00:00:00Z" });
    expect(describeImportedCredential("openai", content)).toEqual({ filename: "auth.json" });
  });
  it("rejects an incomplete Codex document with a specific message", () => {
    expect(() => describeImportedCredential("openai", JSON.stringify({ tokens: { access_token: "a" } }))).toThrow(/refresh_token/);
  });
  it("accepts a Claude credentials document", () => {
    expect(describeImportedCredential("anthropic", JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r" } }))).toEqual({ filename: ".credentials.json" });
  });
  it("rejects non-JSON and non-object input", () => {
    expect(() => describeImportedCredential("openai", "not json")).toThrow(/valid JSON/);
    expect(() => describeImportedCredential("openai", "[]")).toThrow(/credential document/);
  });
  it("rejects providers without a credential file", () => {
    expect(() => describeImportedCredential("openrouter", "{}")).toThrow(/does not use/);
  });
});
