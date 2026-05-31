import { describe, it, expect } from "vitest";
import { renderMarkdown, renderInline, MarkdownStream } from "../src/ui/markdown.js";

// ANSI helpers (theme uses these codes when stdout is a TTY; in the test
// runner stdout is NOT a TTY, so color is disabled and output is plain text).
// We therefore assert on STRUCTURE that survives no-color: bullets, gutters,
// rule characters, heading text, and the streaming==whole-string invariant.

describe("renderMarkdown block elements", () => {
  it("renders a heading without the leading #", () => {
    expect(renderMarkdown("# Title")).toBe("Title");
    expect(renderMarkdown("### Deep")).toBe("Deep");
  });

  it("renders a blockquote with a gutter", () => {
    expect(renderMarkdown("> quoted")).toContain("│ ");
    expect(renderMarkdown("> quoted")).toContain("quoted");
  });

  it("renders unordered list items with a bullet", () => {
    const out = renderMarkdown("- one\n* two\n+ three");
    expect(out).toContain("• one");
    expect(out).toContain("• two");
    expect(out).toContain("• three");
  });

  it("renders ordered list items keeping the number", () => {
    const out = renderMarkdown("1. first\n2. second");
    expect(out).toContain("1. first");
    expect(out).toContain("2. second");
  });

  it("renders a horizontal rule for --- / *** / ___", () => {
    for (const rule of ["---", "***", "___"]) {
      expect(renderMarkdown(rule)).toMatch(/─{3,}/);
    }
  });

  it("does not treat a list dash as a rule", () => {
    expect(renderMarkdown("- item")).toContain("• item");
  });
});

describe("renderInline", () => {
  it("strips bold/italic markers (no-color env)", () => {
    expect(renderInline("**bold**")).toBe("bold");
    expect(renderInline("*italic*")).toBe("italic");
    expect(renderInline("__bold__")).toBe("bold");
  });

  it("strips strikethrough markers", () => {
    expect(renderInline("~~gone~~")).toBe("gone");
  });

  it("renders inline code without backticks", () => {
    expect(renderInline("use `npm test` now")).toBe("use npm test now");
  });

  it("leaves unmatched markers literal", () => {
    expect(renderInline("a * b")).toBe("a * b");
    expect(renderInline("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("does not parse markers inside inline code", () => {
    // The * inside the code span must stay literal.
    expect(renderInline("`a*b*c`")).toBe("a*b*c");
  });
});

describe("code fences", () => {
  it("suppresses inline parsing inside a fenced block", () => {
    const md = ["```", "const x = *ptr;", "**not bold**", "```"].join("\n");
    const out = renderMarkdown(md);
    // The literal markers survive inside the fence.
    expect(out).toContain("const x = *ptr;");
    expect(out).toContain("**not bold**");
  });

  it("renders fenced code with only a lightweight language label", () => {
    const md = ["```ts", "let n = 1;", "```"].join("\n");
    const out = renderMarkdown(md);
    expect(out).toContain("ts");
    expect(out).toContain("let n = 1;"); // code survives
    expect(out).not.toContain("┌");
    expect(out).not.toContain("└");
    // Copy-friendliness (#2): the code line must NOT carry a leading "│ "
    // gutter, so selecting it yields clean source.
    const lines = out.split("\n");
    const codeLine = lines.find((l) => l.includes("let n = 1;"))!;
    // eslint-disable-next-line no-control-regex
    const plain = codeLine.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toBe("let n = 1;");
  });
});

describe("GFM tables", () => {
  const table = [
    "| Name | Role |",
    "|------|------|",
    "| Ada  | Eng  |",
    "| Boo  | PM   |",
  ].join("\n");

  it("draws a boxed table with all cell contents", () => {
    const out = renderMarkdown(table);
    expect(out).toContain("┌");
    expect(out).toContain("┐");
    expect(out).toContain("└");
    expect(out).toContain("┘");
    for (const cell of ["Name", "Role", "Ada", "Eng", "Boo", "PM"]) {
      expect(out).toContain(cell);
    }
  });

  it("falls back to plain lines when there is no separator row", () => {
    const notTable = ["| a | b |", "| c | d |"].join("\n");
    const out = renderMarkdown(notTable);
    // Without a |---| separator it is not a table; content still appears.
    expect(out).toContain("a");
    expect(out).toContain("d");
  });

  it("renders a table fed through the stream identically", () => {
    let acc = "";
    const md = new MarkdownStream((s) => {
      acc += s;
    });
    for (const ch of table) md.push(ch);
    md.flush();
    expect(acc.replace(/\n$/, "")).toBe(renderMarkdown(table));
  });
});

describe("streaming invariant", () => {
  function streamed(chunks: string[]): string {
    let acc = "";
    const md = new MarkdownStream((s) => {
      acc += s;
    });
    for (const c of chunks) md.push(c);
    md.flush();
    return acc;
  }

  const sample = [
    "# Heading",
    "",
    "Some **bold** and `code` and *italic*.",
    "",
    "- list one",
    "- list two",
    "",
    "> a quote",
    "",
    "```",
    "raw *stars* stay",
    "```",
    "trailing line no newline",
  ].join("\n");

  it("produces the same output whether fed whole or split arbitrarily", () => {
    const whole = streamed([sample]);
    // Split every 3 characters to stress partial-line buffering.
    const chunks: string[] = [];
    for (let i = 0; i < sample.length; i += 3) chunks.push(sample.slice(i, i + 3));
    const split = streamed(chunks);
    expect(split).toBe(whole);
  });

  it("matches renderMarkdown for the same input", () => {
    // renderMarkdown joins with \n and has no trailing newline; the stream emits
    // a newline after each completed line and flushes the last partial line.
    // Compare line-content equality by trimming a single trailing newline.
    const viaStream = streamed([sample]).replace(/\n$/, "");
    expect(viaStream).toBe(renderMarkdown(sample));
  });
});
