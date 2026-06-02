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
 * OpenAI-compatible provider — a native streaming adapter. See docs/06.
 *
 * Targets any service that speaks OpenAI's POST /v1/chat/completions with
 * SSE streaming: OpenAI, OpenRouter, DeepSeek, Moonshot/Kimi, Qwen, Zhipu,
 * SiliconFlow, local Ollama/vLLM, etc. Written with plain `fetch` (no SDK) so
 * the wire format is visible and the dependency surface stays small.
 *
 * The loop is unchanged: this maps the OpenAI chunk format onto the same
 * normalized ModelEvent stream the Anthropic adapter emits. The tricky parts
 * are (1) translating our tool_use/tool_result blocks to OpenAI's
 * assistant.tool_calls + role:"tool" messages, and (2) reassembling streamed
 * tool-call argument fragments, which arrive keyed by a choice-local index.
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly model: string;
  private apiKey: string;
  private baseURL: string;

  constructor(opts: { apiKey: string; model: string; baseURL?: string }) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    // Default to OpenAI's endpoint; most compatible providers supply their own.
    this.baseURL = (opts.baseURL ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    const wantThinking = !!req.thinking && req.thinking !== "off";
    const reasoning = isReasoningModel(this.model);
    const deepSeekThinking = deepSeekThinkingOptions(this.model, req.thinking);
    const tokenCap = req.maxTokens ?? 4096;
    // Base payload shared by all models.
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: toOpenAITools(req.tools),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (reasoning) {
      // o-series / gpt-5 reasoning models: they require `max_completion_tokens`
      // (reject `max_tokens`) and only accept the default temperature, so we
      // omit it. `reasoning_effort` (low|medium|high) tunes the depth (A1).
      body.max_completion_tokens = tokenCap;
      if (wantThinking) body.reasoning_effort = req.thinking;
    } else if (deepSeekThinking) {
      // DeepSeek v4 thinking mode uses a provider-native `thinking` block plus
      // `reasoning_effort`, even over the OpenAI-compatible endpoint.
      body.max_tokens = tokenCap;
      body.thinking = deepSeekThinking.thinking;
      if (deepSeekThinking.reasoning_effort) {
        body.reasoning_effort = deepSeekThinking.reasoning_effort;
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
    } else {
      // Non-reasoning models (gpt-4o, deepseek-chat, …) 400 on an unknown
      // `reasoning_effort` field, so we never send it here. DeepSeek's older
      // reasoner family still turns thinking on via its model id, while v4
      // models are handled in the branch above.
      body.max_tokens = tokenCap;
      if (req.temperature !== undefined) body.temperature = req.temperature;
    }

    let resp: Response;
    try {
      resp = await postJson(`${this.baseURL}/chat/completions`, this.apiKey, body, req.signal);
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
      return;
    }

    if (!resp.ok || !resp.body) {
      let text = await safeText(resp);
      if (deepSeekThinking && shouldRetryWithoutDeepSeekThinking(resp.status, text)) {
        const retryBody = { ...body };
        delete retryBody.thinking;
        delete retryBody.reasoning_effort;
        try {
          resp = await postJson(
            `${this.baseURL}/chat/completions`,
            this.apiKey,
            retryBody,
            req.signal,
          );
          if (resp.ok && resp.body) {
            text = "";
          } else {
            text = await safeText(resp);
          }
        } catch (err) {
          yield { type: "error", error: normalizeError(err) };
          return;
        }
      }
    }

    if (!resp.ok || !resp.body) {
      const text = await safeText(resp);
      yield { type: "error", error: errorFromStatus(resp.status, text) };
      return;
    }

    // Per-stream accumulator state, kept local to avoid cross-call leakage.
    const state = new StreamState();
    try {
      for await (const data of sseLines(resp.body)) {
        if (data === "[DONE]") break;
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(data) as OpenAIChunk;
        } catch {
          continue; // ignore keep-alive / non-JSON lines
        }
        for (const ev of state.consume(chunk)) yield ev;
      }
      for (const ev of state.finish()) yield ev;
    } catch (err) {
      yield { type: "error", error: normalizeError(err) };
    }
  }
}

