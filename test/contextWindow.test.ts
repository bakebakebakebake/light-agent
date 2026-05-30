import { describe, it, expect } from "vitest";
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
} from "../src/model/contextWindow.js";

describe("contextWindowFor", () => {
  it("maps known model families to their window", () => {
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
    expect(contextWindowFor("deepseek-chat")).toBe(64_000);
    expect(contextWindowFor("gpt-3.5-turbo")).toBe(16_385);
  });

  it("matches case-insensitively", () => {
    expect(contextWindowFor("Claude-Opus")).toBe(200_000);
    expect(contextWindowFor("GPT-4O")).toBe(128_000);
  });

  it("falls back to the default for unknown models", () => {
    expect(contextWindowFor("some-future-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("prefers gpt-4o over the generic gpt-4 rule", () => {
    // gpt-4o is listed before gpt-4; both are 128k here but the ordering proves
    // first-match-wins works for the o-series specificity.
    expect(contextWindowFor("gpt-4o-2024-08-06")).toBe(128_000);
  });

  it("maps the expanded model families correctly (#11)", () => {
    expect(contextWindowFor("o3-mini")).toBe(200_000);
    expect(contextWindowFor("o1-preview")).toBe(200_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("gpt-5")).toBe(400_000);
    expect(contextWindowFor("deepseek-reasoner")).toBe(64_000);
    expect(contextWindowFor("gemini-2.0-flash")).toBe(1_000_000);
    expect(contextWindowFor("glm-4-plus")).toBe(128_000);
  });

  it("lets an explicit override win over the table (#11)", () => {
    // The whole point: a user can correct a wrong/missing entry per profile.
    expect(contextWindowFor("deepseek-chat", 128_000)).toBe(128_000);
    expect(contextWindowFor("some-future-model", 256_000)).toBe(256_000);
  });

  it("ignores a non-positive override and falls back to the table", () => {
    expect(contextWindowFor("gpt-4o", 0)).toBe(128_000);
    expect(contextWindowFor("gpt-4o", -5)).toBe(128_000);
    expect(contextWindowFor("gpt-4o", undefined)).toBe(128_000);
  });
});

describe("parseContextWindow", () => {
  it("parses plain counts and k-suffixed values", async () => {
    const { parseContextWindow } = await import("../src/config.js");
    expect(parseContextWindow("128000")).toBe(128_000);
    expect(parseContextWindow("128k")).toBe(128_000);
    expect(parseContextWindow("200K")).toBe(200_000);
    expect(parseContextWindow("1.5k")).toBe(1_500);
  });
  it("returns undefined for missing or invalid input", async () => {
    const { parseContextWindow } = await import("../src/config.js");
    expect(parseContextWindow(undefined)).toBeUndefined();
    expect(parseContextWindow("")).toBeUndefined();
    expect(parseContextWindow("abc")).toBeUndefined();
    expect(parseContextWindow("0")).toBeUndefined();
  });
});
