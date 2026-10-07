import { beforeEach, describe, expect, it } from "vitest";
import { parsePiStdoutLine, resetParserState } from "./parse-stdout.js";

const ts = "2026-10-06T00:00:00.000Z";

function feed(events: Array<Record<string, unknown>>) {
  return events.flatMap((e) => parsePiStdoutLine(JSON.stringify(e), ts));
}

const usage = { input: 10, output: 5, cacheRead: 0, cost: { total: 0.01 } };

// Event order captured from a real `pi --mode json` run.
const run = [
  { type: "session", version: 3, id: "x" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "running" }] } },
  { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } },
  { type: "tool_execution_update", toolCallId: "t1", toolName: "bash" },
  { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false },
  { type: "message_start", message: { role: "toolResult" } },
  { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "hi\n" }] } },
  { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [{ toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "hi\n" }] }] },
  { type: "turn_start" },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "hmm" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Do" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ne" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", content: "Done" } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done" }] } },
  { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] }, toolResults: [] },
  { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }], usage }] },
  { type: "agent_settled" },
];

describe("parsePiStdoutLine transcript de-duplication", () => {
  beforeEach(() => resetParserState());

  it("emits each tool result exactly once", () => {
    const results = feed(run).filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId: "t1", content: "hi\n" });
  });

  it("does not emit raw stdout for lifecycle events", () => {
    expect(feed(run).filter((e) => e.kind === "stdout")).toEqual([]);
  });

  it("does not echo user or toolResult messages as assistant text", () => {
    const texts = feed(run).filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text);
    expect(texts).not.toContain("prompt");
    expect(texts).not.toContain("hi\n");
  });

  it("does not repeat streamed text or thinking at block end, message end or agent end", () => {
    const out = feed(run);
    const joined = (kind: string) =>
      out.filter((e) => e.kind === kind).map((e) => (e as { text: string }).text).join("|");
    expect(joined("thinking")).toBe("hmm");
    // "running" (non-streamed) + "Do" + "ne"; final "Done" must not repeat.
    expect(joined("assistant")).toBe("running|Do|ne");
  });

  it("still emits usage once at agent_end", () => {
    const results = feed(run).filter((e) => e.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it("keeps non-streamed assistant text from message_end", () => {
    const out = feed([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "plain" }] } },
    ]);
    expect(out).toEqual([{ kind: "assistant", ts, text: "plain" }]);
  });
});
