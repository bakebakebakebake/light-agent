import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFiles } from "../src/ext/fileSearch.js";

/**
 * Build a throwaway tree:
 *   src/app.ts, src/util/format.ts, src/util/helpers.ts, README.md
 *   node_modules/dep/index.js  (must be skipped)
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "filesearch-"));
  mkdirSync(join(root, "src", "util"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "x");
  writeFileSync(join(root, "src", "util", "format.ts"), "x");
  writeFileSync(join(root, "src", "util", "helpers.ts"), "x");
  writeFileSync(join(root, "README.md"), "x");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "x");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("searchFiles", () => {
  it("finds files by basename substring", () => {
    const hits = searchFiles(root, "format");
    expect(hits.map((h) => h.path)).toContain("src/util/format.ts");
  });

  it("skips node_modules", () => {
    const hits = searchFiles(root, "index");
    expect(hits.find((h) => h.path.includes("node_modules"))).toBeUndefined();
  });

  it("ranks an exact basename match above a fuzzy one", () => {
    const hits = searchFiles(root, "app.ts");
    expect(hits[0]!.path).toBe("src/app.ts");
  });

  it("returns the directory as a hint, empty at the root", () => {
    const readme = searchFiles(root, "README").find((h) => h.path === "README.md")!;
    expect(readme.dir).toBe("");
    const fmt = searchFiles(root, "format")[0]!;
    expect(fmt.dir).toBe("src/util");
  });

  it("matches everything (weakly) on an empty query, capped by limit", () => {
    const hits = searchFiles(root, "", 2);
    expect(hits.length).toBe(2);
  });

  it("returns nothing for a query that matches no path", () => {
    expect(searchFiles(root, "zzzznomatch")).toEqual([]);
  });

  it("supports subsequence (fuzzy) matching across a path", () => {
    // "srfmt" is a subsequence of "src/util/format.ts".
    const hits = searchFiles(root, "srfmt");
    expect(hits.map((h) => h.path)).toContain("src/util/format.ts");
  });
});
