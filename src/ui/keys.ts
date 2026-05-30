import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";

/**
 * Raw keypress source (B1).
 *
 * The single stdin consumer for the whole app. The historic double-echo bug
 * came from a readline `Interface` AND raw mode both reading stdin; here we use
 * ONLY `emitKeypressEvents` (a parse-only helper that never writes/echoes) plus
 * `setRawMode(true)`. Nothing else consumes stdin, so echo is fully ours to
 * control and the menu/editor can redraw freely.
 *
 * Bracketed paste (`\x1b[?2004h`) lets us distinguish typed Enter from pasted
 * newlines: while a paste is in progress we buffer newlines as text instead of
 * submitting. An exit handler always restores cooked mode + disables bracketed
 * paste so a crash never leaves the terminal wedged.
 */

/** A normalized key event (mirrors Node's readline keypress `key`). */
export interface Key {
  name?: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export type KeyHandler = (str: string | undefined, key: Key) => void;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export class KeySource {
  private handler: KeyHandler | null = null;
  private started = false;
  private restoreOnExit: (() => void) | null = null;
  /** True between bracketed-paste start/end markers. */
  pasting = false;

  /** True when attached to a real interactive terminal. */
  get isTTY(): boolean {
    return Boolean(stdin.isTTY);
  }

  /** Begin raw mode + keypress parsing. Idempotent. */
  start(): void {
    if (this.started || !this.isTTY) return;
    this.started = true;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?2004h"); // enable bracketed paste
    stdin.on("keypress", this.onKeypress);

    // Always restore the terminal, even on crash.
    this.restoreOnExit = () => {
      try {
        stdout.write("\x1b[?2004l");
        if (stdin.isTTY) stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    };
    process.on("exit", this.restoreOnExit);
  }

  /** Restore cooked mode and detach. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    stdin.off("keypress", this.onKeypress);
    if (this.restoreOnExit) {
      process.off("exit", this.restoreOnExit);
      this.restoreOnExit();
      this.restoreOnExit = null;
    }
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }

  /** Route subsequent keypresses to `handler` (replaces any previous one). */
  onKey(handler: KeyHandler | null): void {
    this.handler = handler;
  }

  private onKeypress = (str: string | undefined, key: Key | undefined): void => {
    const k: Key = key ?? { sequence: str ?? "", ctrl: false, meta: false, shift: false };
    // Detect bracketed-paste boundaries so newlines inside a paste are text.
    if (k.sequence === PASTE_START) {
      this.pasting = true;
      return;
    }
    if (k.sequence === PASTE_END) {
      this.pasting = false;
      return;
    }
    this.handler?.(str, k);
  };
}
