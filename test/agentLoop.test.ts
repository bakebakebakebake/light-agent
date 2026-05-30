import { describe, it, expect } from "vitest";
import { runAgentLoop, parseToolInput } from "../src/loop/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../src/model/types.js";
import type { LoopEvent } from "../src/loop/types.js";

/**
 * A scripted provider: each call to stream() yields the next pre-baked batch
 * of events. Lets us drive the loop deterministically with no network.
 */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  private calls = 0;
  constructor(private scripts: ModelEvent[][]) {}
  async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
    const script = this.scripts[this.calls] ?? this.scripts.at(-1) ?? [];
    this.calls += 1;
    for (const ev of script) yield ev;
  }
}

const USAGE = {
  type: "message_stop" as const,
  stopReason: "end_turn" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};

function echoTool(): Tool {
  return {
    name: "echo",
    description: "echo back its message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    riskLevel: "low",
    concurrency: "concurrent",
    async execute(input) {
      const msg = (input as { message?: string }).message ?? "";
      return { content: `echo: ${msg}`, isError: false };
    },
  };
}

async function collect(
  gen: AsyncGenerator<LoopEvent, void, void>,
): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const base = {
  system: "s",
  userInput: "hi",
  workdir: process.cwd(),
};

describe("agent loop termination", () => {
  it("stops with end_turn when the model makes no tool call", async () => {
    const provider = new ScriptedProvider([
      [{ type: "text_delta", text: "hello" }, USAGE],
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([echoTool()]),
        maxTurns: 10,
      }),
    );
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", reason: "end_turn", turns: 1 });
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("executes a tool call, feeds the result back, then terminates", async () => {
    const provider = new ScriptedProvider([
      // turn 1: one tool call
      [
        { type: "tool_use_start", id: "t1", name: "echo" },
        { type: "tool_input_delta", id: "t1", partialJson: '{"message":' },
        { type: "tool_input_delta", id: "t1", partialJson: '"hi"}' },
        { type: "tool_use_stop", id: "t1" },
        { type: "message_stop", stopReason: "tool_use", usage: USAGE.usage },
      ],
      // turn 2: final answer
      [{ type: "text_delta", text: "done" }, USAGE],
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([echoTool()]),
        maxTurns: 10,
      }),
    );
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({
      name: "echo",
      content: "echo: hi",
      isError: false,
    });
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", reason: "end_turn", turns: 2 });
  });

  it("enforces the max-turns cap when the model keeps calling tools", async () => {
    // every call returns a tool_use, so the loop would never stop on its own
    const provider = new ScriptedProvider([
      [
        { type: "tool_use_start", id: "x", name: "echo" },
        { type: "tool_input_delta", id: "x", partialJson: '{"message":"a"}' },
        { type: "tool_use_stop", id: "x" },
        { type: "message_stop", stopReason: "tool_use", usage: USAGE.usage },
      ],
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([echoTool()]),
        maxTurns: 3,
      }),
    );
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", reason: "max_turns", turns: 3 });
  });

  it("reports an unknown tool as an error result without throwing", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool_use_start", id: "u", name: "nope" },
        { type: "tool_use_stop", id: "u" },
        { type: "message_stop", stopReason: "tool_use", usage: USAGE.usage },
      ],
      [{ type: "text_delta", text: "ok" }, USAGE],
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([echoTool()]),
        maxTurns: 10,
      }),
    );
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "nope", isError: true });
  });

  it("stops cleanly when the provider emits a fatal error", async () => {
    const provider = new ScriptedProvider([
      [{ type: "error", error: { message: "boom", retryable: false } }],
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([echoTool()]),
        maxTurns: 10,
      }),
    );
    expect(events.some((e) => e.type === "error")).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", reason: "error", turns: 1 });
  });
});

describe("parseToolInput (streamed JSON accumulation)", () => {
  it("parses stitched JSON fragments", () => {
    expect(parseToolInput('{"a":1,' + '"b":2}')).toEqual({ a: 1, b: 2 });
  });
  it("treats an empty buffer as no arguments", () => {
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput("   ")).toEqual({});
  });
  it("surfaces malformed JSON as a parse marker, not a throw", () => {
    expect(parseToolInput("{not json")).toEqual({ __parseError: "{not json" });
  });
});
