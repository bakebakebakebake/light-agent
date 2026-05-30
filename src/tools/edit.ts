import { readFileSync, writeFileSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type {
  ActionPreview,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.js";
import { resolveInWorkdir } from "./read.js";
import { colorizeDiff, diffBody } from "../ui/diff.js";

/**
 * Edit tool — exact string replacement (docs/02).
 *
 * The model supplies old_string and new_string; we replace by exact match,
 * never by line number (line numbers drift; exact substrings don't). For
 * safety old_string must be unique unless replace_all is set — otherwise we
 * return an info-rich error asking for more surrounding context.
 *
 * Editing has side effects, so it is exclusive and medium-risk: the gate shows
 * a diff before applying.
 */

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "File to edit (relative to workdir)." },
    old_string: {
      type: "string",
      description:
        "Exact text to replace. Must be unique in the file unless " +
        "replace_all is true. Include surrounding context to disambiguate.",
    },
    new_string: {
      type: "string",
      description: "Replacement text. Must differ from old_string.",
    },
    replace_all: {
      type: "boolean",
      description: "Replace every occurrence instead of requiring uniqueness.",
    },
  },
  required: ["path", "old_string", "new_string"],
  additionalProperties: false,
} as const;

const ArgsSchema = z
  .object({
    path: z.string().min(1),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .refine((a) => a.old_string !== a.new_string, {
    message: "old_string and new_string must differ",
  });

type Args = z.infer<typeof ArgsSchema>;

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Apply the edit in-memory. Pure and exported so the uniqueness logic is
 * directly unit-testable without touching the filesystem.
 */
export function applyEdit(
  source: string,
  args: Pick<Args, "old_string" | "new_string" | "replace_all">,
): { ok: true; result: string; replaced: number } | { ok: false; reason: string } {
  const { old_string, new_string, replace_all } = args;

  if (old_string === "") {
    return {
      ok: false,
      reason: "old_string is empty. Provide the exact text to replace.",
    };
  }

  const occurrences = countOccurrences(source, old_string);
  if (occurrences === 0) {
    return {
      ok: false,
      reason:
        "old_string not found. The file may have changed — re-read it and " +
        "retry with an exact substring that includes surrounding context.",
    };
  }
  if (occurrences > 1 && !replace_all) {
    return {
      ok: false,
      reason:
        `old_string is not unique (${occurrences} matches). Add more ` +
        "surrounding context to target a single location, or set " +
        "replace_all: true to replace every occurrence.",
    };
  }

  const result = replace_all
    ? source.split(old_string).join(new_string)
    : source.replace(old_string, new_string);
  return { ok: true, result, replaced: replace_all ? occurrences : 1 };
}

function makeDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must be unique unless " +
    "replace_all is set. Re-read the file first to get exact text.",
  inputSchema,
  riskLevel: "medium",
  concurrency: "exclusive",

  describeAction(rawInput: unknown, ctx: ToolContext): ActionPreview {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) return { summary: "Edit (invalid arguments)" };
    const { path } = parsed.data;
    const resolved = resolveInWorkdir(ctx.workdir, path, ctx.allowOutsideWorkdir);
    if (!resolved.ok) return { summary: `Edit ${path} (path rejected)` };
    let before = "";
    try {
      before = readFileSync(resolved.abs, "utf8");
    } catch {
      return { summary: `Edit ${path} (file unreadable)` };
    }
    const applied = applyEdit(before, parsed.data);
    if (!applied.ok) {
      return { summary: `Edit ${path}`, details: applied.reason };
    }
    return {
      summary: `Edit ${path} (${applied.replaced} replacement${applied.replaced === 1 ? "" : "s"})`,
      details: makeDiff(path, before, applied.result),
    };
  },

  async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        isError: true,
        content:
          "Invalid arguments for edit: " +
          parsed.error.issues.map((i) => i.message).join("; ") +
          ". Expected { path, old_string, new_string, replace_all? }.",
      };
    }
    const { path } = parsed.data;

    const resolved = resolveInWorkdir(ctx.workdir, path, ctx.allowOutsideWorkdir);
    if (!resolved.ok) return { isError: true, content: resolved.reason };

    let before: string;
    try {
      before = readFileSync(resolved.abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const hint = code === "ENOENT" ? "File does not exist." : (err as Error).message;
      return { isError: true, content: `Could not read "${path}": ${hint}` };
    }

    const applied = applyEdit(before, parsed.data);
    if (!applied.ok) {
      return { isError: true, content: `Edit failed in ${path}: ${applied.reason}` };
    }

    try {
      writeFileSync(resolved.abs, applied.result, "utf8");
    } catch (err) {
      return {
        isError: true,
        content: `Could not write "${path}": ${(err as Error).message}`,
      };
    }

    return {
      isError: false,
      content: `Edited ${path}: ${applied.replaced} replacement(s) applied.`,
      details: colorizeDiff(diffBody(makeDiff(path, before, applied.result))),
    };
  },
};
