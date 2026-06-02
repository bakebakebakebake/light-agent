import { describe, expect, it } from "vitest";
import { appendPromptBlocks, systemPrompt } from "../src/prompt.js";

describe("prompt memory helpers", () => {
  it("appends memory and skill blocks without changing the base prompt shape", () => {
    const base = systemPrompt("/work", ["Available skills:", "- review: code review helper (project)"]);
    const joined = appendPromptBlocks(base, [
      "<memory_context>\nmemories:\n- [project/workflow/active] Testing flow: Run typecheck first.\n</memory_context>",
      "# Skill: review\n\nReview carefully.",
    ]);
    expect(joined).toContain("<memory_context>");
    expect(joined).toContain("# Skill: review");
    expect(joined.startsWith("You are Light-Agent")).toBe(true);
  });

  it("ignores empty prompt blocks", () => {
    const base = systemPrompt("/work");
    expect(appendPromptBlocks(base, ["", "  "])).toBe(base);
  });
});
