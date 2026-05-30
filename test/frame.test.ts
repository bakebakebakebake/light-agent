import { describe, it, expect } from "vitest";
import {
  inputBorderTone,
  frameInnerWidth,
  frameInput,
} from "../src/ui/frame.js";

/** Identity "color" fn so we can assert on the raw glyphs (no ANSI). */
const plain = (s: string): string => s;

describe("inputBorderTone", () => {
  it("tints shell (yellow) for a !-prefixed buffer, even in plan mode", () => {
    expect(inputBorderTone("!ls", false)).toBe("shell");
    expect(inputBorderTone("!ls", true)).toBe("shell");
  });

  it("tints plan (cyan) when in plan mode and not a shell line", () => {
    expect(inputBorderTone("hello", true)).toBe("plan");
    expect(inputBorderTone("", true)).toBe("plan");
  });

  it("tints normal (gray) otherwise", () => {
    expect(inputBorderTone("hello", false)).toBe("normal");
    expect(inputBorderTone("", false)).toBe("normal");
  });
});

describe("frameInnerWidth", () => {
  it("floors at the minimum for short content", () => {
    expect(frameInnerWidth(["> "], 80, 24)).toBe(24);
  });

  it("grows to fit the longest line", () => {
    const long = "x".repeat(40);
    expect(frameInnerWidth([`> ${long}`], 120, 24)).toBe(42);
  });

  it("caps at the terminal width minus border/padding", () => {
    const long = "x".repeat(200);
    // cols=40 → maxInner = 36
    expect(frameInnerWidth([long], 40, 24)).toBe(36);
  });
});

describe("frameInput", () => {
  it("wraps content in a rounded box with aligned right edge", () => {
    const rows = frameInput(["> hi"], plain, 10);
    expect(rows).toHaveLength(3); // top + 1 content + bottom
    expect(rows[0]).toBe("╭" + "─".repeat(12) + "╮");
    expect(rows[2]).toBe("╰" + "─".repeat(12) + "╯");
    // Content row: "│ " + "> hi" + padding(6) + " │"
    expect(rows[1]).toBe("│ > hi" + " ".repeat(6) + " │");
    // Every row is the same visible width.
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it("produces one content row per line for multiline buffers", () => {
    const rows = frameInput(["> line one", "  line two"], plain, 12);
    expect(rows).toHaveLength(4); // top + 2 content + bottom
    expect(rows[1]).toContain("line one");
    expect(rows[2]).toContain("line two");
  });

  it("pads a line containing ANSI by visible width, not byte length", () => {
    // A colored segment: visible "ab" is 2 cols though the string is longer.
    const colored = "\x1b[31mab\x1b[0m";
    const rows = frameInput([colored], plain, 6);
    // inner=6, visible width of content=2 → padding of 4 spaces before " │".
    expect(rows[1]).toBe("│ " + colored + " ".repeat(4) + " │");
  });
});
