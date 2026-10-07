import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractTextContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  
  let text = "";
  let thinking = "";
  
  for (const c of content) {
    if (c.type === "text" && c.text) {
      text += c.text;
    }
    if (c.type === "thinking" && c.thinking) {
      thinking += c.thinking;
    }
  }
  
  return { text, thinking };
}

// Track pending tool calls for proper toolUseId matching
let pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();

// Per-message flags: once a delta has streamed, the block-end events for the
// same content must not re-emit it (Pi sends delta, *_end, message_end,
// turn_end and agent_end for the same text).
let streamedText = false;
let streamedThinking = false;

export function resetParserState(): void {
  streamedText = false;
  streamedThinking = false;
  pendingToolCalls.clear();
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Non-JSON line, treat as raw stdout
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(parsed.type);

  // RPC protocol messages - filter these out (internal implementation detail)
  if (type === "response" || type === "extension_ui_request" || type === "extension_ui_response" || type === "extension_error") {
    return [];
  }

  // Pure lifecycle markers with no user-visible content
  if (type === "session" || type === "agent_settled") {
    return [];
  }

  // Agent lifecycle
  if (type === "agent_start") {
    return [{ kind: "system", ts, text: "🚀 Pi agent started" }];
  }

  if (type === "agent_end") {
    // Assistant text and thinking were already emitted by message_update /
    // message_end. Emit usage only, to avoid repeating the final answer.
    const entries: TranscriptEntry[] = [];
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    const lastAssistant = [...(messages ?? [])].reverse().find((m) => m?.role === "assistant");
    const usage = asRecord(lastAssistant?.usage);
    if (usage) {
      const inputTokens = (usage.inputTokens ?? usage.input ?? 0) as number;
      const outputTokens = (usage.outputTokens ?? usage.output ?? 0) as number;
      const cachedTokens = (usage.cacheRead ?? usage.cachedInputTokens ?? 0) as number;
      const costRecord = asRecord(usage.cost);
      const costUsd = (costRecord?.total ?? usage.costUsd ?? 0) as number;
      if (inputTokens > 0 || outputTokens > 0) {
        entries.push({
          kind: "result",
          ts,
          text: "Run completed",
          inputTokens,
          outputTokens,
          cachedTokens,
          costUsd,
          subtype: "end",
          isError: false,
          errors: [],
        });
      }
    }
    if (entries.length === 0) {
      entries.push({ kind: "system", ts, text: "✅ Pi agent finished" });
    }
    return entries;
  }

  // Turn lifecycle
  if (type === "turn_start") {
    return []; // Skip noisy lifecycle events
  }

  if (type === "turn_end") {
    // Message content comes from message_update/message_end and tool results
    // from tool_execution_end. turn_end repeats both, so emit nothing.
    return [];
  }

  // Message streaming
  if (type === "message_start") {
    streamedText = false;
    streamedThinking = false;
    return [];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      
      // Handle thinking deltas
      if (msgType === "thinking_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          streamedThinking = true;
          return [{ kind: "thinking", ts, text: delta, delta: true }];
        }
      }
      
      // Handle text deltas
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          streamedText = true;
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
      }
      
      // Handle thinking end - emit full thinking block
      if (msgType === "thinking_end") {
        const content = asString(assistantEvent.content);
        if (content && !streamedThinking) {
          return [{ kind: "thinking", ts, text: content }];
        }
      }
      
      // Handle text end - emit full text block
      if (msgType === "text_end") {
        const content = asString(assistantEvent.content);
        if (content && !streamedText) {
          return [{ kind: "assistant", ts, text: content }];
        }
      }
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    // Pi emits message_end for system, user and toolResult messages too.
    // Only assistant messages belong in the transcript; tool results come
    // from tool_execution_end.
    if (message && message.role === "assistant") {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      const entries: TranscriptEntry[] = [];
      // Skip content already streamed as deltas.
      if (thinking && !streamedThinking) {
        entries.push({ kind: "thinking", ts, text: thinking });
      }
      if (text && !streamedText) {
        entries.push({ kind: "assistant", ts, text });
      }
      streamedText = false;
      streamedThinking = false;
      return entries;
    }
    return [];
  }

  // Tool execution
  if (type === "tool_execution_start") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const args = parsed.args;
    
    // Track this tool call for later matching
    pendingToolCalls.set(toolCallId, { toolName, args });
    
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: args,
      toolUseId: toolCallId,
    }];
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const result = parsed.result;
    const isError = parsed.isError === true;
    
    // Extract text from Pi's content array format
    let contentStr: string;
    if (typeof result === "string") {
      contentStr = result;
    } else if (Array.isArray(result)) {
      const extracted = extractTextContent(result as Array<{ type: string; text?: string }>);
      contentStr = extracted.text || JSON.stringify(result);
    } else if (result && typeof result === "object") {
      const resultObj = result as Record<string, unknown>;
      if (Array.isArray(resultObj.content)) {
        const extracted = extractTextContent(resultObj.content as Array<{ type: string; text?: string }>);
        contentStr = extracted.text || JSON.stringify(result);
      } else {
        contentStr = JSON.stringify(result);
      }
    } else {
      contentStr = String(result);
    }
    
    // Clean up pending call
    pendingToolCalls.delete(toolCallId);
    
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolCallId,
      toolName,
      content: contentStr,
      isError,
    }];
  }

  // Fallback for unknown event types
  return [{ kind: "stdout", ts, text: line }];
}
