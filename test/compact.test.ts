import { describe, it, expect } from "vitest";
import { compactHistory } from "../src/loop/compact.js";
import type {
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../src/model/types.js";

/** A provider that returns a fixed summary text as a single text_delta. */
class SummaryProvider implements ModelProvider {
  readonly name = "summary";
  readonly model = "summary-1";
  lastRequest: ModelRequest | null = null;
  constructor(private summary: string) {}
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.lastRequest = req;
    yield { type: "text_delta", text: this.summary };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** Build a user text turn + an assistant reply, as a complete exchange. */
function exchange(n: number): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `question ${n}` }] },
    { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
  ];
}

/** A user turn that includes a tool call + its result (must stay paired). */
function toolExchange(n: number): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `do thing ${n}` }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: `calling tool ${n}` },
        { type: "tool_use", id: `t${n}`, name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: `t${n}`, content: "files", isError: false },
      ],
    },
  ];
}

describe("compactHistory", () => {
  it("collapses the older prefix into one summary, keeps the recent tail", async () => {
    const history: Message[] = [
      ...exchange(1),
      ...exchange(2),
      ...exchange(3),
      ...exchange(4),
      ...exchange(5),
      ...exchange(6),
    ];
    const provider = new SummaryProvider("SUMMARY");
    const result = await compactHistory(provider, history, { keepRecent: 2 });

    expect(result.collapsed).toBeGreaterThan(0);
    // First message is the summary, role assistant.
    expect(result.messages[0]!.role).toBe("assistant");
    const firstText = result.messages[0]!.content[0]!;
    expect(firstText.type).toBe("text");
    expect((firstText as { text: string }).text).toContain("SUMMARY");
    // The kept tail begins with a user turn (valid alternation).
    expect(result.messages[1]!.role).toBe("user");
    // Recent turns survive verbatim — questions 5 and 6 are still present.
    const flat = JSON.stringify(result.messages);
    expect(flat).toContain("question 5");
    expect(flat).toContain("question 6");
    expect(flat).not.toContain("question 1");
  });

  it("never splits a tool_use from its tool_result", async () => {
    const history: Message[] = [
      ...exchange(1),
      ...toolExchange(2),
      ...exchange(3),
      ...exchange(4),
    ];
    const provider = new SummaryProvider("S");
    const result = await compactHistory(provider, history, { keepRecent: 2 });

    // Walk the result: every tool_use id must have a matching tool_result.
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of result.messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.toolUseId);
      }
    }
    for (const id of useIds) expect(resultIds.has(id)).toBe(true);
  });

  it("returns history unchanged when there's too little to compact", async () => {
    const history: Message[] = [...exchange(1), ...exchange(2)];
    const provider = new SummaryProvider("S");
    const result = await compactHistory(provider, history, { keepRecent: 4 });
    expect(result.collapsed).toBe(0);
    expect(result.messages).toBe(history);
  });

  it("keeps history intact if summarization yields nothing", async () => {
    const history: Message[] = [
      ...exchange(1),
      ...exchange(2),
      ...exchange(3),
      ...exchange(4),
    ];
    const provider = new SummaryProvider("   "); // whitespace → empty summary
    const result = await compactHistory(provider, history, { keepRecent: 1 });
    expect(result.collapsed).toBe(0);
    expect(result.messages).toBe(history);
  });

  it("sends no tools on the summarization call", async () => {
    const history: Message[] = [
      ...exchange(1),
      ...exchange(2),
      ...exchange(3),
    ];
    const provider = new SummaryProvider("S");
    await compactHistory(provider, history, { keepRecent: 1 });
    expect(provider.lastRequest?.tools).toEqual([]);
  });
});
