import { describe, it, expect } from "vitest";
import { workdirLine, tildify } from "../src/ui/status.js";
import { homedir } from "node:os";

/** Strip ANSI so assertions read plainly. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("workdirLine (#10)", () => {
  it("shows the home-collapsed path and the branch with a glyph", () => {
    const line = plain(workdirLine({ workdir: "/work/proj", branch: "main" }));
    expect(line).toContain("/work/proj");
    expect(line).toContain("main");
    expect(line).toContain("⎇");
  });

  it("omits the branch portion when not in a repo (null branch)", () => {
    const line = plain(workdirLine({ workdir: "/work/proj", branch: null }));
    expect(line).toContain("/work/proj");
    expect(line).not.toContain("⎇");
  });

  it("collapses the home directory to ~", () => {
    const home = homedir();
    const line = plain(workdirLine({ workdir: `${home}/code`, branch: null }));
    expect(line).toContain("~/code");
    expect(line).not.toContain(home);
  });
});

describe("tildify", () => {
  it("replaces the home prefix with ~", () => {
    const home = homedir();
    expect(tildify(`${home}/x`)).toBe("~/x");
  });

  it("leaves non-home paths unchanged", () => {
    expect(tildify("/var/log")).toBe("/var/log");
  });
});
