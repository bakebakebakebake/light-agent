import { describe, it, expect } from "vitest";
import { splitPromptPresentation } from "../src/ui/input.js";
import { changedRowIndices, wrapTextRows } from "../src/ui/lineEditor.js";

describe("splitPromptPresentation", () => {
  it("keeps a short single-line prompt inline", () => {
    expect(splitPromptPresentation("Name this profile [default]: ", 80)).toEqual({
      prefixLines: [],
      prompt: "Name this profile [default]: ",
    });
  });

  it("moves a multiline prompt into prefix lines", () => {
    expect(
      splitPromptPresentation("Choose a provider:\n1) Anthropic\nEnter 1 or 2 [1]: ", 80),
    ).toEqual({
      prefixLines: ["Choose a provider:", "1) Anthropic", "Enter 1 or 2 [1]:"],
      prompt: "> ",
    });
  });

  it("moves an overly long single-line prompt out of the input frame", () => {
    const prompt =
      "Base URL (optional — leave blank for the official endpoint): ";
    expect(splitPromptPresentation(prompt, 80)).toEqual({
      prefixLines: [prompt.trimEnd()],
      prompt: "> ",
    });
  });
});

describe("wrapTextRows", () => {
  it("returns one empty row for empty text", () => {
    expect(wrapTextRows("", 10, 10)).toEqual([""]);
  });

  it("wraps long text using the first-row width then the continuation width", () => {
    expect(wrapTextRows("abcdefghij", 4, 3)).toEqual(["abcd", "efg", "hij"]);
  });

  it("accounts for wide characters by visible width", () => {
    expect(wrapTextRows("你好abcd", 4, 4)).toEqual(["你好", "abcd"]);
  });
});

describe("changedRowIndices", () => {
  it("returns only the row indices that actually changed", () => {
    expect(changedRowIndices(["a", "b", "c"], ["a", "bx", "c"])).toEqual([1]);
  });

  it("includes cleared trailing rows when the next frame is shorter", () => {
    expect(changedRowIndices(["a", "b", "c"], ["a"])).toEqual([1, 2]);
  });
});