// PLACEHOLDER_HELPERS

/**
 * True for OpenAI-style reasoning models, which take `reasoning_effort` and
 * require `max_completion_tokens` (rejecting `max_tokens` and a custom
 * `temperature`). Covers the o-series (o1, o3, o4-…) and gpt-5 reasoning tiers.
 * Non-reasoning chat models (gpt-4o, deepseek-chat, qwen, …) return false so we
 * never send them an unsupported `reasoning_effort` field (which 400s).
 *
 * DeepSeek's older reasoner family is intentionally NOT matched here: it
 * enables thinking via its model id (`deepseek-reasoner`) rather than this
 * parameter. DeepSeek v4 thinking is handled separately below.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  // o1 / o3 / o4 families (optionally prefixed, e.g. "openai/o3-mini").
  if (/(^|\/)o[134](-|$|\.)/.test(m)) return true;
  // gpt-5 reasoning tiers (gpt-5, gpt-5-mini, …) accept reasoning_effort.
  if (/(^|\/)gpt-5/.test(m)) return true;
  return false;
}

function supportsDeepSeekThinking(model: string): boolean {
  return /(^|\/)deepseek-v\d/i.test(model);
}

function mapDeepSeekReasoningEffort(
  depth: ModelRequest["thinking"],
): "high" | "max" | undefined {
  switch (depth) {
    case "low":
    case "medium":
      return "high";
    case "high":
      return "max";
    default:
      return undefined;
  }
}

function deepSeekThinkingOptions(
  model: string,
  depth: ModelRequest["thinking"],
):
  | {
      thinking: { type: "enabled" | "disabled" };
      reasoning_effort?: "high" | "max";
    }
  | null {
  if (!supportsDeepSeekThinking(model)) return null;
  const effort = mapDeepSeekReasoningEffort(depth);
  if (!effort) return { thinking: { type: "disabled" } };
  return {
    thinking: { type: "enabled" },
    reasoning_effort: effort,
  };
}

/** Minimal shape of an OpenAI streaming chunk (only fields we read). */
interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** OpenAI o-series reasoning summary (via some proxies). */
      reasoning?: string | null;
      /** DeepSeek reasoner chain-of-thought stream. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

/** A tool call being reassembled from streamed fragments. */
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

async function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function shouldRetryWithoutDeepSeekThinking(status: number, detail: string): boolean {
  if (status !== 400) return false;
  return /thinking|reasoning_effort|unknown parameter|unsupported|extra inputs/i.test(
    detail,
  );
}

// PLACEHOLDER_STATE

/**
 * Accumulates a single response stream and emits normalized ModelEvents.
 *
 * OpenAI streams tool calls as deltas keyed by a choice-local `index`: the
 * first delta for an index carries id + name, later deltas append argument
 * fragments. We surface tool_use_start once per index, stream the argument
 * fragments as tool_input_delta, and emit tool_use_stop + message_stop at the
 * end (OpenAI has no per-tool stop event).
 */
export class StreamState {
  private calls = new Map<number, PartialToolCall>();
  private order: number[] = [];
  private promptTokens = 0;
  private completionTokens = 0;
  private stop: StopReason = "unknown";
  private done = false;

  *consume(chunk: OpenAIChunk): Generator<ModelEvent> {
    if (chunk.usage) {
      this.promptTokens = chunk.usage.prompt_tokens ?? this.promptTokens;
      this.completionTokens =
        chunk.usage.completion_tokens ?? this.completionTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (delta?.content) {
      yield { type: "text_delta", text: delta.content };
    }
    // Reasoning streams: `reasoning` (o-series proxies) or `reasoning_content`
    // (DeepSeek reasoner). Surfaced live, never replayed into history (A1).
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) {
      yield { type: "reasoning_delta", text: reasoning };
    }

    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index;
      let call = this.calls.get(idx);
      if (!call) {
        call = {
          id: tc.id ?? `call_${idx}`,
          name: tc.function?.name ?? "",
          args: "",
          started: false,
        };
        this.calls.set(idx, call);
        this.order.push(idx);
      }
      // A name may arrive in the first delta only; an id likewise.
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name = tc.function.name;

      // Emit the start event once we know the name.
      if (!call.started && call.name) {
        call.started = true;
        yield { type: "tool_use_start", id: call.id, name: call.name };
      }
      const frag = tc.function?.arguments;
      if (frag) {
        call.args += frag;
        if (call.started) {
          yield { type: "tool_input_delta", id: call.id, partialJson: frag };
        }
      }
    }

