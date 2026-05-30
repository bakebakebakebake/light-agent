import { spawn, type ChildProcess } from "node:child_process";

/**
 * Shared process-execution core (#5, docs/10).
 *
 * Two entry points over one capture engine:
 *  - runProcess(command, args): parameterized argv, shell:false. Used by the
 *    bash TOOL, where the model supplies the values — no shell string means
 *    model output can't inject extra commands.
 *  - runShell(commandLine): the raw line run through the user's shell. Used by
 *    interactive `!` mode, where the human typed the command themselves (same
 *    trust as their own terminal), so shell features (pipes, globs) are wanted.
 *
 * Both enforce a hard timeout and cap captured output so a runaway command
 * can't wedge the agent or flood the context window.
 */

/** Default per-stream output cap (chars) before truncation. */
export const DEFAULT_MAX_OUTPUT = 30_000;

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-stream output cap; defaults to DEFAULT_MAX_OUTPUT. */
  maxOutput?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** True if the timeout fired and we SIGKILLed the process. */
  timedOut: boolean;
  /** Spawn-level failure (e.g. command not found), already humanized. */
  error?: string;
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [output truncated at ${max} chars]`;
}

/** Capture stdout/stderr/exit from an already-spawned child, with a timeout. */
function capture(
  child: ChildProcess,
  commandLabel: string,
  opts: RunOptions,
): Promise<RunResult> {
  const max = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString();
    });

    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      const hint =
        e.code === "ENOENT"
          ? `command not found: "${commandLabel}"`
          : e.code === "ABORT_ERR"
            ? "command was interrupted"
            : e.message;
      finish({ stdout, stderr, exitCode: null, timedOut: false, error: hint });
    });

    child.on("close", (code, signal) => {
      const timedOut = signal === "SIGKILL";
      finish({
        stdout: cap(stdout, max),
        stderr: cap(stderr, max),
        exitCode: code,
        timedOut,
      });
    });
  });
}

/** Run a parameterized argv with shell:false (bash tool path). */
export function runProcess(
  command: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    shell: false,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return capture(child, command, opts);
}

/** Run a raw command line through the shell (interactive `!` mode path). */
export function runShell(commandLine: string, opts: RunOptions): Promise<RunResult> {
  const child = spawn(commandLine, {
    cwd: opts.cwd,
    shell: true,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return capture(child, commandLine, opts);
}
