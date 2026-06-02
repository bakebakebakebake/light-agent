import { describe, it, expect } from "vitest";
import {
  statusBlock,
  statusLine,
  tildify,
  humanTokens,
  formatContextPercent,
} from "../src/ui/status.js";
import { homedir } from "node:os";
import { visibleWidth } from "../src/ui/theme.js";

/** Strip ANSI so we can assert on visible content + alignment. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("humanTokens", () => {
  it("shows raw counts under 1000", () => {
    expect(humanTokens(0)).toBe("0");
    expect(humanTokens(999)).toBe("999");
  });
  it("compacts thousands with a k suffix", () => {
    expect(humanTokens(1000)).toBe("1k");
    expect(humanTokens(12_300)).toBe("12.3k");
    expect(humanTokens(128_000)).toBe("128k");
  });
});

describe("tildify", () => {
  it("collapses the home dir to ~", () => {
    expect(tildify(homedir() + "/projects/x")).toBe("~/projects/x");
  });
  it("leaves non-home paths untouched", () => {
    expect(tildify("/var/www")).toBe("/var/www");
  });
});

describe("statusBlock", () => {
  const info = {
    workdir: "/var/www/app",
    model: "gpt-4o",
    used: 12_300,
    total: 128_000,
    mode: "plan" as const,
  };

  it("includes workdir, model, context usage, and mode", () => {
    const out = plain(statusBlock(info));
    expect(out).toContain("/var/www/app");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("12.3k/128k ctx");
    expect(out).toContain("plan mode");
  });

  it("draws a 3-line rounded frame", () => {
    const lines = plain(statusBlock(info)).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[2]!.startsWith("╰")).toBe(true);
    expect(lines[2]!.endsWith("╯")).toBe(true);
  });

  it("aligns the right border on visible width", () => {
    const lines = plain(statusBlock(info)).split("\n");
    const widths = lines.map((l) => [...l].length);
    // All three border lines share the same visible width.
    expect(new Set(widths).size).toBe(1);
  });

  it("keeps the frame aligned when the workdir contains wide CJK chars", () => {
    const lines = plain(
      statusBlock({
        ...info,
        workdir: "/var/项目/应用",
      }),
    ).split("\n");
    expect(new Set(lines.map((line) => visibleWidth(line))).size).toBe(1);
  });
});

describe("statusLine", () => {
  it("always shows model, mode (incl. default), thinking, and context", () => {
    const out = plain(
      statusLine({ model: "gpt-4o", mode: "default", used: 0, total: 128_000 }),
    );
    expect(out).toContain("gpt-4o");
    expect(out).toContain("default mode");
    expect(out).toContain("thinking off");
    expect(out).toContain("0% context");
  });

  it("reflects a non-default permission mode", () => {
    const out = plain(
      statusLine({ model: "gpt-4o", mode: "plan", used: 0, total: 128_000 }),
    );
    expect(out).toContain("plan mode");
  });

  it("shows the active thinking depth", () => {
    const out = plain(
      statusLine({
        model: "o3-mini",
        mode: "default",
        used: 0,
        total: 100,
        thinking: "high",
      }),
    );
    expect(out).toContain("thinking high");
  });

  it("shows context as a percentage at any fill level", () => {
    const low = plain(
      statusLine({ model: "m", mode: "default", used: 10, total: 100 }),
    );
    expect(low).toContain("10% context");
    const high = plain(
      statusLine({ model: "m", mode: "default", used: 62, total: 100 }),
    );
    expect(high).toContain("62% context");
  });

  it("shows one decimal place below one percent", () => {
    const out = plain(
      statusLine({ model: "m", mode: "default", used: 734, total: 1_000_000 }),
    );
    expect(out).toContain("0.1% context");
  });

  it("renders a single line", () => {
    const out = plain(
      statusLine({ model: "m", mode: "allowAll", used: 80, total: 100 }),
    );
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("formatContextPercent", () => {
  it("keeps 0% at zero", () => {
    expect(formatContextPercent(0, 100)).toBe("0%");
  });

  it("shows one decimal place between 0 and 1 percent", () => {
    expect(formatContextPercent(734, 1_000_000)).toBe("0.1%");
  });

  it("rounds to whole percents at or above one percent", () => {
    expect(formatContextPercent(12_300, 128_000)).toBe("10%");
  });
});
