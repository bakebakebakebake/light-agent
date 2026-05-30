import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
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
 * Write tool — create a new file or overwrite an existing one (docs/02).
 *
 * Edit can only replace text in a file that already exists, so creating files
 * (a brand-new module, a config, a test) was impossible with read/edit/bash
 * alone — closing that gap is the point of this tool. Parent directories are
 * created as needed. Writing has side effects, so it is exclusive and
 * medium-risk: the gate previews a diff (new file, or before→after) first.
 */

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File to write (relative to the working directory).",
    },
    content: {
      type: "string",
      description: "Full file contents. Overwrites the file if it exists.",
    },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

const ArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

function previewDiff(path: string, before: string | null, after: string): string {
  return createTwoFilesPatch(
    before === null ? "/dev/null" : path,
    path,
    before ?? "",
    after,
    "",
    "",
    { context: 3 },
  );
}

/** Read the current contents of a file, or null if it doesn't exist. */
function readIfExists(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export const writeTool: Tool = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one with the given content. " +
    "Parent directories are created automatically. Use edit for surgical " +
    "changes to a large existing file.",
  inputSchema,
  riskLevel: "medium",
  concurrency: "exclusive",

  describeAction(rawInput: unknown, ctx: ToolContext): ActionPreview {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) return { summary: "Write (invalid arguments)" };
    const { path, content } = parsed.data;
    const resolved = resolveInWorkdir(ctx.workdir, path, ctx.allowOutsideWorkdir);
    if (!resolved.ok) return { summary: `Write ${path} (path rejected)` };
    const before = readIfExists(resolved.abs);
    const verb = before === null ? "Create" : "Overwrite";
    return {
      summary: `${verb} ${path} (${content.split("\n").length} lines)`,
      details: previewDiff(path, before, content),
    };
  },

  async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        isError: true,
        content:
          "Invalid arguments for write: " +
          parsed.error.issues.map((i) => i.message).join("; ") +
          ". Expected { path: string, content: string }.",
      };
    }
    const { path, content } = parsed.data;

    const resolved = resolveInWorkdir(ctx.workdir, path, ctx.allowOutsideWorkdir);
    if (!resolved.ok) return { isError: true, content: resolved.reason };

    const existed = existsSync(resolved.abs);
    const before = existed ? readIfExists(resolved.abs) : null;
    try {
      mkdirSync(dirname(resolved.abs), { recursive: true });
      writeFileSync(resolved.abs, content, "utf8");
    } catch (err) {
      return {
        isError: true,
        content: `Could not write "${path}": ${(err as Error).message}`,
      };
    }

    const lines = content.split("\n").length;
    return {
      isError: false,
      content: `${existed ? "Overwrote" : "Created"} ${path} (${lines} lines).`,
      details: colorizeDiff(diffBody(previewDiff(path, before, content))),
    };
  },
};
