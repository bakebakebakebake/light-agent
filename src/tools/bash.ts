import { z } from "zod";
import type {
  ActionPreview,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.js";
import { runProcess, DEFAULT_MAX_OUTPUT } from "../util/shell.js";

/**
 * Bash tool — the most powerful and most dangerous tool (docs/02, docs/10).
 *
 * The cage:
 *  - runs in the working directory (cwd), never elsewhere;
 *  - hard timeout, so a hung command can't wedge the agent;
 *  - parameterized argv via spawn() — the command and its args are passed as
 *    an array, NOT interpolated into a shell string, so model-supplied values
 *    can't inject extra commands;
 *  - captured output is size-capped to protect the context window.
 *
 * The spawn/capture/timeout engine lives in util/shell.ts (shared with the
 * interactive `!` shell mode, #5); this tool owns the model-facing schema,
 * validation, and result formatting.
 *
 * High-risk: the gate confirms with a real user before anything runs.
 */

const MAX_OUTPUT = DEFAULT_MAX_OUTPUT;

const inputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The executable to run, e.g. 'npm', 'ls', 'git'.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description:
        "Arguments as a list of strings, e.g. ['run','test']. Passed " +
        "directly to the process — they are NOT parsed by a shell, so each " +
        "argument must be a separate element (no shell operators).",
    },
    timeout_ms: {
      type: "number",
      description: "Optional per-command timeout in milliseconds.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const ArgsSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n… [output truncated at ${MAX_OUTPUT} chars]`;
}

export function quoteForDisplay(command: string, args: string[]): string {
  const parts = [command, ...args].map((p) =>
    /[^\w./:=-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p,
  );
  return parts.join(" ");
}

export interface BashOptions {
  /** Default timeout if the call doesn't specify one. */
  defaultTimeoutMs: number;
}

export function createBashTool(opts: BashOptions): Tool {
  return {
    name: "bash",
    description:
      "Run a command in the working directory. Provide the executable in " +
      "`command` and arguments as a list in `args` (no shell string). " +
      "Confined to the working directory with a timeout.",
    inputSchema,
    riskLevel: "high",
    concurrency: "exclusive",

    describeAction(rawInput: unknown): ActionPreview {
      const parsed = ArgsSchema.safeParse(rawInput);
      if (!parsed.success) return { summary: "Run command (invalid arguments)" };
      const { command, args = [] } = parsed.data;
      return { summary: `Run: ${quoteForDisplay(command, args)}` };
    },

    async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = ArgsSchema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          isError: true,
          content:
            "Invalid arguments for bash: " +
            parsed.error.issues.map((i) => i.message).join("; ") +
            ". Expected { command: string, args?: string[], timeout_ms?: number }.",
        };
      }
      const { command, args = [], timeout_ms } = parsed.data;
      const timeout = timeout_ms ?? opts.defaultTimeoutMs;

      const r = await runProcess(command, args, {
        cwd: ctx.workdir,
        timeoutMs: timeout,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (r.error) {
        return { isError: true, content: `Failed to run command: ${r.error}` };
      }
      const head = r.timedOut
        ? `Command timed out after ${timeout}ms and was killed.`
        : `Exit code: ${r.exitCode ?? "null"}`;
      const body =
        (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
        (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
      return {
        isError: r.timedOut || (r.exitCode ?? 1) !== 0,
        content: head + body,
      };
    },
  };
}
