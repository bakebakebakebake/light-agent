import { describe, it, expect } from "vitest";
import { applyEdit } from "../src/tools/edit.js";

describe("applyEdit — exact string replacement + uniqueness", () => {
  it("replaces a unique occurrence", () => {
    const r = applyEdit("const a = 1;\nconst b = 2;", {
      old_string: "const a = 1;",
      new_string: "const a = 42;",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toContain("const a = 42;");
      expect(r.replaced).toBe(1);
    }
  });

  it("refuses a non-unique old_string unless replace_all is set", () => {
    const src = "x\nx\nx";
    const r = applyEdit(src, { old_string: "x", new_string: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not unique");
  });

  it("replaces every occurrence with replace_all", () => {
    const r = applyEdit("x\nx\nx", {
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toBe("y\ny\ny");
      expect(r.replaced).toBe(3);
    }
  });

  it("returns an info-rich error when old_string is absent", () => {
    const r = applyEdit("hello", { old_string: "world", new_string: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not found");
  });

  it("rejects an empty old_string", () => {
    const r = applyEdit("hello", { old_string: "", new_string: "x" });
    expect(r.ok).toBe(false);
  });

  it("only replaces the first match when unique-but-overlapping context given", () => {
    // distinct surrounding context makes the target unique
    const src = "foo(a)\nfoo(b)";
    const r = applyEdit(src, { old_string: "foo(a)", new_string: "foo(z)" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("foo(z)\nfoo(b)");
  });
});
