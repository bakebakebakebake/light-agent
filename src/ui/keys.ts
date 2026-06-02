import { stdin, stdout } from "node:process";

/**
 * Raw key source.
 *
 * We parse raw stdin bytes directly so a lone Esc can be emitted immediately,
 * instead of waiting for Node's keypress escape-sequence timeout. This keeps
 * picker/menu close actions responsive while still handling arrows, home/end,
 * delete, bracketed paste, Ctrl chords, and simple Alt combinations.
 */

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

const CSI_NAMES = new Map<string, string>([
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1bOH", "home"],
  ["\x1bOF", "end"],
  ["\x1b[3~", "delete"],
  ["\x1b[Z", "tab"],
]);

function emitPrintable(handler: KeyHandler | null, text: string, meta = false): void {
  if (!text) return;
  handler?.(text, {
    name: text,
    sequence: meta ? "\x1b" + text : text,
    ctrl: false,
    meta,
    shift: false,
  });
}

function emitNamed(
  handler: KeyHandler | null,
  name: string,
  sequence: string,
  opts: Partial<Key> = {},
): void {
  handler?.(undefined, {
    name,
    sequence,
    ctrl: opts.ctrl ?? false,
    meta: opts.meta ?? false,
    shift: opts.shift ?? false,
  });
}

function ctrlName(byte: number): string | null {
  if (byte >= 1 && byte <= 26) {
    return String.fromCharCode(96 + byte);
  }
  return null;
}

function isIncompleteEscape(sequence: string): boolean {
  return [
    "\x1b[",
    "\x1bO",
    "\x1b[1",
    "\x1b[2",
    "\x1b[3",
    "\x1b[4",
    "\x1b[5",
    "\x1b[6",
    "\x1b[7",
    "\x1b[8",
    "\x1b[9",
    "\x1b[1;",
    "\x1b[2;",
    "\x1b[3;",
    "\x1b[4;",
    "\x1b[5;",
    "\x1b[6;",
    "\x1b[7;",
    "\x1b[8;",
    "\x1b[9;",
    "\x1b[200",
    "\x1b[201",
  ].includes(sequence);
}

export class KeySource {
  private handler: KeyHandler | null = null;
  private started = false;
  private restoreOnExit: (() => void) | null = null;
  private pending = "";
  pasting = false;

  get isTTY(): boolean {
    return Boolean(stdin.isTTY);
  }

  start(): void {
    if (this.started || !this.isTTY) return;
    this.started = true;
    this.enableTerminalCapture();

    this.restoreOnExit = () => {
      try {
        this.disableTerminalCapture();
      } catch {
        /* ignore */
      }
    };
    process.on("exit", this.restoreOnExit);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.disableTerminalCapture();
    this.pending = "";
    if (this.restoreOnExit) {
      process.off("exit", this.restoreOnExit);
      this.restoreOnExit();
      this.restoreOnExit = null;
    }
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }

  onKey(handler: KeyHandler | null): void {
    this.handler = handler;
  }

  /**
   * Temporarily give stdin/stdout back to a foreground child process.
   * Returns a restore function that resumes raw capture.
   */
  suspend(): () => void {
    if (!this.started || !this.isTTY) return () => {};
    this.disableTerminalCapture();
    this.pending = "";
    return () => {
      if (!this.started || !this.isTTY) return;
      this.enableTerminalCapture();
    };
  }

  private enableTerminalCapture(): void {
    if (!this.isTTY) return;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?2004h");
    stdin.on("data", this.onData);
  }

  private disableTerminalCapture(): void {
    stdin.off("data", this.onData);
    stdout.write("\x1b[?2004l");
    if (stdin.isTTY) stdin.setRawMode(false);
  }

  private onData = (chunk: Buffer): void => {
    this.pending += chunk.toString("utf8");
    this.flushPending();
  };

  private flushPending(): void {
    while (this.pending.length > 0) {
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      if (this.pending.startsWith(PASTE_END)) {
        this.pending = this.pending.slice(PASTE_END.length);
        this.pasting = false;
        continue;
      }

      const matchedEscape = [...CSI_NAMES.entries()].find(([seq]) => this.pending.startsWith(seq));
      if (matchedEscape) {
        const [seq, name] = matchedEscape;
        this.pending = this.pending.slice(seq.length);
        emitNamed(this.handler, name, seq);
        continue;
      }

      if (this.pending[0] === "\x1b") {
        if (this.pending.length === 1) {
          this.pending = "";
          emitNamed(this.handler, "escape", "\x1b");
          continue;
        }
        const seq = this.pending.slice(0, Math.min(this.pending.length, 8));
        if (isIncompleteEscape(seq)) return;

        const next = this.pending[1] ?? "";
        if (next && next !== "[" && next !== "O") {
          this.pending = this.pending.slice(2);
          if (next === "\r" || next === "\n") {
            emitNamed(this.handler, "return", "\x1b" + next, { meta: true });
          } else {
            emitPrintable(this.handler, next, true);
          }
          continue;
        }

        this.pending = this.pending.slice(1);
        emitNamed(this.handler, "escape", "\x1b");
        continue;
      }

      const first = this.pending.codePointAt(0);
      if (first === undefined) break;
      const ch = String.fromCodePoint(first);
      this.pending = this.pending.slice(ch.length);

      if (ch === "\r" || ch === "\n") {
        emitNamed(this.handler, "return", ch);
        continue;
      }
      if (ch === "\t") {
        emitNamed(this.handler, "tab", ch);
        continue;
      }
      if (ch === "\u007f") {
        emitNamed(this.handler, "backspace", ch);
        continue;
      }
      if (ch < " " || ch === "\u0000") {
        const name = ctrlName(first);
        if (name) emitNamed(this.handler, name, ch, { ctrl: true });
        continue;
      }
      emitPrintable(this.handler, ch);
    }
  }
}
