import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/model/index.js";
import {
  classifyCompatFailure,
  probeCompatibility,
} from "../src/model/compat.js";
import type { Config } from "../src/config.js";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("classifyCompatFailure", () => {
  it("classifies unauthorized clients distinctly", () => {
    expect(
      classifyCompatFailure(
        '{"error":{"message":"unauthorized client detected"},"type":"unauthorized_client_error"}',
      ),
    ).toBe("unauthorized_client");
  });

  it("classifies empty-chunk anthropic failures", () => {
    expect(classifyCompatFailure("request ended without sending any chunks")).toBe("empty_stream");
  });
});

describe("probeCompatibility", () => {
  it("auto-corrects to the openai chain when anthropic fails but openai works", async () => {
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/messages")) {
        return new Response(
          JSON.stringify({ error: { message: "Expected OpenAI-compatible API endpoint" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/chat/completions")) {
        return sseResponse('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const report = await probeCompatibility({
      preferredProtocol: "anthropic",
      baseURL: "https://example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });

    expect(report.selected?.preferredProtocol).toBe("openai");
    expect(report.corrected).toBe(true);
    expect(report.selected?.chatURL).toBe("https://example.com/chat/completions");
  });

  it("keeps anthropic when a /v1 URL still resolves through the anthropic chain", async () => {
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-8" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/messages")) {
        return sseResponse('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const report = await probeCompatibility({
      preferredProtocol: "anthropic",
      baseURL: "https://example.com/v1",
      apiKey: "sk-ant-test",
      model: "claude-opus-4-8",
    });

    expect(report.selected?.preferredProtocol).toBe("anthropic");
    expect(report.selected?.chatURL).toBe("https://example.com/v1/messages");
    expect(report.selected?.catalogURL).toBe("https://example.com/v1/models");
  });

  it("keeps the working chat URL but upgrades to a better catalog URL when available", async () => {
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://example.com/models") {
        return new Response("<!doctype html><html>no catalog</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4-mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://example.com/chat/completions") {
        return sseResponse('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
      }
      if (url === "https://example.com/v1/chat/completions") {
        return sseResponse('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const report = await probeCompatibility({
      preferredProtocol: "openai",
      baseURL: "https://example.com",
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
    });

    expect(report.selected?.chatURL).toBe("https://example.com/chat/completions");
    expect(report.selected?.catalogURL).toBe("https://example.com/v1/models");
    expect(report.selected?.supportsCatalog).toBe(true);
  });
});

describe("createProvider compatibility wrapper", () => {
  it("retries through the alternate protocol when the preferred one mismatches", async () => {
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/messages")) {
        return new Response(
          JSON.stringify({ error: { message: "Expected OpenAI-compatible API endpoint" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/chat/completions")) {
        return sseResponse('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const provider = createProvider({
      provider: "anthropic",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseURL: "https://example.com",
      workdir: "/tmp",
      maxTurns: 1,
      bashTimeoutMs: 1_000,
      memoryEnabled: true,
      memoryExtractEvery: 3,
      memoryInjectionBudget: 100,
    } satisfies Config);

    let text = "";
    for await (const event of provider.stream({
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK" }] }],
      tools: [],
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") throw new Error(event.error.message);
    }

    expect(text).toBe("OK");
  });
});
