import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  Message,
} from "../src/model/types.js";
import type { LoopEvent } from "../src/loop/types.js";
import { InterruptController } from "../src/ui/interrupt.js";

const USAGE = {
  type: "message_stop" as const,
  stopReason: "end_turn" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};

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

/** Provider that aborts the given controller while streaming, then keeps going. */
class AbortingProvider implements ModelProvider {
  readonly name = "aborting";
  readonly model = "aborting-1";
  constructor(
    private controller: InterruptController,
    private emitText: boolean,
  ) {}
  async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
    if (this.emitText) yield { type: "text_delta", text: "partial" };
    this.controller.abort();
    // After abort the model layer would surface an error; simulate that.
    yield { type: "error", error: { message: "aborted", retryable: false } };
  }
}

async function collect(
  gen: AsyncGenerator<LoopEvent, void, void>,
): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const base = { system: "s", workdir: process.cwd(), maxTurns: 10 };

describe("history accumulation across turns", () => {
  it("shares one message array so the conversation grows in place", async () => {
    const history: Message[] = [];
    const provider = new ScriptedProvider([
      [{ type: "text_delta", text: "first reply" }, USAGE],
    ]);
    await collect(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry(),
        userInput: "hello",
        history,
      }),
    );
    // user + assistant after turn 1
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("assistant");

    const provider2 = new ScriptedProvider([
      [{ type: "text_delta", text: "second reply" }, USAGE],
    ]);
    await collect(
      runAgentLoop({
        ...base,
        provider: provider2,
        registry: new ToolRegistry(),
        userInput: "again",
        history,
      }),
    );
    // prior 2 + new user + new assistant
    expect(history).toHaveLength(4);
    expect(history[2]?.role).toBe("user");
    expect(history[3]?.role).toBe("assistant");
  });
});

describe("graceful interruption keeps history valid", () => {
  it("keeps partial assistant text and ends on an assistant turn", async () => {
    const history: Message[] = [];
    const controller = new InterruptController();
    const events = await collect(
      runAgentLoop({
        ...base,
        provider: new AbortingProvider(controller, true),
        registry: new ToolRegistry(),
        userInput: "do a thing",
        history,
        signal: controller.signal,
      }),
    );
    expect(events.some((e) => e.type === "done" && e.reason === "aborted")).toBe(
      true,
    );
    expect(history.at(-1)?.role).toBe("assistant");
  });

  it("drops the dangling user message when nothing was produced", async () => {
    const history: Message[] = [];
    const controller = new InterruptController();
    await collect(
      runAgentLoop({
        ...base,
        provider: new AbortingProvider(controller, false),
        registry: new ToolRegistry(),
        userInput: "do a thing",
        history,
        signal: controller.signal,
      }),
    );
    // No assistant text and aborted → history must not end on a lone user turn.
    expect(history).toHaveLength(0);
  });
});

describe("InterruptController", () => {
  it("aborts its signal once and is idempotent", () => {
    const c = new InterruptController();
    expect(c.aborted).toBe(false);
    c.abort();
    expect(c.aborted).toBe(true);
    c.abort(); // no throw
    expect(c.aborted).toBe(true);
  });
  it("reset gives a fresh, un-aborted signal", () => {
    const c = new InterruptController();
    c.abort();
    c.reset();
    expect(c.aborted).toBe(false);
  });
});
