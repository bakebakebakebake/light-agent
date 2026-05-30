import { cyan, dim } from "./theme.js";
import { summarizeInput } from "./format.js";
import { quoteForDisplay } from "../tools/bash.js";

/**
 * One-line label for a tool call in the minimal-prefix display style (#6):
 *  - bash → the shell-quoted command itself, e.g. `npm test` (most legible).
 *  - other tools → `name(arg-summary)`, e.g. `edit(path: "src/app.ts")`.
 *
 * Shared by the live renderer and the transcript re-renderer so a command looks
 * identical whether it's streaming or being reprinted after rewind/resume.
 */
export function toolCallLine(name: string, input: unknown): string {
  if (name === "bash") {
    const obj = (input ?? {}) as { command?: unknown; args?: unknown };
    if (typeof obj.command === "string") {
      const args = Array.isArray(obj.args)
        ? (obj.args.filter((a) => typeof a === "string") as string[])
        : [];
      return quoteForDisplay(obj.command, args);
    }
  }
  const summary = summarizeInput(input);
  return summary ? `${cyan(name)}${dim("(" + summary + ")")}` : cyan(name);
}
