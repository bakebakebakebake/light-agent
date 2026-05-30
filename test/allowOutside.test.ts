import { describe, it, expect } from "vitest";
import { resolveInWorkdir } from "../src/ui/../tools/read.js";
import { isAbsolute } from "node:path";

/**
 * Phase 9 (#9): allowAll mode lifts the workdir sandbox. The single confinement
 * boundary is resolveInWorkdir's `allowOutside` flag — these tests pin both the
 * default (confined) behavior and the lifted behavior so a regression in either
 * direction is caught.
 */
const WORK = "/work/proj";

describe("resolveInWorkdir confinement (default)", () => {
  it("accepts a path inside the workdir", () => {
    const r = resolveInWorkdir(WORK, "src/app.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe("/work/proj/src/app.ts");
  });

  it("rejects a relative path that escapes the workdir", () => {
    const r = resolveInWorkdir(WORK, "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("outside the working directory");
  });

  it("rejects an absolute path outside the workdir", () => {
    const r = resolveInWorkdir(WORK, "/etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects when the default flag is passed explicitly as false", () => {
    const r = resolveInWorkdir(WORK, "/etc/passwd", false);
    expect(r.ok).toBe(false);
  });
});

describe("resolveInWorkdir with allowOutside (allowAll mode)", () => {
  it("accepts an absolute path outside the workdir", () => {
    const r = resolveInWorkdir(WORK, "/etc/hosts", true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe("/etc/hosts");
  });

  it("accepts an escaping relative path, resolved to an absolute path", () => {
    const r = resolveInWorkdir(WORK, "../sibling/file.txt", true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isAbsolute(r.abs)).toBe(true);
      expect(r.abs).toBe("/work/sibling/file.txt");
    }
  });

  it("still resolves in-workdir paths normally", () => {
    const r = resolveInWorkdir(WORK, "src/app.ts", true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe("/work/proj/src/app.ts");
  });
});
