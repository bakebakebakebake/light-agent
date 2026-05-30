import Anthropic from "@anthropic-ai/sdk";
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
 * Anthropic provider — a native streaming adapter. See docs/06.
 *
 * This is written by hand (rather than via a unified library) so the core
 * mechanics are visible: request assembly, consuming the SSE stream, mapping
 * Anthropic's raw events to our normalized ModelEvent, and classifying errors
 * as retryable / context-overflow.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { apiKey: string; model: string; baseURL?: string }) {
    this.model = opts.model;
    // baseURL lets us target an Anthropic-compatible proxy / 中转站 instead of
    // the official endpoint. Omitted → SDK default (api.anthropic.com).
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    // Thinking depth → an Anthropic extended-thinking block (A1). When enabled
    // the API requires max_tokens > budget_tokens, so the budget is added on top
    // of the normal output cap rather than eating into it.
    const budget = thinkingBudget(req.thinking);
    const baseMax = req.maxTokens ?? 4096;
    const body = {
      model: this.model,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      max_tokens: budget > 0 ? budget + baseMax : baseMax,
      ...(budget > 0
        ? { thinking: { type: "enabled" as const, budget_tokens: budget } }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    // Per-stream map: content-block index -> tool_use id, so input deltas and
    // the stop event can refer back to the right tool call. Must be local to
    // each call (not module-level) to avoid cross-stream contamination.
    const idByIndex = new Map<number, string>();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead: number | undefined;
    let cacheWrite: number | undefined;
    let stopReason: StopReason = "unknown";

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = this.client.messages.stream(body, { signal: req.signal });
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
      return;
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start": {
            // Cache token fields exist on the API response but are not on the
            // non-beta SDK `Usage` type in this version; read them defensively.
            const u = event.message.usage as Anthropic.Usage & {
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            };
            inputTokens = u.input_tokens ?? 0;
            cacheRead = u.cache_read_input_tokens ?? undefined;
            cacheWrite = u.cache_creation_input_tokens ?? undefined;
            break;
          }
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              idByIndex.set(event.index, block.id);
              yield {
                type: "tool_use_start",
                id: block.id,
                name: block.name,
              };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta") {
              // tool_use arguments arrive as partial JSON; the loop's
              // accumulator stitches and parses them (docs/06).
              const id = idByIndex.get(event.index);
              if (id) {
                yield {
                  type: "tool_input_delta",
                  id,
                  partialJson: delta.partial_json,
                };
              }
            } else {
              // Extended-thinking deltas (A1) aren't in this SDK version's delta
              // union, so read defensively. Surface as a reasoning delta; the
              // loop shows it but never replays it into history.
              const t = delta as { type: string; thinking?: string };
              if (t.type === "thinking_delta" && t.thinking) {
                yield { type: "reasoning_delta", text: t.thinking };
              }
            }
            break;
          }
          case "content_block_stop": {
            const id = idByIndex.get(event.index);
            if (id) yield { type: "tool_use_stop", id };
            break;
          }
          case "message_delta": {
            outputTokens = event.usage.output_tokens ?? outputTokens;
            stopReason = mapStopReason(event.delta.stop_reason);
            break;
          }
          case "message_stop": {
            const usage: Usage = {
              inputTokens,
              outputTokens,
              ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
              ...(cacheWrite !== undefined
                ? { cacheWriteTokens: cacheWrite }
                : {}),
            };
            yield { type: "message_stop", stopReason, usage };
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
    }
  }
}

/** Token budget for an extended-thinking block, by depth (A1). 0 ⇒ disabled. */
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

/** Map our Message[] to the Anthropic SDK's MessageParam[]. */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(
  block: ContentBlock,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
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

function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
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

/** Classify SDK errors into our normalized, retryable-aware shape (docs/06). */
function normalizeError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable =
      status === 429 || (status !== undefined && status >= 500);
    const contextOverflow =
      status === 400 && /context|too long|maximum/i.test(err.message);
    return {
      message: err.message,
      retryable,
      ...(contextOverflow ? { contextOverflow: true } : {}),
      ...(status !== undefined ? { status } : {}),
    };
  }
  if (err instanceof Error) {
    // Network/timeout errors are generally retryable.
    return { message: err.message, retryable: true };
  }
  return { message: String(err), retryable: false };
}
