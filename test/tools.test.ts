import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "../src/tools/write.js";
import { grepTool } from "../src/tools/grep.js";
import { lsTool } from "../src/tools/ls.js";

let dir: string;
const ctx = () => ({ workdir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("write tool", () => {
  it("creates a new file, making parent directories", async () => {
    const r = await writeTool.execute(
      { path: "src/deep/new.ts", content: "export const x = 1;\n" },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, "src/deep/new.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(r.content).toContain("Created");
  });

  it("overwrites an existing file and reports it", async () => {
    writeFileSync(join(dir, "a.txt"), "old");
    const r = await writeTool.execute({ path: "a.txt", content: "new" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Overwrote");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new");
  });

  it("rejects paths outside the workdir", async () => {
    const r = await writeTool.execute(
      { path: "../escape.txt", content: "x" },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/outside the working directory/);
  });

  it("previews a create as a diff against /dev/null", () => {
    const preview = writeTool.describeAction!(
      { path: "n.ts", content: "a\nb\n" },
      ctx(),
    );
    expect(preview.summary).toContain("Create n.ts");
    expect(preview.details).toContain("/dev/null");
  });
});

describe("grep tool", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "const foo = 1;\nconst bar = 2;\n");
    writeFileSync(join(dir, "src/b.ts"), "function foo() {}\n");
    writeFileSync(join(dir, "notes.md"), "foo appears here too\n");
  });

  it("finds matches across files as path:line: text", async () => {
    const r = await grepTool.execute({ pattern: "foo" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/a.ts:1:");
    expect(r.content).toContain("src/b.ts:1:");
    expect(r.content).toContain("notes.md:1:");
  });

  it("restricts by glob", async () => {
    const r = await grepTool.execute({ pattern: "foo", glob: "*.md" }, ctx());
    expect(r.content).toContain("notes.md");
    expect(r.content).not.toContain("src/a.ts");
  });

  it("supports case-insensitive search", async () => {
    writeFileSync(join(dir, "c.ts"), "const FOO = 9;\n");
    const r = await grepTool.execute(
      { pattern: "foo", ignore_case: true },
      ctx(),
    );
    expect(r.content).toContain("c.ts:1:");
  });

  it("reports no matches cleanly", async () => {
    const r = await grepTool.execute({ pattern: "zzzznope" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No matches/);
  });

  it("returns an info-rich error on a bad regex", async () => {
    const r = await grepTool.execute({ pattern: "(" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid regular expression/);
  });
});

describe("ls tool", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "x");
    writeFileSync(join(dir, "readme.md"), "hello");
    writeFileSync(join(dir, ".hidden"), "secret");
  });

  it("lists directories first with a trailing slash, then files", async () => {
    const r = await lsTool.execute({}, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/");
    expect(r.content).toContain("readme.md");
  });

  it("hides dotfiles unless all is set", async () => {
    const hidden = await lsTool.execute({}, ctx());
    expect(hidden.content).not.toContain(".hidden");
    const shown = await lsTool.execute({ all: true }, ctx());
    expect(shown.content).toContain(".hidden");
  });

  it("errors when the path is a file", async () => {
    const r = await lsTool.execute({ path: "readme.md" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a directory/);
  });

  it("rejects paths outside the workdir", async () => {
    const r = await lsTool.execute({ path: ".." }, ctx());
    expect(r.isError).toBe(true);
  });
});
