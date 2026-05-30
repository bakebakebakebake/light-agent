import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveInWorkdir } from "./read.js";

/**
 * Ls tool — list a directory's contents (docs/02).
 *
 * Read-only and confined to the working directory, so it is low-risk and
 * concurrent. Lets the agent orient itself in an unfamiliar tree without
 * shelling out. Directories are marked with a trailing "/" and sorted first;
 * file sizes are shown so the model can judge what's worth reading.
 */

const MAX_ENTRIES = 500;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Directory to list (relative to workdir). Defaults to the working " +
        "directory root.",
    },
    all: {
      type: "boolean",
      description: "Include dotfiles (default false).",
    },
  },
  additionalProperties: false,
} as const;

const ArgsSchema = z.object({
  path: z.string().optional(),
  all: z.boolean().optional(),
});

/** Human-readable byte size: 1536 → "1.5K". */
function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

export const lsTool: Tool = {
  name: "ls",
  description:
    "List the contents of a directory in the working directory. Directories " +
    "are marked with a trailing slash; file sizes are shown.",
  inputSchema,
  riskLevel: "low",
  concurrency: "concurrent",

  async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        isError: true,
        content:
          "Invalid arguments for ls: " +
          parsed.error.issues.map((i) => i.message).join("; ") +
          ". Expected { path?: string, all?: boolean }.",
      };
    }
    const { path, all } = parsed.data;

    const resolved = resolveInWorkdir(ctx.workdir, path ?? ".", ctx.allowOutsideWorkdir);
    if (!resolved.ok) return { isError: true, content: resolved.reason };

    let entries: string[];
    try {
      const st = statSync(resolved.abs);
      if (!st.isDirectory()) {
        return {
          isError: true,
          content: `"${path ?? "."}" is not a directory. Use read for files.`,
        };
      }
      entries = readdirSync(resolved.abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const hint = code === "ENOENT" ? "Directory does not exist." : (err as Error).message;
      return { isError: true, content: `Could not list "${path ?? "."}": ${hint}` };
    }

    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (!all && entry.startsWith(".")) continue;
      const full = join(resolved.abs, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        dirs.push(`${entry}/`);
      } else {
        files.push(`${entry}  ${humanSize(st.size)}`);
      }
    }
    dirs.sort();
    files.sort();
    const all2 = [...dirs, ...files];
    const truncated = all2.length > MAX_ENTRIES;
    const shown = all2.slice(0, MAX_ENTRIES);

    const rel = relative(ctx.workdir, resolved.abs) || ".";
    if (shown.length === 0) {
      return { isError: false, content: `${rel}/ is empty.` };
    }
    const footer = truncated ? `\n\n(${all2.length} entries; showing first ${MAX_ENTRIES})` : "";
    return { isError: false, content: `${rel}/\n` + shown.join("\n") + footer };
  },
};
