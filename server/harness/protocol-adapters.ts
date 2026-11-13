// Protocol-Level Tool Calling, Streaming & Schema Validation Adapters for Apex Harness.
// Implements explicit protocol adapters for:
// 1. OpenAiChatProtocolAdapter (`choices[].message.tool_calls` & SSE delta accumulation)
// 2. OpenAiResponsesProtocolAdapter (`output[]` `function_call` & `function_call_output`)
// 3. AnthropicMessagesProtocolAdapter (`content[]` `tool_use` & SSE `content_block_start`/`input_json_delta`/`content_block_stop`)
// 4. GeminiProtocolAdapter (`candidates[].content.parts[].functionCall` & `functionResponse`)
// 5. NativeCliJsonlProtocolAdapter (structured JSONL event streams from CLI harnesses)
// 6. ApexActionBlockAdapter (fenced ```apex-action JSON + XML fallback for text-only gateways)

import { randomUUID } from "node:crypto";

export type ProtocolFinishReason = "stop" | "tool_calls" | "length" | "refusal" | "error";

export interface NormalizedProtocolToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArgumentsJson: string;
  protocol:
    | "openai-chat"
    | "openai-responses"
    | "anthropic-messages"
    | "gemini"
    | "cli-jsonl"
    | "apex-action";
}

export interface IncompleteProtocolToolCall {
  id: string;
  name: string;
  rawPartialJson: string;
  reason: string;
}

export interface NormalizedProtocolTurn {
  visibleText: string;
  reasoningText: string;
  toolCalls: NormalizedProtocolToolCall[];
  incompleteToolCalls: IncompleteProtocolToolCall[];
  hasIncompleteToolCall: boolean;
  finishReason: ProtocolFinishReason;
  rawUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ToolSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const KNOWN_TOOL_REQUIRED_FIELDS: Record<string, string[]> = {
  read_file: ["path"],
  list_dir: ["path"],
  grep_search: ["query"],
  edit_file: ["path", "target", "replacement"],
  write_file: ["path", "content"],
  run_command: ["command"],
  todo_write: ["todos"],
  call_mcp_tool: ["serverName", "toolName"],
  read_spill: ["spillId"],
  delegate_subagent: ["role", "task"],
};

/**
 * Separates `<think>...</think>` blocks from user-visible text.
 */
export function splitReasoningAndVisibleText(rawText: string): {
  visibleText: string;
  reasoningText: string;
} {
  const reasoningParts: string[] = [];
  let visible = rawText.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    if (inner?.trim()) reasoningParts.push(inner.trim());
    return "";
  });
  // Handle unclosed <think> tags safely
  const unclosedIdx = visible.toLowerCase().indexOf("<think>");
  if (unclosedIdx !== -1) {
    const tail = visible.slice(unclosedIdx + "<think>".length).trim();
    if (tail) reasoningParts.push(tail);
    visible = visible.slice(0, unclosedIdx);
  }
  return {
    visibleText: visible.trim(),
    reasoningText: reasoningParts.join("\n\n").trim(),
  };
}

/**
 * Validates a normalized tool call's arguments against the required schema for that tool.
 */
