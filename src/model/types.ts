/**
 * Model interaction layer types — see docs/06-model-interaction.md.
 *
 * The ModelProvider interface is the pluggable core: the agent loop talks to
 * this interface, never to a concrete SDK. Swapping Anthropic for another
 * provider (or a unified gateway like the Vercel AI SDK) only means writing a
 * new adapter — the loop is untouched.
 */

/** A tool the model may call, as advertised to the provider. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** Role of a message in the conversation. */
export type Role = "user" | "assistant";

/**
 * Thinking / reasoning depth (A1) — one user-facing knob mapped to each
 * provider's native reasoning control:
 *  - Anthropic: `thinking: { type:"enabled", budget_tokens }` (off ⇒ omitted).
 *  - OpenAI-compatible: `reasoning_effort: low|medium|high` (off ⇒ omitted).
 *  - DeepSeek V4: sent as `thinking` + `reasoning_effort`; our `high` maps to
 *    DeepSeek's highest official tier.
 */
export type ThinkingDepth = "off" | "low" | "medium" | "high";

/** A block of content within a message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    };

/** One message in the conversation history. */
export interface Message {
  role: Role;
  content: ContentBlock[];
  /**
   * Optional provider-native reasoning trace that must be replayed on the next
   * request for some OpenAI-compatible models (notably DeepSeek thinking mode
   * when tool calls are involved). Never rendered into the normal transcript.
   */
  reasoningContent?: string;
}

/** A request to the model. */
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Reasoning depth (A1). Defaults to "off" when omitted. */
  thinking?: ThinkingDepth;
  /** Abort signal so streaming can be interrupted mid-flight (docs/08). */
  signal?: AbortSignal;
}

/** Why the model stopped generating. Mirrors Anthropic stop reasons. */
export type StopReason =
  | "tool_use" // wants to call one or more tools
  | "end_turn" // finished its turn normally
  | "max_tokens" // truncated by output cap
  | "stop_sequence"
  | "unknown";

/**
 * Streaming events emitted by a provider as it generates.
 *
 * The agent loop and UI both consume these. tool_use arrives in pieces:
 * a `tool_use_start` (id + name), then zero or more `tool_input_delta`
 * (partial JSON), then the block closes. The adapter is responsible for
 * accumulating and parsing the JSON before the loop sees a finished call.
 */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_input_delta"; id: string; partialJson: string }
  | { type: "tool_use_stop"; id: string }
  | { type: "message_stop"; stopReason: StopReason; usage: Usage }
  | { type: "error"; error: ProviderError };

/** Token accounting for one model call (docs/06, docs/11). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A normalized provider error. */
export interface ProviderError {
  message: string;
  /** True if retrying the same request might succeed (429, 5xx, timeout). */
  retryable: boolean;
  /** True if the payload exceeded the context window. */
  contextOverflow?: boolean;
  status?: number;
}

/**
 * The pluggable provider interface. Implementations live in this directory
 * (e.g. anthropic.ts). The loop only ever calls `stream`.
 */
export interface ModelProvider {
  /** Stable identifier, e.g. "anthropic". */
  readonly name: string;
  /** The default model id this provider will use. */
  readonly model: string;
  /** Stream a completion as a sequence of ModelEvents. */
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}
