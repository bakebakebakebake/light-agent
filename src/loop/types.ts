import type { Message, StopReason, Usage } from "../model/types.js";

/**
 * Agent loop types — see docs/01-agent-loop.md.
 *
 * The loop is an async generator that yields discrete events as it runs, so
 * the UI can render incrementally and the loop stays pausable/testable. The
 * loop never touches a concrete SDK — it talks to ModelProvider and the tool
 * registry only.
 */

/** Why the loop stopped. Mirrors the stop-condition table in docs/01. */
export type LoopStopReason =
  | "end_turn" // model gave a final answer, no tool calls
  | "max_turns" // hit the hard turn cap
  | "aborted" // user interrupted
  | "error"; // fatal, unrecoverable error

/**
 * Events surfaced by the loop. Text/tool deltas pass through from the model;
 * the loop adds higher-level lifecycle events (turn boundaries, tool
 * execution, completion) the UI needs.
 */
export type LoopEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
      /** Terminal-only detail (e.g. a colored diff); not sent to the model (#2). */
      details?: string;
    }
  | { type: "usage"; usage: Usage; stopReason: StopReason }
  | { type: "done"; reason: LoopStopReason; turns: number }
  | { type: "error"; message: string; retryable: boolean };

/** A pending tool call accumulated from the stream within one turn. */
export interface PendingToolCall {
  id: string;
  name: string;
  /** Raw JSON fragments stitched together as input_json_deltas arrive. */
  partialJson: string;
}

/** Conversation state threaded through the loop. */
export interface LoopState {
  system: string;
  messages: Message[];
}
