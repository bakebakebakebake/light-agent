import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { KeySource } from "./keys.js";
import { runEditor, type EditorMenuItem } from "./lineEditor.js";
import { visibleWidth } from "./theme.js";

/**
 * Interactive line input (docs/08, B1+B3+B4).
 *
 * A thin façade over the raw-mode line editor. There is exactly ONE stdin
 * consumer (KeySource), which structurally prevents the historic double-echo
 * bug (raw mode + a readline Interface fighting over stdin). Raw mode alone does
 * NOT break native selection/copy — only mouse-reporting would, and we never
 * enable it.
 *
 * Capabilities the editor unlocks: a live arrow-navigable `/` command menu,
 * post-command pickers (`pick`), multiline input (Alt+Enter / trailing `\`),
 * and Ctrl-C that interrupts/cancels but never exits (exit is `/exit` only).
 *
 * Non-TTY fallback (pipes / CI): a plain line-buffered readline reader with no
 * raw mode and no menus, so scripted input and tests keep working.
 */

export type Completer = (line: string) => string[];

/** An item shown in the `/` menu or a picker. */
export interface MenuItem {
  label: string;
  value: string;
  hint?: string;
  selectable?: boolean;
  tone?: "green" | "dim";
}

export interface PromptPresentation {
  prefixLines: string[];
  prompt: string;
}

/** Split a long or multiline question into a preface plus a short inline prompt. */
export function splitPromptPresentation(
  prompt: string,
  cols = stdout.columns ?? 80,
): PromptPresentation {
  const lines = prompt.split(/\r\n|\r|\n/);
  if (lines.length > 1) {
    return {
      prefixLines: lines.map((line) => line.trimEnd()),
      prompt: "> ",
    };
  }

  const single = lines[0] ?? prompt;
  const maxInline = Math.max(24, Math.floor(cols / 2));
  if (visibleWidth(single) > maxInline) {
    return { prefixLines: [single.trimEnd()], prompt: "> " };
  }

  return { prefixLines: [], prompt: single };
}

export interface LineReaderOptions {
  /** Tab/`/` completion candidates (bare command strings). */
  complete?: Completer;
  /** Rich candidates for the live `/` menu; null closes it. */
  menu?: (buffer: string) => MenuItem[] | null;
  /** Candidates for the `@` file-mention menu (#4); null closes it. */
  fileMenu?: (query: string) => MenuItem[] | null;
  /** Candidates for the `#` skill picker; null closes it. */
  skillMenu?: (query: string) => MenuItem[] | null;
  /** Called when a `#` skill is attached inline to the current draft. */
  attachSkill?: (skillName: string) => void;
  /** Called when the user backspaces an empty draft to drop the last attached skill. */
  detachLastSkill?: () => boolean;
  /** Session-plan-mode probe; tints the input frame cyan (#8/#9). */
  planMode?: () => boolean;
  /** Persistent footer row (workdir + branch) beneath the frame (#10). */
  footer?: () => string;
  /** Visible labels for next-turn context like selected skills. */
  badges?: () => string[];
}

export class LineReader {
  private readonly keys = new KeySource();
  private readonly history: string[] = [];
  private readonly opts: LineReaderOptions;
  /** Set when a double Ctrl-C on an empty prompt asked to quit (#7). The REPL
   * checks this after `ask` returns "" to break its loop. */
  exitRequested = false;

  constructor(opts: LineReaderOptions = {}) {
    this.opts = opts;
    this.keys.start();
  }

  get isTTY(): boolean {
    return this.keys.isTTY;
  }

