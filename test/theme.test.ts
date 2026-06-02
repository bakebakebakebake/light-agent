import { describe, it, expect } from "vitest";
import { box, visibleWidth } from "../src/ui/theme.js";

/** Strip ANSI so we can assert on visible structure. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("box", () => {
  it("keeps borders aligned for wide CJK titles and body text", () => {
    const lines = plain(
      box("会话", [
        "奖项  最佳男主角",
        "得主  Michael B. Jordan —《Sinners》",
      ]),
    ).split("\n");
    expect(new Set(lines.map((line) => visibleWidth(line))).size).toBe(1);
  });
});
