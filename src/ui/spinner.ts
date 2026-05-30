import { dim, cyan } from "./theme.js";

/**
 * A tiny braille spinner for "thinking…" between turns (docs/08).
 *
 * TTY-guarded: when stdout isn't a terminal (pipes, CI), it no-ops so logs stay
 * clean. Zero dependencies — a setInterval rewriting the current line with \r.
 * The renderer starts it on turn_start and stops it the moment real output
 * (text or a tool call) begins, so the spinner never collides with content.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = "";
  private readonly enabled = process.stdout.isTTY === true;

  /** Begin animating with a label. Idempotent — a second start re-labels. */
  start(label = "thinking"): void {
    this.label = label;
    if (!this.enabled) return;
    if (this.timer) return;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
    // Don't keep the event loop alive just for the spinner.
    this.timer.unref?.();
  }

  /**
   * Stop animating and clear the line so following output starts clean.
   *
   * Only writes the clear-line escape when the spinner was actually running.
   * The renderer calls stop() on every text_delta to make sure the spinner is
   * gone before streaming content; without this guard each chunk would erase
   * the previous one (the reply collapses to a few characters).
   */
  stop(): void {
    if (!this.timer) return; // not running → nothing to clear; leave output intact
    clearInterval(this.timer);
    this.timer = null;
    if (this.enabled) process.stdout.write("\r\x1b[2K");
  }

  private render(): void {
    const frame = FRAMES[this.frame] ?? "⠋";
    process.stdout.write(`\r\x1b[2K${cyan(frame)} ${dim(this.label + "…")}`);
  }
}