export function validateToolCallSchema(
  call: Pick<NormalizedProtocolToolCall, "name" | "arguments">,
): ToolSchemaValidationResult {
  const errors: string[] = [];
  if (!call.name || typeof call.name !== "string") {
    errors.push("Tool name must be a non-empty string.");
    return { valid: false, errors };
  }
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
    errors.push(`Tool '${call.name}' arguments must be a JSON object.`);
    return { valid: false, errors };
  }

  const requiredFields = KNOWN_TOOL_REQUIRED_FIELDS[call.name];
  if (requiredFields) {
    for (const field of requiredFields) {
      const val = call.arguments[field];
      if (val === undefined || val === null || (typeof val === "string" && val.length === 0 && field !== "replacement" && field !== "content")) {
        errors.push(`Tool '${call.name}' is missing required field '${field}'.`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Deduplicates tool calls by `id` (or by `name + canonical JSON` if the same ID is repeated).
 */
export function deduplicateProtocolToolCalls(
  calls: NormalizedProtocolToolCall[],
): NormalizedProtocolToolCall[] {
  const seenIds = new Set<string>();
  const result: NormalizedProtocolToolCall[] = [];
  for (const call of calls) {
    const key = call.id || `${call.name}:${call.rawArgumentsJson}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    result.push(call);
  }
  return result;
}

/**
 * 1. OpenAI Chat Completions Protocol Adapter (`/v1/chat/completions` JSON & SSE deltas).
 */
export class OpenAiChatProtocolAdapter {
  static parseResponse(payload: Record<string, unknown>): NormalizedProtocolTurn {
    const choices = Array.isArray(payload.choices)
      ? (payload.choices as Array<Record<string, unknown>>)
      : [];
    const first = choices[0] ?? {};
    const msg = (first.message as Record<string, unknown>) ?? {};
    const rawContent = typeof msg.content === "string" ? msg.content : "";
    const reasoningField =
      typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const split = splitReasoningAndVisibleText(rawContent);

    const toolCalls: NormalizedProtocolToolCall[] = [];
    const incompleteToolCalls: IncompleteProtocolToolCall[] = [];

    const rawToolCalls = Array.isArray(msg.tool_calls)
      ? (msg.tool_calls as Array<Record<string, unknown>>)
      : [];

    for (const tc of rawToolCalls) {
      const id = typeof tc.id === "string" && tc.id ? tc.id : `call_${randomUUID().slice(0, 8)}`;
      const fn = (tc.function as Record<string, unknown>) ?? {};
      const name = typeof fn.name === "string" ? fn.name : "";
      const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "{}";
      try {
        const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
        if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
          incompleteToolCalls.push({
            id,
            name,
            rawPartialJson: rawArgs,
            reason: "Tool arguments did not parse to a JSON object.",
          });
          continue;
        }
        toolCalls.push({
          id,
          name,
          arguments: parsedArgs,
          rawArgumentsJson: rawArgs,
          protocol: "openai-chat",
        });
      } catch (err) {
        incompleteToolCalls.push({
          id,
          name,
          rawPartialJson: rawArgs,
          reason: `Malformed/incomplete JSON arguments: ${(err as Error).message}`,
        });
      }
    }

    const rawFinish = String(first.finish_reason ?? "stop");
    let finishReason: ProtocolFinishReason = "stop";
    if (rawFinish === "tool_calls" || toolCalls.length > 0) finishReason = "tool_calls";
    else if (rawFinish === "length" || rawFinish === "max_tokens") finishReason = "length";
    else if (rawFinish === "content_filter") finishReason = "refusal";

    const usage = payload.usage as Record<string, unknown> | undefined;

    return {
      visibleText: split.visibleText,
      reasoningText: [reasoningField, split.reasoningText].filter(Boolean).join("\n\n"),
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls,
      hasIncompleteToolCall: incompleteToolCalls.length > 0,
      finishReason,
      rawUsage: usage
        ? {
            inputTokens: Number(usage.prompt_tokens ?? 0),
            outputTokens: Number(usage.completion_tokens ?? 0),
          }
        : undefined,
    };
  }

  /**
   * Reconstructs a full OpenAI Chat Completions turn from SSE `data:` chunks.
   */
  static parseSseStream(sseChunks: string[]): NormalizedProtocolTurn {
    let contentBuf = "";
    let reasoningBuf = "";
    let rawFinish = "stop";
    const toolOrder: number[] = [];
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for (const rawLine of sseChunks) {
      const lines = rawLine.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const obj = JSON.parse(dataStr) as Record<string, unknown>;
          const choices = Array.isArray(obj.choices)
            ? (obj.choices as Array<Record<string, unknown>>)
            : [];
          const choice = choices[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string" && choice.finish_reason) {
            rawFinish = choice.finish_reason;
          }
          const delta = (choice.delta as Record<string, unknown>) ?? {};
          if (typeof delta.content === "string") contentBuf += delta.content;
          if (typeof delta.reasoning_content === "string") reasoningBuf += delta.reasoning_content;

          const tcDeltas = Array.isArray(delta.tool_calls)
            ? (delta.tool_calls as Array<Record<string, unknown>>)
            : [];
          for (const tcd of tcDeltas) {
            const idx = typeof tcd.index === "number" ? tcd.index : 0;
            if (!toolAcc.has(idx)) {
              toolOrder.push(idx);
              toolAcc.set(idx, {
                id: typeof tcd.id === "string" ? tcd.id : `call_${idx}`,
                name: "",
                args: "",
              });
            }
            const entry = toolAcc.get(idx)!;
            if (typeof tcd.id === "string" && tcd.id) entry.id = tcd.id;
            const fn = (tcd.function as Record<string, unknown>) ?? {};
            if (typeof fn.name === "string") entry.name += fn.name;
            if (typeof fn.arguments === "string") entry.args += fn.arguments;
          }
        } catch {
          // Ignore malformed keepalive comments
        }
      }
    }

    const reconstructedToolCalls = toolOrder.map((idx) => {
      const item = toolAcc.get(idx)!;
      return {
        id: item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.args,
        },
      };
    });

    return OpenAiChatProtocolAdapter.parseResponse({
      choices: [
        {
          finish_reason: rawFinish,
          message: {
            content: contentBuf,
            reasoning_content: reasoningBuf,
            tool_calls: reconstructedToolCalls,
          },
        },
      ],
    });
  }

  static serializeToolResult(toolCallId: string, output: string): Record<string, unknown> {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: output,
    };
  }
}

/**
 * 2. OpenAI Responses API Protocol Adapter (`/v1/responses` used by Codex / GPT-5.4).
 */
export class OpenAiResponsesProtocolAdapter {
  static parseResponse(payload: Record<string, unknown>): NormalizedProtocolTurn {
    const outputs = Array.isArray(payload.output)
      ? (payload.output as Array<Record<string, unknown>>)
      : [];
    const textSegments: string[] = [];
    const reasoningSegments: string[] = [];
    const toolCalls: NormalizedProtocolToolCall[] = [];
    const incompleteToolCalls: IncompleteProtocolToolCall[] = [];

    if (typeof payload.output_text === "string" && payload.output_text.trim()) {
      textSegments.push(payload.output_text.trim());
    }

    for (const item of outputs) {
      const type = String(item.type ?? "");
      if (type === "message") {
        const contentArr = Array.isArray(item.content)
          ? (item.content as Array<Record<string, unknown>>)
          : [];
        for (const part of contentArr) {
          if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
            if (!textSegments.includes(part.text.trim())) {
              textSegments.push(part.text.trim());
            }
          } else if (part.type === "refusal" && typeof part.refusal === "string") {
            return {
              visibleText: part.refusal,
              reasoningText: reasoningSegments.join("\n\n"),
              toolCalls: [],
              incompleteToolCalls: [],
              hasIncompleteToolCall: false,
              finishReason: "refusal",
            };
          }
        }
      } else if (type === "reasoning") {
        const summaryArr = Array.isArray(item.summary)
          ? (item.summary as Array<Record<string, unknown>>)
          : [];
        for (const s of summaryArr) {
          if (typeof s.text === "string") reasoningSegments.push(s.text);
        }
      } else if (type === "function_call") {
        const id =
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : `call_${randomUUID().slice(0, 8)}`;
        const name = typeof item.name === "string" ? item.name : "";
        const rawArgs = typeof item.arguments === "string" ? item.arguments : "{}";
        try {
          const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          toolCalls.push({
            id,
            name,
            arguments: parsedArgs,
            rawArgumentsJson: rawArgs,
            protocol: "openai-responses",
          });
        } catch (err) {
          incompleteToolCalls.push({
            id,
            name,
            rawPartialJson: rawArgs,
            reason: `Invalid Responses function_call arguments JSON: ${(err as Error).message}`,
          });
        }
      }
    }

    const finishReason: ProtocolFinishReason =
      toolCalls.length > 0
        ? "tool_calls"
        : payload.status === "incomplete"
          ? "length"
          : "stop";

    return {
      visibleText: textSegments.join("\n\n").trim(),
      reasoningText: reasoningSegments.join("\n\n").trim(),
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls,
      hasIncompleteToolCall: incompleteToolCalls.length > 0,
      finishReason,
    };
  }

  static serializeToolResult(callId: string, output: string): Record<string, unknown> {
    return {
      type: "function_call_output",
      call_id: callId,
      output,
    };
  }
}

/**
 * 3. Anthropic Messages API Protocol Adapter (`/v1/messages` JSON & SSE delta reconstruction).
 */
export class AnthropicMessagesProtocolAdapter {
  static parseResponse(payload: Record<string, unknown>): NormalizedProtocolTurn {
    const contentBlocks = Array.isArray(payload.content)
      ? (payload.content as Array<Record<string, unknown>>)
      : [];
    const visibleParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: NormalizedProtocolToolCall[] = [];
    const incompleteToolCalls: IncompleteProtocolToolCall[] = [];

    for (const block of contentBlocks) {
      const bType = String(block.type ?? "");
      if (bType === "text" && typeof block.text === "string") {
        const split = splitReasoningAndVisibleText(block.text);
        if (split.visibleText) visibleParts.push(split.visibleText);
        if (split.reasoningText) reasoningParts.push(split.reasoningText);
      } else if (bType === "thinking" && typeof block.thinking === "string") {
        reasoningParts.push(block.thinking.trim());
      } else if (bType === "tool_use") {
        const id =
          typeof block.id === "string" && block.id
            ? block.id
            : `toolu_${randomUUID().slice(0, 8)}`;
        const name = typeof block.name === "string" ? block.name : "";
        if (typeof block.partial_json === "string") {
          try {
            const parsed = JSON.parse(block.partial_json) as Record<string, unknown>;
            toolCalls.push({
              id,
              name,
              arguments: parsed,
              rawArgumentsJson: block.partial_json,
              protocol: "anthropic-messages",
            });
          } catch (err) {
            incompleteToolCalls.push({
              id,
              name,
              rawPartialJson: block.partial_json,
              reason: `Incomplete Anthropic input_json_delta: ${(err as Error).message}`,
            });
          }
        } else if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) {
          const rawJson = JSON.stringify(block.input);
          toolCalls.push({
            id,
            name,
            arguments: block.input as Record<string, unknown>,
            rawArgumentsJson: rawJson,
            protocol: "anthropic-messages",
          });
        } else {
          incompleteToolCalls.push({
            id,
            name,
            rawPartialJson: String(block.input ?? ""),
            reason: "Anthropic tool_use block missing valid object input.",
          });
        }
      }
    }

    const stopReason = String(payload.stop_reason ?? "end_turn");
    let finishReason: ProtocolFinishReason = "stop";
    if (stopReason === "tool_use" || toolCalls.length > 0) finishReason = "tool_calls";
    else if (stopReason === "max_tokens") finishReason = "length";
    else if (stopReason === "refusal") finishReason = "refusal";

    const usage = payload.usage as Record<string, unknown> | undefined;

    return {
      visibleText: visibleParts.join("\n\n").trim(),
      reasoningText: reasoningParts.join("\n\n").trim(),
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls,
      hasIncompleteToolCall: incompleteToolCalls.length > 0,
      finishReason,
      rawUsage: usage
        ? {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  /**
   * Reconstructs an Anthropic `/v1/messages` turn from SSE events (`content_block_start`,
   * `content_block_delta` with `text_delta` / `thinking_delta` / `input_json_delta`,
   * `content_block_stop`, `message_delta`).
   */
  static parseSseStream(sseChunks: string[]): NormalizedProtocolTurn {
    const blocks = new Map<
      number,
      {
        type: string;
        id?: string;
        name?: string;
        textBuf: string;
        thinkingBuf: string;
        jsonBuf: string;
        stopped: boolean;
      }
    >();
    let stopReason = "end_turn";

    for (const chunk of sseChunks) {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const ev = JSON.parse(dataStr) as Record<string, unknown>;
          const evType = String(ev.type ?? "");
          if (evType === "content_block_start") {
            const idx = Number(ev.index ?? 0);
            const cb = (ev.content_block as Record<string, unknown>) ?? {};
            blocks.set(idx, {
              type: String(cb.type ?? "text"),
              id: typeof cb.id === "string" ? cb.id : undefined,
              name: typeof cb.name === "string" ? cb.name : undefined,
              textBuf: typeof cb.text === "string" ? cb.text : "",
              thinkingBuf: typeof cb.thinking === "string" ? cb.thinking : "",
              jsonBuf: "",
              stopped: false,
            });
          } else if (evType === "content_block_delta") {
            const idx = Number(ev.index ?? 0);
            const delta = (ev.delta as Record<string, unknown>) ?? {};
            const entry = blocks.get(idx);
            if (!entry) continue;
            const dType = String(delta.type ?? "");
            if (dType === "text_delta" && typeof delta.text === "string") {
              entry.textBuf += delta.text;
            } else if (dType === "thinking_delta" && typeof delta.thinking === "string") {
              entry.thinkingBuf += delta.thinking;
            } else if (dType === "input_json_delta" && typeof delta.partial_json === "string") {
              entry.jsonBuf += delta.partial_json;
            }
          } else if (evType === "content_block_stop") {
            const idx = Number(ev.index ?? 0);
            const entry = blocks.get(idx);
            if (entry) entry.stopped = true;
          } else if (evType === "message_delta") {
            const delta = (ev.delta as Record<string, unknown>) ?? {};
            if (typeof delta.stop_reason === "string" && delta.stop_reason) {
              stopReason = delta.stop_reason;
            }
          }
        } catch {
          // Ignore comments
        }
      }
    }

    const content: Array<Record<string, unknown>> = [];
    for (const [, blk] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (blk.type === "text") {
        content.push({ type: "text", text: blk.textBuf });
      } else if (blk.type === "thinking") {
        content.push({ type: "thinking", thinking: blk.thinkingBuf });
      } else if (blk.type === "tool_use") {
        // If stream aborted before content_block_stop or JSON is incomplete, parseResponse will flag it
        content.push({
          type: "tool_use",
          id: blk.id,
          name: blk.name,
          partial_json: blk.stopped ? blk.jsonBuf || "{}" : blk.jsonBuf || "{unterminated",
        });
      }
    }

    return AnthropicMessagesProtocolAdapter.parseResponse({
      stop_reason: stopReason,
      content,
    });
  }

  static serializeToolResult(
    toolUseId: string,
    output: string,
    isError = false,
  ): Record<string, unknown> {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: output,
          is_error: isError,
        },
      ],
    };
  }
}

/**
 * 4. Google Gemini Protocol Adapter (`generateContent` / `streamGenerateContent`).
 */
export class GeminiProtocolAdapter {
  static parseResponse(payload: Record<string, unknown>): NormalizedProtocolTurn {
    const candidates = Array.isArray(payload.candidates)
      ? (payload.candidates as Array<Record<string, unknown>>)
      : [];
    const first = candidates[0] ?? {};
    const content = (first.content as Record<string, unknown>) ?? {};
    const parts = Array.isArray(content.parts)
      ? (content.parts as Array<Record<string, unknown>>)
      : [];

    const visibleParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: NormalizedProtocolToolCall[] = [];

    for (const part of parts) {
      if (part.thought === true && typeof part.text === "string") {
        reasoningParts.push(part.text.trim());
      } else if (typeof part.text === "string") {
        const split = splitReasoningAndVisibleText(part.text);
        if (split.visibleText) visibleParts.push(split.visibleText);
        if (split.reasoningText) reasoningParts.push(split.reasoningText);
      } else if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as Record<string, unknown>;
        const id =
          typeof fc.id === "string" && fc.id
            ? fc.id
            : `gemini_call_${randomUUID().slice(0, 8)}`;
        const name = typeof fc.name === "string" ? fc.name : "";
        const argsObj =
          fc.args && typeof fc.args === "object" && !Array.isArray(fc.args)
            ? (fc.args as Record<string, unknown>)
            : {};
        toolCalls.push({
          id,
          name,
          arguments: argsObj,
          rawArgumentsJson: JSON.stringify(argsObj),
          protocol: "gemini",
        });
      }
    }

    const rawReason = String(first.finishReason ?? "STOP").toUpperCase();
    let finishReason: ProtocolFinishReason = "stop";
    if (toolCalls.length > 0) finishReason = "tool_calls";
    else if (rawReason === "MAX_TOKENS") finishReason = "length";
    else if (rawReason === "SAFETY" || rawReason === "RECITATION" || rawReason === "BLOCKLIST") {
      finishReason = "refusal";
    }

    return {
      visibleText: visibleParts.join("\n\n").trim(),
      reasoningText: reasoningParts.join("\n\n").trim(),
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls: [],
      hasIncompleteToolCall: false,
      finishReason,
    };
  }

  static serializeToolResult(
    toolName: string,
    responseObj: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: toolName,
            response: responseObj,
          },
        },
      ],
    };
  }
}

/**
 * 5. Native CLI JSONL Protocol Adapter (for `claude --output-format stream-json`, `codex`, `gemini`, `opencode`).
 */
export class NativeCliJsonlProtocolAdapter {
  static parseJsonlLines(lines: string[]): NormalizedProtocolTurn {
    const visibleParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: NormalizedProtocolToolCall[] = [];
    const incompleteToolCalls: IncompleteProtocolToolCall[] = [];
    let finishReason: ProtocolFinishReason = "stop";

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) {
        visibleParts.push(trimmed);
        continue;
      }
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const type = String(obj.type ?? "");
        if (type === "assistant" && obj.message && typeof obj.message === "object") {
          const parsedAnthropic = AnthropicMessagesProtocolAdapter.parseResponse(
            obj.message as Record<string, unknown>,
          );
          if (parsedAnthropic.visibleText) visibleParts.push(parsedAnthropic.visibleText);
          if (parsedAnthropic.reasoningText) reasoningParts.push(parsedAnthropic.reasoningText);
          toolCalls.push(...parsedAnthropic.toolCalls);
          incompleteToolCalls.push(...parsedAnthropic.incompleteToolCalls);
        } else if (type === "result" && typeof obj.result === "string") {
          if (!visibleParts.includes(obj.result.trim())) {
            visibleParts.push(obj.result.trim());
          }
        } else if (type === "item.completed" && obj.item && typeof obj.item === "object") {
          const item = obj.item as Record<string, unknown>;
          if (typeof item.text === "string") visibleParts.push(item.text.trim());
        } else if (typeof obj.text === "string") {
          visibleParts.push(obj.text.trim());
        }
      } catch {
        visibleParts.push(trimmed);
      }
    }

    if (toolCalls.length > 0) finishReason = "tool_calls";
    return {
      visibleText: visibleParts.join("\n\n").trim(),
      reasoningText: reasoningParts.join("\n\n").trim(),
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls,
      hasIncompleteToolCall: incompleteToolCalls.length > 0,
      finishReason,
    };
  }
}

/**
 * 6. Apex Action Block Protocol Adapter (parses fenced ```apex-action blocks and detects truncated blocks).
 */
export class ApexActionBlockAdapter {
  static parseText(rawText: string): NormalizedProtocolTurn {
    const split = splitReasoningAndVisibleText(rawText);
    const toolCalls: NormalizedProtocolToolCall[] = [];
    const incompleteToolCalls: IncompleteProtocolToolCall[] = [];

    // Detect complete ```apex-action ... ``` blocks
    const blockRegex = /```apex-action\r?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(split.visibleText)) !== null) {
      const body = (match[1] ?? "").trim();
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const toolName = String(parsed.tool ?? parsed.name ?? "");
        const id =
          typeof parsed.id === "string" && parsed.id
            ? parsed.id
            : `apex_act_${randomUUID().slice(0, 8)}`;
        const argsCopy = { ...parsed };
        delete argsCopy.tool;
        toolCalls.push({
          id,
          name: toolName,
          arguments: argsCopy,
          rawArgumentsJson: JSON.stringify(argsCopy),
          protocol: "apex-action",
        });
      } catch (err) {
        incompleteToolCalls.push({
          id: `incomplete_${randomUUID().slice(0, 6)}`,
          name: "unknown",
          rawPartialJson: body,
          reason: `Malformed JSON inside apex-action block: ${(err as Error).message}`,
        });
      }
    }

    // Check for an unclosed ```apex-action fence at the end of the response
    const openCount = (split.visibleText.match(/```apex-action/g) ?? []).length;
    if (openCount > toolCalls.length + incompleteToolCalls.length) {
      const lastOpen = split.visibleText.lastIndexOf("```apex-action");
      const tail = split.visibleText.slice(lastOpen + "```apex-action".length).trim();
      incompleteToolCalls.push({
        id: `unclosed_${randomUUID().slice(0, 6)}`,
        name: "unclosed_block",
        rawPartialJson: tail,
        reason: "Unclosed ```apex-action fence (truncated stream).",
      });
    }

    const cleanedVisible = split.visibleText
      .replace(/```apex-action\r?\n[\s\S]*?```/g, "")
      .replace(/```apex-action[\s\S]*$/g, "")
      .trim();

    return {
      visibleText: cleanedVisible,
      reasoningText: split.reasoningText,
      toolCalls: deduplicateProtocolToolCalls(toolCalls),
      incompleteToolCalls,
      hasIncompleteToolCall: incompleteToolCalls.length > 0,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }
}

/**
 * Converts normalized protocol tool calls into executable ` ```apex-action ` blocks
 * so structured provider tool calls (`tool_calls`, `tool_use`, `functionCall`) flow seamlessly
 * through `executeAgentToolBlocksAsync()` while preserving `toolCallId` and schema validation.
 */
export function renderProtocolToolCallsAsApexActionBlocks(
  calls: NormalizedProtocolToolCall[],
): {
  actionBlocksText: string;
  validCalls: NormalizedProtocolToolCall[];
  invalidCalls: Array<{ call: NormalizedProtocolToolCall; errors: string[] }>;
} {
  const validCalls: NormalizedProtocolToolCall[] = [];
  const invalidCalls: Array<{ call: NormalizedProtocolToolCall; errors: string[] }> = [];
  const blocks: string[] = [];

  for (const call of deduplicateProtocolToolCalls(calls)) {
    const check = validateToolCallSchema(call);
    if (!check.valid) {
      invalidCalls.push({ call, errors: check.errors });
      continue;
    }
    validCalls.push(call);
    blocks.push(
      [
        "```apex-action",
        JSON.stringify({
          id: call.id,
          tool: call.name,
          ...call.arguments,
        }),
        "```",
      ].join("\n"),
    );
  }

  return {
    actionBlocksText: blocks.join("\n\n"),
    validCalls,
    invalidCalls,
  };
}
