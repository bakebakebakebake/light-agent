import { readFileSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/**
 * Read tool — read a file with optional pagination. See docs/02.
 *
 * Read-only and confined to the working directory, so it is low-risk and
 * concurrent-safe. Output is line-numbered (1-based) so the model can refer to
 * locations precisely, mirroring the convention coding agents use.
 */

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LEN = 2000;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path to the file to read. Relative paths resolve against the " +
        "working directory.",
    },
    offset: {
      type: "number",
      description: "1-based line number to start reading from (optional).",
    },
    limit: {
      type: "number",
      description: `Maximum number of lines to read (default ${DEFAULT_LIMIT}).`,
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const ArgsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * Resolve a user-supplied path against the workdir and reject anything that
 * escapes it. Centralizes the confinement check so every filesystem tool can
 * reuse it (docs/10).
 *
 * When `allowOutside` is true (only ever set in `allowAll` mode, #9) the escape
 * check is skipped and any resolvable path is accepted — the user has knowingly
 * lifted the workdir sandbox in exchange for full control. This is the single
 * security boundary for filesystem confinement, so the flag must be threaded
 * here rather than re-implemented per tool.
 */
export function resolveInWorkdir(
  workdir: string,
  inputPath: string,
  allowOutside = false,
): { ok: true; abs: string } | { ok: false; reason: string } {
  const abs = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workdir, inputPath);
  if (allowOutside) return { ok: true, abs };
  const rel = relative(workdir, abs);
  const escapes = rel.startsWith("..") || isAbsolute(rel);
  if (escapes) {
    return {
      ok: false,
      reason:
        `Path "${inputPath}" resolves outside the working directory ` +
        `(${workdir}). Only paths within the working directory are allowed.`,
    };
  }
  return { ok: true, abs };
}

function formatNumbered(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines
    .map((line, i) => {
      const n = String(start + i).padStart(width, " ");
      const truncated =
        line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + " …" : line;
      return `${n}\t${truncated}`;
    })
    .join("\n");
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a file from the working directory. Returns line-numbered content. " +
    "Use offset/limit to page through large files.",
  inputSchema,
  riskLevel: "low",
  concurrency: "concurrent",
  async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        isError: true,
        content:
          "Invalid arguments for read: " +
          parsed.error.issues.map((i) => i.message).join("; ") +
          '. Expected { path: string, offset?: number, limit?: number }.',
      };
    }
    const { path, offset, limit } = parsed.data;

    const resolved = resolveInWorkdir(ctx.workdir, path, ctx.allowOutsideWorkdir);
    if (!resolved.ok) {
      return { isError: true, content: resolved.reason };
    }

    let raw: string;
    try {
      raw = readFileSync(resolved.abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        code === "ENOENT"
          ? "File does not exist."
          : code === "EISDIR"
            ? "Path is a directory, not a file."
            : (err as Error).message;
      return {
        isError: true,
        content: `Could not read "${path}": ${hint}`,
      };
    }

    const allLines = raw.split("\n");
    // Drop the trailing empty element produced by a final newline so line
    // counts match what an editor shows.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    const total = allLines.length;

    if (total === 0) {
      return { isError: false, content: "(file is empty)" };
    }

    const start = offset ?? 1;
    if (start > total) {
      return {
        isError: true,
        content:
          `offset ${start} is past the end of the file ` +
          `(${total} lines). Use an offset between 1 and ${total}.`,
      };
    }
    const count = limit ?? DEFAULT_LIMIT;
    const slice = allLines.slice(start - 1, start - 1 + count);
    const body = formatNumbered(slice, start);

    const end = start - 1 + slice.length;
    const more =
      end < total
        ? `\n\n(showing lines ${start}-${end} of ${total}; ` +
          `pass offset=${end + 1} to continue)`
        : "";

    return { isError: false, content: body + more };
  },
};
