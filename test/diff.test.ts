import { describe, it, expect, beforeAll } from "vitest";

/**
 * theme.ts decides color support from process.stdout.isTTY at import time, and
 * vitest runs non-TTY (so color is normally stripped). colorizeDiff's whole job
 * is color, so we force TTY on, then dynamically import the module fresh.
 */
let colorizeDiff: (s: string) => string;
let diffBody: (s: string) => string;

beforeAll(async () => {
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
  const mod = await import("../src/ui/diff.js");
  colorizeDiff = mod.colorizeDiff;
  diffBody = mod.diffBody;
});

/** Strip ANSI escapes so content assertions read plainly. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** True if `line` contains the given ANSI color code. */
function hasColor(s: string, code: string): boolean {
  return s.includes(`\x1b[${code}m`);
}

const SAMPLE = [
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,3 +1,3 @@",
  " unchanged",
  "-removed line",
  "+added line",
].join("\n");

describe("colorizeDiff", () => {
  it("colors added lines green and removed lines red", () => {
    const lines = colorizeDiff(SAMPLE).split("\n");
    const added = lines.find((l) => plain(l) === "+added line")!;
    const removed = lines.find((l) => plain(l) === "-removed line")!;
    expect(hasColor(added, "32")).toBe(true); // green
    expect(hasColor(removed, "31")).toBe(true); // red
  });

  it("does not mis-color the +++/--- file headers as add/remove", () => {
    const out = colorizeDiff(SAMPLE).split("\n");
    const plus = out.find((l) => plain(l) === "+++ b/file.ts")!;
    const minus = out.find((l) => plain(l) === "--- a/file.ts")!;
    expect(hasColor(plus, "32")).toBe(false);
    expect(hasColor(minus, "31")).toBe(false);
    expect(hasColor(plus, "2")).toBe(true); // dim
  });

  it("colors hunk headers gray", () => {
    const out = colorizeDiff(SAMPLE).split("\n");
    const hunk = out.find((l) => plain(l).startsWith("@@"))!;
    expect(hasColor(hunk, "90")).toBe(true); // gray
  });

  it("leaves context lines untouched", () => {
    const out = colorizeDiff(SAMPLE).split("\n");
    const ctx = out.find((l) => plain(l) === " unchanged")!;
    expect(ctx).toBe(" unchanged"); // no escapes added
  });
});

describe("diffBody", () => {
  it("drops the file-header preamble, keeping from the first hunk", () => {
    const patch = [
      "Index: file.ts",
      "===================================================================",
      "--- file.ts",
      "+++ file.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const body = plain(diffBody(patch));
    expect(body.startsWith("@@")).toBe(true);
    expect(body).toContain("+new");
    expect(body).not.toContain("Index:");
  });

  it("returns the trimmed input when there is no hunk header", () => {
    expect(plain(diffBody("  no hunks here  "))).toBe("no hunks here");
  });
});
