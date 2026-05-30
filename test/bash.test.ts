import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../src/tools/bash.js";
import type { ToolContext } from "../src/tools/types.js";

let dir: string;
let ctx: ToolContext;
const bash = createBashTool({ defaultTimeoutMs: 5000 });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-bash-"));
  ctx = { workdir: dir };
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bash tool — parameterized, caged execution", () => {
  it("runs a simple command and captures stdout", async () => {
    const r = await bash.execute({ command: "echo", args: ["hello"] }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
  });

  it("runs in the working directory", async () => {
    writeFileSync(join(dir, "marker.txt"), "x", "utf8");
    const r = await bash.execute({ command: "ls", args: [] }, ctx);
    expect(r.content).toContain("marker.txt");
  });

  it("does NOT interpret shell metacharacters in args (injection safety)", async () => {
    // If args were interpolated into a shell, this would create pwned.txt.
    // With parameterized argv + shell:false, ';' is just a literal argument.
    const r = await bash.execute(
      { command: "echo", args: ["safe; touch pwned.txt"] },
      ctx,
    );
    expect(r.isError).toBe(false);
    // the literal string is echoed verbatim...
    expect(r.content).toContain("safe; touch pwned.txt");
    // ...and no second command ran:
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
  });

  it("reports a non-zero exit code as an error", async () => {
    const r = await bash.execute(
      { command: "node", args: ["-e", "process.exit(3)"] },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Exit code: 3");
  });

  it("returns an info-rich error for a missing command", async () => {
    const r = await bash.execute(
      { command: "definitely-not-a-real-binary-xyz", args: [] },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("command not found");
  });

  it("kills a command that exceeds the timeout", async () => {
    const r = await bash.execute(
      { command: "node", args: ["-e", "setTimeout(()=>{}, 60000)"], timeout_ms: 200 },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timed out");
  });

  it("previews the command without a shell string", () => {
    const preview = bash.describeAction?.(
      { command: "npm", args: ["run", "test"] },
      ctx,
    );
    expect(preview?.summary).toBe("Run: npm run test");
  });
});
