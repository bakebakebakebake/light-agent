import { describe, it, expect } from "vitest";
import { parseThinkingDepth } from "../src/config.js";
import { runAgentLoop } from "../src/loop/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../src/model/types.js";

/** A provider that records the last request it was asked to stream. */
class CapturingProvider implements ModelProvider {
  readonly name = "capture";
  readonly model = "capture-1";
  last: ModelRequest | null = null;
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.last = req;
    yield { type: "text_delta", text: "ok" };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

describe("parseThinkingDepth", () => {
  it("maps the canonical names", () => {
    expect(parseThinkingDepth("low")).toBe("low");
    expect(parseThinkingDepth("medium")).toBe("medium");
    expect(parseThinkingDepth("high")).toBe("high");
    expect(parseThinkingDepth("off")).toBe("off");
  });

  it("accepts aliases and is case-insensitive", () => {
    expect(parseThinkingDepth("MED")).toBe("medium");
    expect(parseThinkingDepth("Max")).toBe("high");
  });

  it("falls back to off for unknown or empty values", () => {
    expect(parseThinkingDepth(undefined)).toBe("off");
    expect(parseThinkingDepth("bananas")).toBe("off");
    expect(parseThinkingDepth("")).toBe("off");
  });
});

describe("agent loop threads thinking depth", () => {
  async function drain(gen: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of gen) {
      /* consume */
    }
  }
  const base = {
    system: "s",
    userInput: "hi",
    workdir: process.cwd(),
    maxTurns: 5,
  };

  it("passes the chosen depth to the provider request", async () => {
    const provider = new CapturingProvider();
    await drain(
      runAgentLoop({
        ...base,
        provider,
        registry: new ToolRegistry([]),
        thinking: "high",
      }),
    );
    expect(provider.last?.thinking).toBe("high");
  });

  it("omits thinking when not requested", async () => {
    const provider = new CapturingProvider();
    await drain(
      runAgentLoop({ ...base, provider, registry: new ToolRegistry([]) }),
    );
    expect(provider.last?.thinking).toBeUndefined();
  });
});

describe("OpenAI request maps depth per model class", () => {
  /** Run one stream() with a stubbed fetch and return the captured body JSON. */
  async function captureBody(
    model: string,
    thinking: "off" | "low" | "medium" | "high",
  ): Promise<string> {
    const { OpenAIProvider } = await import("../src/model/openai.js");
    const captured: { body?: string } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      captured.body = init.body;
      throw new Error("stop"); // short-circuit; provider yields an error event
    }) as unknown as typeof fetch;
    try {
      const provider = new OpenAIProvider({ apiKey: "k", model });
      for await (const _ of provider.stream({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        thinking,
      })) {
        /* consume */
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    return captured.body ?? "";
  }

  it("sends reasoning_effort + max_completion_tokens for a reasoning model", async () => {
    const body = await captureBody("o3-mini", "low");
    expect(body).toContain('"reasoning_effort":"low"');
    expect(body).toContain('"max_completion_tokens"');
    // Reasoning models reject max_tokens — it must not be present.
    expect(body).not.toContain('"max_tokens"');
  });

  it("never sends reasoning_effort to a non-reasoning model (would 400)", async () => {
    const body = await captureBody("gpt-4o", "high");
    expect(body).not.toContain("reasoning_effort");
    expect(body).toContain('"max_tokens"');
  });

  it("omits reasoning_effort when thinking is off, even on a reasoning model", async () => {
    const body = await captureBody("o3-mini", "off");
    expect(body).not.toContain("reasoning_effort");
    expect(body).toContain('"max_completion_tokens"');
  });
});

describe("isReasoningModel", () => {
  it("matches o-series and gpt-5 tiers", async () => {
    const { isReasoningModel } = await import("../src/model/openai.js");
    for (const m of ["o1", "o3-mini", "o4-mini", "openai/o3", "gpt-5", "gpt-5-mini"]) {
      expect(isReasoningModel(m)).toBe(true);
    }
  });
  it("does not match plain chat models", async () => {
    const { isReasoningModel } = await import("../src/model/openai.js");
    for (const m of ["gpt-4o", "gpt-4o-mini", "deepseek-chat", "deepseek-reasoner", "qwen-max"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });
});