  /** Prompt for a normal line. Submitted non-empty lines join the history.
   * Pass `seed` to pre-fill the buffer (e.g. refilling an interrupted question
   * after a mid-stream Ctrl-C, #7). A double Ctrl-C on an empty prompt sets
   * `exitRequested` and resolves with "" so the REPL can quit. */
  async ask(prompt: string, seed?: string): Promise<string> {
    if (!this.isTTY) return this.askFallback(prompt);
    const present = splitPromptPresentation(prompt, stdout.columns ?? 80);
    for (const line of present.prefixLines) stdout.write(line + "\n");
    const menu = this.opts.menu
      ? (buf: string): EditorMenuItem[] | null => {
          const items = this.opts.menu!(buf);
          return items
            ? items.map((m) => ({
                label: m.label,
                value: m.value,
                hint: m.hint,
                selectable: m.selectable,
                tone: m.tone,
              }))
            : null;
        }
      : undefined;
    const fileMenu = this.opts.fileMenu
      ? (query: string): EditorMenuItem[] | null => {
          const items = this.opts.fileMenu!(query);
          return items
            ? items.map((m) => ({
                label: m.label,
                value: m.value,
                hint: m.hint,
                selectable: m.selectable,
                tone: m.tone,
              }))
            : null;
        }
      : undefined;
    const skillMenu = this.opts.skillMenu
      ? (query: string): EditorMenuItem[] | null => {
          const items = this.opts.skillMenu!(query);
          return items
            ? items.map((m) => ({
                label: m.label,
                value: m.value,
                hint: m.hint,
                selectable: m.selectable,
                tone: m.tone,
              }))
            : null;
        }
      : undefined;
    const result = await runEditor({
      keys: this.keys,
      prompt: present.prompt,
      history: this.history,
      ...(this.opts.badges ? { badges: this.opts.badges } : {}),
      ...(seed ? { seed } : {}),
      ...(menu ? { menu } : {}),
      ...(fileMenu ? { fileMenu } : {}),
      ...(skillMenu ? { skillMenu } : {}),
      ...(this.opts.attachSkill ? { attachSkill: this.opts.attachSkill } : {}),
      ...(this.opts.detachLastSkill ? { detachLastSkill: this.opts.detachLastSkill } : {}),
      ...(this.opts.planMode ? { planMode: this.opts.planMode } : {}),
      ...(this.opts.footer ? { footer: this.opts.footer } : {}),
    });
    if (result.kind === "exit") {
      this.exitRequested = true;
      return "";
    }
    const value = result.kind === "submit" ? result.value : "";
    const trimmed = value.trim();
    if (trimmed && this.history[0] !== trimmed) this.history.unshift(trimmed);
    return value;
  }

  /** Prompt for a secret (API key): masked, never recorded into history. */
  async askSecret(prompt: string): Promise<string> {
    if (!this.isTTY) return this.askFallback(prompt);
    const present = splitPromptPresentation(prompt, stdout.columns ?? 80);
    for (const line of present.prefixLines) stdout.write(line + "\n");
    const result = await runEditor({
      keys: this.keys,
      prompt: present.prompt,
      secret: true,
    });
    return result.kind === "submit" ? result.value : "";
  }

  /**
   * Arrow-selectable picker. Resolves the chosen item's value, or null if the
   * user cancels (Esc / Ctrl-C). Non-TTY: returns the first selectable value.
   */
  async pick(prompt: string, items: MenuItem[]): Promise<string | null> {
    if (items.length === 0) return null;
    if (!this.isTTY) {
      return items.find((item) => item.selectable !== false)?.value ?? null;
    }
    const present = splitPromptPresentation(prompt, stdout.columns ?? 80);
    for (const line of present.prefixLines) stdout.write(line + "\n");
    const result = await runEditor({
      keys: this.keys,
      prompt: present.prompt,
      pick: items.map((m) => ({
        label: m.label,
        value: m.value,
        hint: m.hint,
        selectable: m.selectable,
        tone: m.tone,
      })),
    });
    return result.kind === "submit" ? result.value : null;
  }

  /**
   * Route Ctrl-C to `onCtrlC` for the duration of a streaming turn. In raw mode
   * Ctrl-C arrives as byte 0x03 on stdin (no SIGINT fires), so we install a
   * temporary key handler and return a disposer that restores idle handling.
   * Esc is also wired here so the user can abort a running reply with Esc.
   */
  captureInterrupts(onCtrlC: () => void, onEsc?: () => void): () => void {
    if (!this.isTTY) {
      // Non-TTY: fall back to SIGINT for the duration.
      const onSig = (): void => onCtrlC();
      process.on("SIGINT", onSig);
      return () => process.off("SIGINT", onSig);
    }
    this.keys.onKey((_str, key) => {
      if (key.ctrl && key.name === "c") onCtrlC();
      if (key.name === "escape") onEsc?.();
    });
    return () => this.keys.onKey(null);
  }

  /** Seed history (newest last in the array, as humans read it). */
  seedHistory(lines: string[]): void {
    for (const l of lines) {
      const t = l.trim();
      if (t && this.history[0] !== t) this.history.unshift(t);
    }
  }

  close(): void {
    this.keys.stop();
  }

  /**
   * Temporarily release raw stdin ownership so a foreground child process can
   * take over the real terminal, then restore editor input afterwards.
   */
  async withTerminalReleased<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isTTY) return fn();
    const restore = this.keys.suspend();
    try {
      return await fn();
    } finally {
      restore();
    }
  }

  /** Non-TTY line read: cooked readline, one line, no menus/raw mode. */
  private askFallback(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: stdin, output: stdout, terminal: false });
      stdout.write(prompt);
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      rl.once("close", () => resolve(""));
    });
  }
}
