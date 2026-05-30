import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchModels } from "../src/model/models.js";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Install a fake fetch that records the URL/headers and returns `body`. */
function mockFetch(body: unknown, ok = true, status = 200): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

describe("fetchModels", () => {
  it("parses an OpenAI-style { data: [{ id }] } list", async () => {
    const { calls } = mockFetch({
      data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    });
    const result = await fetchModels({
      provider: "openai",
      apiKey: "sk-x",
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(result.error).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/models");
  });

  it("uses x-api-key + /v1/models for anthropic", async () => {
    const { calls } = mockFetch({ data: [{ id: "claude-3-5-sonnet" }] });
    const result = await fetchModels({
      provider: "anthropic",
      apiKey: "sk-ant-x",
    });
    expect(result.models).toEqual(["claude-3-5-sonnet"]);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers["anthropic-version"]).toBeTruthy();
  });

  it("returns an error result on non-OK status (caller falls back)", async () => {
    mockFetch({}, false, 401);
    const result = await fetchModels({ provider: "openai", apiKey: "bad" });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("401");
  });

  it("swallows network errors into an error result", async () => {
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await fetchModels({ provider: "openai", apiKey: "x" });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("ignores entries without a string id", async () => {
    mockFetch({ data: [{ id: "ok" }, {}, { id: 5 }, { id: "two" }] });
    const result = await fetchModels({ provider: "openai", apiKey: "x" });
    expect(result.models).toEqual(["ok", "two"]);
  });

  it("strips a trailing slash from the base URL", async () => {
    const { calls } = mockFetch({ data: [] });
    await fetchModels({
      provider: "openai",
      apiKey: "x",
      baseURL: "https://host/v1/",
    });
    expect(calls[0]!.url).toBe("https://host/v1/models");
  });
});