    if (choice.finish_reason) {
      this.stop = mapFinishReason(choice.finish_reason);
    }
  }

  /** Close out tool calls and emit the terminal message_stop event. */
  *finish(): Generator<ModelEvent> {
    if (this.done) return;
    this.done = true;

    for (const idx of this.order) {
      const call = this.calls.get(idx)!;
      // A tool call that never announced its name (malformed stream) still
      // needs a start so downstream accounting stays consistent.
      if (!call.started && call.name) {
        yield { type: "tool_use_start", id: call.id, name: call.name };
        if (call.args) {
          yield {
            type: "tool_input_delta",
            id: call.id,
            partialJson: call.args,
          };
        }
      }
      if (call.started) {
        yield { type: "tool_use_stop", id: call.id };
      }
    }

    const usage: Usage = {
      inputTokens: this.promptTokens,
      outputTokens: this.completionTokens,
    };
    yield { type: "message_stop", stopReason: this.stop, usage };
  }
}

// PLACEHOLDER_CONVERT

/** OpenAI chat message shapes we produce. */
type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Map our system string + Message[] to OpenAI's flat message list.
 *
 * Differences we bridge:
 *  - system is a separate field for Anthropic but a leading message here.
 *  - our tool_use blocks live inside an assistant message → become
 *    assistant.tool_calls (arguments must be a JSON *string*).
 *  - our tool_result blocks live inside a user message → become standalone
 *    role:"tool" messages, each referencing its tool_call_id.
 */
export function toOpenAIMessages(
  system: string,
  messages: Message[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      );
      if (text.length === 0 && toolUses.length === 0) continue;
      const msg: Extract<OpenAIMessage, { role: "assistant" }> = {
        role: "assistant",
        content: text.length > 0 ? text : toolUses.length > 0 ? " " : null,
        ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      }
      out.push(msg);
      continue;
    }

    // role === "user": may carry plain text and/or tool_result blocks.
    const texts: string[] = [];
    const toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>> =
      [];
    for (const b of m.content) {
      if (b.type === "text") texts.push(b.text);
      else if (b.type === "tool_result") toolResults.push(b);
    }
    // Tool results must precede any subsequent assistant turn; emit them first.
    for (const r of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: r.toolUseId,
        content: r.content,
      });
    }
    if (texts.length > 0) {
      out.push({ role: "user", content: texts.join("") });
    }
  }

  return out;
}

/** Map our ToolSpec[] to OpenAI's function-tool format. */
export function toOpenAITools(tools: ToolSpec[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** Map an OpenAI finish_reason to our normalized StopReason. */
export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "unknown";
  }
}

// PLACEHOLDER_SSE

/**
 * Parse an SSE byte stream into the payloads of `data:` lines. Handles chunk
 * boundaries that split mid-line by buffering until a newline is seen.
 */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function errorFromStatus(status: number, detail: string): ProviderError {
  const retryable = status === 429 || status >= 500;
  const contextOverflow =
    status === 400 && /context|too long|maximum context|reduce/i.test(detail);
  const message = `OpenAI-compatible API error ${status}${
    detail ? `: ${truncate(detail, 300)}` : ""
  }`;
  return {
    message,
    retryable,
    ...(contextOverflow ? { contextOverflow: true } : {}),
    status,
  };
}

/** Classify thrown (non-HTTP) errors: network/abort/timeout. */
function normalizeError(err: unknown): ProviderError {
  if (err instanceof Error) {
    // AbortError is not retryable; other network errors generally are.
    const aborted = err.name === "AbortError";
    return { message: err.message, retryable: !aborted };
  }
  return { message: String(err), retryable: false };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
