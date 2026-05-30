import type {
  ModelProvider,
  ContentBlock,
  Message,
  ThinkingDepth,
} from "../model/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LoopEvent, LoopStopReason, PendingToolCall } from "./types.js";

/**
 * Agent loop — the ReAct while-loop, written as an async generator (docs/01).
 *
 * Each iteration: assemble messages → stream the model → collect any tool
 * calls → gate them → execute → feed results back → repeat until the model
 * stops calling tools, the turn cap is hit, the user aborts, or a fatal error
 * occurs. The loop talks only to ModelProvider and the ToolRegistry; it never
 * touches a concrete SDK.
 */

/** Decision returned by a permission gate (docs/04). */
export type GateDecision = { allow: true } | { allow: false; reason: string };

/**
 * Permission gate seam. Phase 2 plugs a real deny-first policy + confirmation
 * flow in here; the default allows everything (Read is low-risk anyway).
 */
export type PermissionGate = (call: {
  tool: Tool;
  input: unknown;
}) => Promise<GateDecision>;

const allowAll: PermissionGate = async () => ({ allow: true });

export interface AgentLoopOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  system: string;
  userInput: string;
  maxTurns: number;
  workdir: string;
  signal?: AbortSignal;
  /** Prior conversation, if resuming. Defaults to empty. */
  history?: Message[];
  gate?: PermissionGate;
  /** Reasoning depth (A1); forwarded to the provider request. */
  thinking?: ThinkingDepth;
  /**
   * Lift workdir confinement for filesystem tools (#9). Set true only when the
   * session is in `allowAll` mode — the user has traded the sandbox for full
   * control. Threaded into every tool's ToolContext below.
   */
  allowOutsideWorkdir?: boolean;
}

/**
 * Run the agent loop, yielding events as it goes. Returns nothing; callers
 * consume the event stream (the UI renders it, tests assert on it).
 */
export async function* runAgentLoop(
  opts: AgentLoopOptions,
): AsyncGenerator<LoopEvent, void, void> {
  const { provider, registry, system, maxTurns, workdir, signal } = opts;
  const allowOutsideWorkdir = opts.allowOutsideWorkdir ?? false;
  const gate = opts.gate ?? allowAll;
  // Use the caller's history array in place (if given) so the conversation
  // accumulates across turns — the REPL reads it back after each run. The new
  // user input is appended here; the loop appends assistant + tool_result
  // messages as it goes.
  const messages: Message[] = opts.history ?? [];
  messages.push({ role: "user", content: [{ type: "text", text: opts.userInput }] });

  let turn = 0;
  while (true) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted", turns: turn };
      return;
    }
    if (turn >= maxTurns) {
      yield { type: "done", reason: "max_turns", turns: turn };
      return;
    }
    turn += 1;
    yield { type: "turn_start", turn };

    // --- call the model, accumulating assistant content for this turn ---
    let textBuf = "";
    const pending = new Map<string, PendingToolCall>();
    const order: string[] = [];
    let fatal: { message: string; retryable: boolean } | null = null;

    const req = {
      system,
      messages,
      tools: registry.specs(),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(signal ? { signal } : {}),
    };

    for await (const ev of provider.stream(req)) {
      if (ev.type === "text_delta") {
        textBuf += ev.text;
        yield { type: "text_delta", text: ev.text };
      } else if (ev.type === "reasoning_delta") {
        // Reasoning is surfaced live but never written to message history — it
        // is not replayed on the next request (A1).
        yield { type: "reasoning", text: ev.text };
      } else if (ev.type === "tool_use_start") {
        pending.set(ev.id, { id: ev.id, name: ev.name, partialJson: "" });
        order.push(ev.id);
      } else if (ev.type === "tool_input_delta") {
        const p = pending.get(ev.id);
        if (p) p.partialJson += ev.partialJson;
      } else if (ev.type === "message_stop") {
        yield { type: "usage", usage: ev.usage, stopReason: ev.stopReason };
      } else if (ev.type === "error") {
        fatal = { message: ev.error.message, retryable: ev.error.retryable };
      }
    }

    // --- user interrupted mid-stream: stop gracefully, keep history valid ---
    // An abort surfaces as a provider error, so check it before `fatal`.
    // Preserve any partial assistant text for a coherent transcript but drop
    // incomplete tool calls (their results never ran). If nothing was
    // produced, remove the dangling user message so the conversation doesn't
    // end on a user turn (which the API rejects on the next request).
    if (signal?.aborted) {
      if (textBuf.length > 0) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: textBuf }],
        });
      } else if (messages[messages.length - 1]?.role === "user") {
        messages.pop();
      }
      yield { type: "done", reason: "aborted", turns: turn };
      return;
    }

    if (fatal) {
      yield { type: "error", message: fatal.message, retryable: fatal.retryable };
      yield { type: "done", reason: "error", turns: turn };
      return;
    }

    // --- assemble the assistant message (text first, then tool calls) ---
    const assistantBlocks: ContentBlock[] = [];
    if (textBuf.length > 0) {
      assistantBlocks.push({ type: "text", text: textBuf });
    }
    const calls = order.map((id) => {
      const p = pending.get(id)!;
      return { id: p.id, name: p.name, input: parseToolInput(p.partialJson) };
    });
    for (const c of calls) {
      assistantBlocks.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.input,
      });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    // --- no tool calls → final answer, normal stop ---
    if (calls.length === 0) {
      yield { type: "done", reason: "end_turn", turns: turn };
      return;
    }

    // --- announce, gate, execute; feed results back ---
    for (const c of calls) {
      yield { type: "tool_call", id: c.id, name: c.name, input: c.input };
    }

    const ctx: ToolContext = {
      workdir,
      ...(signal ? { signal } : {}),
      ...(allowOutsideWorkdir ? { allowOutsideWorkdir } : {}),
    };
    const resultBlocks: ContentBlock[] = [];
    for (const c of calls) {
      const tool = registry.get(c.name);
      let content: string;
      let isError: boolean;
      let details: string | undefined;

      if (!tool) {
        content =
          `Unknown tool "${c.name}". Available tools: ` +
          registry
            .list()
            .map((t) => t.name)
            .join(", ") +
          ".";
        isError = true;
      } else {
        const decision = await gate({ tool, input: c.input });
        if (!decision.allow) {
          content = `Tool "${c.name}" was not run: ${decision.reason}`;
          isError = true;
        } else {
          try {
            const r = await tool.execute(c.input, ctx);
            content = r.content;
            isError = r.isError;
            details = r.details;
          } catch (err) {
            content =
              `Tool "${c.name}" threw an unexpected error: ` +
              (err as Error).message;
            isError = true;
          }
        }
      }

      yield {
        type: "tool_result",
        id: c.id,
        name: c.name,
        content,
        isError,
        ...(details !== undefined ? { details } : {}),
      };
      resultBlocks.push({
        type: "tool_result",
        toolUseId: c.id,
        content,
        isError,
      });
    }

    messages.push({ role: "user", content: resultBlocks });
    // loop continues: results go back to the model
  }
}

/**
 * Parse the accumulated tool-input JSON. The model emits arguments as partial
 * JSON fragments; an empty buffer means "no arguments" ({}). Malformed JSON is
 * surfaced as a parse marker so the tool's own validation produces an
 * info-rich error rather than the loop throwing.
 */
export function parseToolInput(partialJson: string): unknown {
  const trimmed = partialJson.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __parseError: trimmed };
  }
}

/** Re-exported for callers that want to label the stop reason. */
export type { LoopStopReason };
