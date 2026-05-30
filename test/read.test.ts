import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool, resolveInWorkdir } from "../src/tools/read.js";
import type { ToolContext } from "../src/tools/types.js";

let dir: string;
let ctx: ToolContext;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-read-"));
  writeFileSync(join(dir, "lines.txt"), "a\nb\nc\nd\ne\n", "utf8");
  writeFileSync(join(dir, "empty.txt"), "", "utf8");
  ctx = { workdir: dir };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("read tool", () => {
  it("returns line-numbered content", async () => {
    const r = await readTool.execute({ path: "lines.txt" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("1\ta");
    expect(r.content).toContain("5\te");
  });

  it("paginates with offset and limit", async () => {
    const r = await readTool.execute(
      { path: "lines.txt", offset: 2, limit: 2 },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("2\tb");
    expect(r.content).toContain("3\tc");
    expect(r.content).not.toContain("1\ta");
    expect(r.content).toContain("offset=4");
  });

  it("handles an empty file", async () => {
    const r = await readTool.execute({ path: "empty.txt" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("empty");
  });

  it("returns an info-rich error for a missing file", async () => {
    const r = await readTool.execute({ path: "nope.txt" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("does not exist");
  });

  it("rejects an offset past the end", async () => {
    const r = await readTool.execute({ path: "lines.txt", offset: 99 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("past the end");
  });

  it("rejects paths that escape the working directory", async () => {
    const r = await readTool.execute({ path: "../../../etc/passwd" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the working directory");
  });

  it("rejects invalid arguments", async () => {
    const r = await readTool.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid arguments");
  });
});

describe("resolveInWorkdir", () => {
  it("accepts paths inside the workdir", () => {
    const r = resolveInWorkdir("/work", "sub/file.txt");
    expect(r.ok).toBe(true);
  });
  it("rejects parent-traversal escapes", () => {
    const r = resolveInWorkdir("/work", "../secret");
    expect(r.ok).toBe(false);
  });
  it("rejects absolute paths outside the workdir", () => {
    const r = resolveInWorkdir("/work", "/etc/passwd");
    expect(r.ok).toBe(false);
  });
});
