import { readImageAsBase64 } from "../util/images.js";
import {
  classifyCompatFailure,
  type CompatibilitySnapshot,
} from "./compat.js";
import type {
  ContentBlock,
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderError,
  StopReason,
  ToolSpec,
  Usage,
} from "./types.js";

/**
 * Anthropic provider — native Messages API over plain fetch/SSE.
 *
 * We intentionally own the wire logic here so proxy compatibility is under our
 * control. That lets the compat layer probe exact URLs, classify empty streams,
 * and adapt to endpoints that accept `/v1/messages` but behave differently from
 * the official SDK expectations.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly chatURL: string;
  private readonly compat?: CompatibilitySnapshot;

  constructor(opts: {
    apiKey: string;
    model: string;
    baseURL?: string;
    chatURL?: string;
    compat?: CompatibilitySnapshot;
  }) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.chatURL = opts.chatURL ?? `${this.baseURL}/v1/messages`;
    this.compat = opts.compat;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    const effectiveTools =
      this.compat?.supportsTools === false ? [] : req.tools;
    const effectiveThinking =
      this.compat?.supportsReasoning === false ? "off" : req.thinking;
    const budget = thinkingBudget(effectiveThinking);
    const baseMax = req.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: this.model,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      max_tokens: budget > 0 ? budget + baseMax : baseMax,
      stream: true,
    };
    if (effectiveTools.length > 0) {
      body.tools = toAnthropicTools(effectiveTools);
    }
    if (budget > 0) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    let resp: Response;
    try {
      resp = await fetch(this.chatURL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
      return;
    }

    if (!resp.ok || !resp.body) {
      const text = await safeText(resp);
      yield { type: "error", error: errorFromStatus(resp.status, text) };
      return;
    }

    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const text = await safeText(resp);
      yield {
        type: "error",
        error: {
          message:
            `Expected an Anthropic-compatible streaming response from ${this.chatURL}, ` +
            `but received ${contentType || "an unknown content type"} instead. ` +
            summarizeUnexpectedBody(text),
          retryable: false,
          kind: classifyCompatFailure(contentType || text),
          ...(resp.status ? { status: resp.status } : {}),
        },
      };
      return;
    }

    const idByIndex = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead: number | undefined;
    let cacheWrite: number | undefined;
    let stopReason: StopReason = "unknown";
    let sawEvent = false;

    try {
      for await (const event of sseEvents(resp.body)) {
        sawEvent = true;
        if (event.data === "[DONE]") break;
        let parsed: AnthropicStreamEvent;
        try {
          parsed = JSON.parse(event.data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        switch (parsed.type) {
          case "message_start": {
            const usage = parsed.message?.usage;
            inputTokens = usage?.input_tokens ?? inputTokens;
            cacheRead = usage?.cache_read_input_tokens ?? undefined;
            cacheWrite = usage?.cache_creation_input_tokens ?? undefined;
            break;
          }
          case "content_block_start": {
            const block = parsed.content_block;
            if (block?.type === "tool_use" && typeof parsed.index === "number") {
              idByIndex.set(parsed.index, block.id);
              yield {
                type: "tool_use_start",
                id: block.id,
                name: block.name,
              };
            }
            break;
          }
          case "content_block_delta": {
            const delta = parsed.delta;
            if (!delta) break;
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const id =
                typeof parsed.index === "number" ? idByIndex.get(parsed.index) : undefined;
              if (id) {
                yield { type: "tool_input_delta", id, partialJson: delta.partial_json };
              }
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yield { type: "reasoning_delta", text: delta.thinking };
            }
            break;
          }
          case "content_block_stop": {
            const id =
              typeof parsed.index === "number" ? idByIndex.get(parsed.index) : undefined;
            if (id) yield { type: "tool_use_stop", id };
            break;
          }
          case "message_delta": {
            outputTokens = parsed.usage?.output_tokens ?? outputTokens;
            stopReason = mapStopReason(parsed.delta?.stop_reason ?? null);
            break;
          }
          case "message_stop": {
            const usage: Usage = {
              inputTokens,
              outputTokens,
              ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
              ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
            };
            yield { type: "message_stop", stopReason, usage };
            break;
          }
          case "error": {
            const message = parsed.error?.message ?? "Anthropic-compatible stream error";
            yield {
              type: "error",
              error: {
                message,
                retryable: false,
                kind: classifyCompatFailure(message),
              },
            };
            return;
          }
          default:
            break;
        }
      }
      if (!sawEvent) {
        yield {
          type: "error",
          error: {
            message:
              `The Anthropic-compatible endpoint returned an empty streaming body for model "${this.model}".`,
            retryable: false,
            kind: "empty_stream",
          },
        };
      }
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
    }
  }
}

interface AnthropicMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    usage?: AnthropicMessageUsage;
  };
  usage?: {
    output_tokens?: number;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  };
  content_block?: {
    type?: string;
    id: string;
    name: string;
  };
  error?: {
    message?: string;
    type?: string;
  };
}

function thinkingBudget(depth: ModelRequest["thinking"]): number {
  switch (depth) {
    case "low":
      return 4096;
    case "medium":
      return 12288;
    case "high":
      return 24576;
    default:
      return 0;
  }
}

function toAnthropicMessages(messages: Message[]): Array<{
  role: Message["role"];
  content: Array<Record<string, unknown>>;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: readImageAsBase64(block.path),
        },
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

function toAnthropicTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function mapStopReason(
  reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null,
): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "unknown";
  }
}

function errorFromStatus(status: number, detail: string): ProviderError {
  const message = `Anthropic-compatible API error ${status}${detail ? ` ${detail}` : ""}`.trim();
  const retryable = status === 429 || status >= 500;
  return {
    message,
    retryable,
    ...(status ? { status } : {}),
    kind: classifyCompatFailure(message, status),
  };
}

function normalizeError(err: unknown): ProviderError {
  if (err instanceof Error) {
    const text = err.message;
    const kind = classifyCompatFailure(text);
    return {
      message: text,
      retryable: /timed out|timeout|fetch failed|econn|socket|503|502|429/i.test(text),
      kind,
    };
  }
  return { message: String(err), retryable: false, kind: "unknown" };
}

function summarizeUnexpectedBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "The body was empty.";
  if (/<!doctype html>|<html[\s>]/i.test(trimmed)) {
    return "The server returned HTML, which usually means this URL points at a website page instead of a real Anthropic-compatible API endpoint.";
  }
  return `Response preview: ${trimmed.slice(0, 180)}`;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (rawLine === "") {
        if (dataLines.length > 0) {
          yield { ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") };
        }
        eventName = undefined;
        dataLines = [];
        continue;
      }
      if (rawLine.startsWith("event:")) {
        eventName = rawLine.slice(6).trim();
      } else if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      const normalized = line.replace(/\r$/, "");
      if (normalized.startsWith("event:")) {
        eventName = normalized.slice(6).trim();
      } else if (normalized.startsWith("data:")) {
        dataLines.push(normalized.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) {
    yield { ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") };
  }
}
