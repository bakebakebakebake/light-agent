import type { Message } from "../model/types.js";
import { renderMarkdown } from "./markdown.js";
import { firstLine } from "./format.js";
import { toolCallLine } from "./toolLine.js";
import { dim, cyan, red, symbols } from "./theme.js";

/**
 * Transcript re-renderer (A3 + B5).
 *
 * After /rewind or /resume mutates the shared history array, the OLD transcript
 * is still on screen, so the jump feels fake. This walks the reconstructed
 * history and reprints it exactly as the live renderer would — user prompts,
 * assistant markdown, and the compact tool-call / tool-result lines — so the
 * screen ends up showing precisely the state you jumped to (身临其境).
 *
 * `write` receives already-newline-free lines (the caller adds the newline), to
 * match the CommandContext.out contract used elsewhere.
 */
export function renderTranscript(
  history: Message[],
  write: (line: string) => void,
): void {
  for (const m of history) {
    if (m.role === "user") {
      renderUserMessage(m, write);
    } else {
      renderAssistantMessage(m, write);
    }
  }
}

/** A user message: plain text echoed under the `›` prompt; tool_results skipped
 * (they're shown attached to the assistant turn that produced the calls). */
function renderUserMessage(m: Message, write: (line: string) => void): void {
  const text = m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return; // a pure tool_result message — nothing to echo
  write(`${cyan(symbols.arrow)} ${text}`);
  write("");
}

/** An assistant message: markdown text, then any tool calls it issued. */
function renderAssistantMessage(m: Message, write: (line: string) => void): void {
  for (const b of m.content) {
    if (b.type === "text") {
      const rendered = renderMarkdown(b.text);
      if (rendered.trim()) write(rendered);
    } else if (b.type === "tool_use") {
      write(`  ${cyan(symbols.arrow)} ${toolCallLine(b.name, b.input)}`);
    }
  }
  write("");
}

/**
 * Look up the tool_result for a given tool_use id in the next user message.
 * Exposed for callers that want to attach results inline; the default
 * transcript keeps results lightweight, so this is a helper, not used above.
 */
export function findToolResult(
  history: Message[],
  toolUseId: string,
): { content: string; isError: boolean } | null {
  for (const m of history) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && b.toolUseId === toolUseId) {
        return { content: b.content, isError: b.isError };
      }
    }
  }
  return null;
}

/** Render a single tool-result line in the compact live-renderer style. */
export function toolResultLine(content: string, isError: boolean): string {
  const status = isError ? red(symbols.fail) : dim(symbols.ok);
  return `     ${status} ${dim(firstLine(content, 100))}`;
}
