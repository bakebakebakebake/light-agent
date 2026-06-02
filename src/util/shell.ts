import { basename } from "node:path";
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
  /** Override which shell executable runs the command line. */
  shellPath?: string;
  /** Use a login shell so startup files and environment are loaded. */
  loginShell?: boolean;
  /** Use an interactive shell so aliases/functions are available. */
  interactiveShell?: boolean;
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

export interface ForegroundRunResult {
  exitCode: number | null;
  timedOut: boolean;
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

function shellArgv(
  shellPath: string,
  commandLine: string,
  opts: RunOptions,
): string[] {
  const shell = basename(shellPath);
  if (opts.loginShell && opts.interactiveShell) {
    if (shell === "bash" || shell === "zsh") return ["-ilc", commandLine];
    return ["-i", "-l", "-c", commandLine];
  }
  if (opts.loginShell) return ["-lc", commandLine];
  if (opts.interactiveShell) return ["-ic", commandLine];
  return ["-c", commandLine];
}

function shellName(shellPath: string): string {
  return basename(shellPath).toLowerCase();
}

function singleQuoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function foregroundCommandLine(
  shellPath: string,
  commandLine: string,
  opts: RunOptions,
): string {
  if (!opts.interactiveShell) return commandLine;
  const evalCommand = singleQuoteForShell(commandLine);
  const shell = shellName(shellPath);
  if (shell === "zsh") {
    return `source ~/.zprofile >/dev/null 2>&1 || true\nsource ~/.zshrc >/dev/null 2>&1 || true\neval -- ${evalCommand}`;
  }
  if (shell === "bash") {
    return `shopt -s expand_aliases\nsource ~/.bash_profile >/dev/null 2>&1 || source ~/.profile >/dev/null 2>&1 || true\nsource ~/.bashrc >/dev/null 2>&1 || true\neval -- ${evalCommand}`;
  }
  if (shell === "fish") {
    return `source ~/.config/fish/config.fish >/dev/null 2>&1; or true\neval ${evalCommand}`;
  }
  return commandLine;
}

export function foregroundShellArgv(
  shellPath: string,
  commandLine: string,
  opts: RunOptions,
): string[] {
  const wrapped = foregroundCommandLine(shellPath, commandLine, opts);
  if (opts.loginShell) return ["-lc", wrapped];
  return ["-c", wrapped];
}

/** Run a raw command line through the shell (interactive `!` mode path). */
export function runShell(commandLine: string, opts: RunOptions): Promise<RunResult> {
  const shellPath = opts.shellPath || process.env.SHELL;
  const useShellProgram = typeof shellPath === "string" && shellPath.trim() !== "";
  const child = useShellProgram
    ? spawn(
        shellPath!,
        shellArgv(shellPath!, commandLine, opts),
        {
          cwd: opts.cwd,
          shell: false,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      )
    : spawn(commandLine, {
        cwd: opts.cwd,
        shell: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
  return capture(child, commandLine, opts);
}

/** Run a raw command line in the true foreground, inheriting the user's TTY. */
export function runForegroundShell(
  commandLine: string,
  opts: RunOptions,
): Promise<ForegroundRunResult> {
  const shellPath = opts.shellPath || process.env.SHELL;
  const useShellProgram = typeof shellPath === "string" && shellPath.trim() !== "";
  return new Promise<ForegroundRunResult>((resolve) => {
    const child = useShellProgram
      ? spawn(shellPath!, foregroundShellArgv(shellPath!, commandLine, opts), {
          cwd: opts.cwd,
          shell: false,
          stdio: "inherit",
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
      : spawn(commandLine, {
          cwd: opts.cwd,
          shell: true,
          stdio: "inherit",
          ...(opts.signal ? { signal: opts.signal } : {}),
        });

    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    const finish = (result: ForegroundRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      const hint =
        e.code === "ENOENT"
          ? `command not found: "${commandLine}"`
          : e.code === "ABORT_ERR"
            ? "command was interrupted"
            : e.message;
      finish({ exitCode: null, timedOut: false, error: hint });
    });

    child.on("close", (code, signal) => {
      finish({ exitCode: code, timedOut: signal === "SIGKILL" });
    });
  });
}
