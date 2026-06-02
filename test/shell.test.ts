import { describe, it, expect } from "vitest";
import {
  foregroundCommandLine,
  foregroundShellArgv,
  runProcess,
  runShell,
} from "../src/util/shell.js";

const cwd = process.cwd();

describe("runProcess (argv, shell:false)", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runProcess("node", ["-e", "process.stdout.write('hi')"], {
      cwd,
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it("captures stderr and a non-zero exit code", async () => {
    const r = await runProcess(
      "node",
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      { cwd, timeoutMs: 5000 },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("boom");
  });

  it("reports a spawn error for a missing command", async () => {
    const r = await runProcess("definitely-not-a-real-binary-xyz", [], {
      cwd,
      timeoutMs: 5000,
    });
    expect(r.error).toBeDefined();
    expect(r.error).toContain("command not found");
  });

  it("does NOT interpret shell metacharacters (no injection)", async () => {
    // With shell:false the ';' and '&&' are literal args, not operators.
    const r = await runProcess("node", ["-e", "console.log(process.argv[1])", "; rm -rf /"], {
      cwd,
      timeoutMs: 5000,
    });
    // The malicious-looking arg is just data passed to node; nothing executes it.
    expect(r.exitCode).toBe(0);
  });

  it("times out and kills a hung process", async () => {
    const r = await runProcess("node", ["-e", "setTimeout(()=>{}, 10000)"], {
      cwd,
      timeoutMs: 150,
    });
    expect(r.timedOut).toBe(true);
  });

  it("caps output at maxOutput", async () => {
    const r = await runProcess(
      "node",
      ["-e", "process.stdout.write('x'.repeat(100))"],
      { cwd, timeoutMs: 5000, maxOutput: 10 },
    );
    expect(r.stdout).toContain("truncated");
    expect(r.stdout.startsWith("xxxxxxxxxx")).toBe(true);
  });
});

describe("runShell (raw line, shell:true)", () => {
  it("runs a command line through the shell", async () => {
    const r = await runShell("echo hello", { cwd, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("interprets shell features like pipes", async () => {
    const r = await runShell("echo one two three | wc -w", { cwd, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("3");
  });

  it("propagates a non-zero exit status", async () => {
    const r = await runShell("exit 7", { cwd, timeoutMs: 5000 });
    expect(r.exitCode).toBe(7);
  });
});

describe("foreground shell wrappers", () => {
  it("sources zsh startup files, then evals the command so aliases can expand", () => {
    const argv = foregroundShellArgv("/bin/zsh", "ll", {
      cwd,
      timeoutMs: 5000,
      loginShell: true,
      interactiveShell: true,
    });
    expect(argv[0]).toBe("-lc");
    expect(argv[1]).toContain("source ~/.zprofile");
    expect(argv[1]).toContain("source ~/.zshrc");
    expect(argv[1]).toContain("eval -- 'll'");
    expect(argv[1]).not.toContain("-ilc");
  });

  it("enables alias expansion for bash foreground commands, then evals the line", () => {
    const command = foregroundCommandLine("/bin/bash", "ll", {
      cwd,
      timeoutMs: 5000,
      interactiveShell: true,
    });
    expect(command).toContain("shopt -s expand_aliases");
    expect(command).toContain("source ~/.bash_profile");
    expect(command).toContain("source ~/.bashrc");
    expect(command).toContain("eval -- 'll'");
  });
});
