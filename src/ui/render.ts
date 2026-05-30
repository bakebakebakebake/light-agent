import type { LoopEvent } from "../loop/types.js";
import type { Usage } from "../model/types.js";
import { dim, cyan, red, yellow, gray, symbols } from "./theme.js";
import { Spinner } from "./spinner.js";
import { MarkdownStream } from "./markdown.js";
import { firstLine } from "./format.js";
import { toolCallLine } from "./toolLine.js";

/**
 * Terminal renderer for loop events (docs/08).
 *
 * Restrained narration: stream assistant text as it arrives, show tool calls
 * compactly so the process is transparent, and keep everything else quiet.
 * No "Now I'll…" chatter — the events themselves are the narration.
 *
 * A spinner runs between turns and is cleared the moment real output (text or a
 * tool call) starts, so "thinking…" never collides with content.
 *
 * Assistant text is rendered as markdown (feature #1): deltas feed a
 * line-buffered MarkdownStream that styles headings/lists/quotes/code/inline
 * emphasis before writing. The stream is flushed whenever text ends (a tool
 * call, completion, or error) so partial lines are never lost.
 */
export class Renderer {
  private inText = false;
  private inReasoning = false;
  private md: MarkdownStream | null = null;
  private readonly spinner = new Spinner();
  private readonly onUsage: ((usage: Usage) => void) | undefined;

  /** `onUsage` is called once per turn with that turn's token usage (#7). */
  constructor(opts?: { onUsage?: (usage: Usage) => void }) {
    this.onUsage = opts?.onUsage;
  }

  /** Render a single loop event. */
  on(ev: LoopEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.spinner.start("thinking");
        break;

      case "reasoning":
        this.spinner.stop();
        if (!this.inReasoning) {
          // One-time dim header, then stream reasoning dimmed and indented so
          // it reads as separate from the answer (A1).
          process.stdout.write(gray("  ✻ thinking\n  "));
          this.inReasoning = true;
        }
        process.stdout.write(gray(ev.text.replace(/\n/g, "\n  ")));
        break;

      case "text_delta":
        this.spinner.stop();
        this.endReasoning();
        if (!this.md) {
          this.md = new MarkdownStream((s) => process.stdout.write(s));
        }
        this.inText = true;
        this.md.push(ev.text);
        break;

      case "tool_call": {
        this.spinner.stop();
        this.endReasoning();
        this.endText();
        process.stdout.write(`  ${cyan(symbols.arrow)} ${toolCallLine(ev.name, ev.input)}\n`);
        break;
      }

      case "tool_result": {
        const status = ev.isError ? red(symbols.fail) : dim(symbols.ok);
        const preview = firstLine(ev.content, 100);
        process.stdout.write(`    ${status} ${dim(preview)}\n`);
        // Terminal-only detail (e.g. a colored diff after edit/write, #2),
        // indented beneath the result line. Never sent to the model.
        if (ev.details && ev.details.trim()) {
          const body = ev.details
            .split("\n")
            .map((l) => "      " + l)
            .join("\n");
          process.stdout.write(body + "\n");
        }
        break;
      }

      case "usage":
        // Surface token usage to the caller (status line); stay quiet on screen.
        this.onUsage?.(ev.usage);
        break;

      case "error":
        this.spinner.stop();
        this.endReasoning();
        this.endText();
        process.stdout.write(
          red(`\n  ${symbols.fail} ${ev.message}`) +
            (ev.retryable ? yellow(" (retryable)") : "") +
            "\n",
        );
        break;

      case "done":
        this.spinner.stop();
        this.endReasoning();
        this.endText();
        if (ev.reason === "max_turns") {
          process.stdout.write(
            yellow(`\n  [stopped: reached the ${ev.turns}-turn limit]\n`),
          );
        } else if (ev.reason === "aborted") {
          process.stdout.write(yellow("\n  [interrupted]\n"));
        }
        break;
    }
  }

  /** Close out a reasoning block (separates thinking from the answer). */
  private endReasoning(): void {
    if (this.inReasoning) {
      process.stdout.write("\n");
      this.inReasoning = false;
    }
  }

  /** Close out any in-progress assistant text with a newline. */
  private endText(): void {
    if (this.inText) {
      // Flush any buffered partial markdown line, then end the block.
      if (this.md) {
        this.md.flush();
        this.md = null;
      }
      process.stdout.write("\n");
      this.inText = false;
    }
  }

  /** Print a notification for a "notify"-tier action (docs/04). */
  notify(summary: string): void {
    this.spinner.stop();
    this.endText();
    process.stdout.write(dim(`  ${symbols.bullet} ${summary}\n`));
  }
}
