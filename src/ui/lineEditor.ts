import { stdout } from "node:process";
import type { Key, KeySource } from "./keys.js";
import { renderMenu, type MenuRow } from "./menu.js";
import { visibleWidth, dim, gray, yellow, cyan } from "./theme.js";
import { frameInput, frameInnerWidth, inputBorderTone } from "./frame.js";

/**
 * Raw-mode line editor (B1 + B3 + B4).
 *
 * Owns the editable region beneath a prompt and redraws it on every keystroke.
 * Because KeySource is the ONLY stdin consumer, there is no competing echo — we
 * draw exactly what we want. Supports:
 *   - multiline buffers (Alt+Enter / trailing backslash insert a newline; B4)
 *   - a live `/` command menu and post-command pickers (arrow-select; B1)
 *   - history recall at the buffer's top/bottom edge
 *   - emacs chords (Ctrl-A/E/K/U/W) and Ctrl-L clear
 *   - Ctrl-C that interrupts/cancels but never exits (B3)
 *
 * Redraw strategy: we remember how many terminal rows we last drew, move the
 * cursor to the region's top, erase downward (`\x1b[J`), reprint the prompt +
 * wrapped buffer + any menu, then position the cursor with relative moves. All
 * widths use visibleWidth so CJK and ANSI don't desync the cursor.
 */

/** A menu candidate surfaced for the `/` dropdown or a picker. */
export interface EditorMenuItem {
  label: string;
  value: string;
  hint?: string;
}

export interface EditorOptions {
  keys: KeySource;
  prompt: string;
  /** Initial buffer text. */
  initial?: string;
  /**
   * Pre-fill the buffer AND place the cursor at its end (#7). Used to refill the
   * input with an interrupted question after a mid-stream Ctrl-C, so the user
   * can edit and resend it. Distinct from `initial` only in intent/naming.
   */
  seed?: string;
  /** History lines, newest first. */
  history?: string[];
  /** Mask input (secret entry) — no echo of characters, no menu, no history. */
  secret?: boolean;
  /**
   * Candidate provider for the live `/` menu. Returns items to show given the
   * current buffer, or null to close the menu. Ignored in secret mode.
   */
  menu?: (buffer: string) => EditorMenuItem[] | null;
  /**
   * Candidate provider for the `@` file-mention menu (#4). Given the query
   * after an `@` token under the cursor, returns file items, or null to close.
   * Accepting one replaces just the `@token`, not the whole line.
   */
  fileMenu?: (query: string) => EditorMenuItem[] | null;
  /**
   * Fixed picker list. When set, the editor runs in "pick" mode: arrows select,
   * Enter resolves the chosen value, Esc/Ctrl-C resolves null. No free typing.
   */
  pick?: EditorMenuItem[];
  /**
   * Whether the session is in plan mode (#8/#9). Tints the input frame cyan.
   * A `!`-prefixed buffer always tints yellow (shell) and takes precedence.
   * Called on every draw so it can reflect a mode that changes mid-session.
   */
  planMode?: () => boolean;
  /**
   * Persistent footer rendered as the bottom-left row beneath the frame and any
   * menu (#10): workdir + git branch. Called on every draw so the branch stays
   * fresh. Return "" to omit. Ignored in pick/secret modes.
   */
  footer?: () => string;
}

/** Outcome of one editor run. */
export type EditorResult =
  | { kind: "submit"; value: string }
  | { kind: "cancel" } // Ctrl-C / Esc in a picker
  | { kind: "exit" }; // double Ctrl-C on an empty prompt (#7)

/**
 * Run one interactive edit/pick session. Resolves when the user submits (Enter)
 * or cancels (Ctrl-C / Esc in a picker). The KeySource must already be started.
 */
export function runEditor(opts: EditorOptions): Promise<EditorResult> {
  return new Promise((resolve) => {
    const ed = new Editor(opts, resolve);
    ed.attach();
  });
}

type Mode = "edit" | "menu" | "pick" | "secret";

class Editor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private lastRows = 0;
  /**
   * Which row (0-indexed from the top of the drawn region) the cursor was left
   * on after the previous draw. The old code assumed the cursor sat at the
   * region bottom, but draw() parks it on the input row — so every redraw moved
   * up too far, making the region climb the screen (jitter) and pickers leave
   * stale duplicate rows. Tracking the real position fixes #1/#3/#7.
   */
  private lastCursorRow = 0;
  private mode: Mode;
  private menuItems: EditorMenuItem[] = [];
  private menuSel = 0;
  /**
   * What the open menu is anchored to (#4). "command" → the whole buffer is a
   * `/…` line and accepting replaces it. "token" → an `@…` mention somewhere in
   * the line; accepting replaces just that token (menuTokenStart..col).
   */
  private menuKind: "command" | "token" = "command";
  private menuTokenStart = 0;
  private histIdx = -1; // -1 = current (not recalled)
  /** Timestamp of the last Ctrl-C on an empty buffer, for double-press exit (#7). */
  private lastCtrlC = 0;
  private readonly history: string[];
  private readonly opts: EditorOptions;
  private readonly resolve: (r: EditorResult) => void;

  constructor(opts: EditorOptions, resolve: (r: EditorResult) => void) {
    this.opts = opts;
    this.resolve = resolve;
    this.history = opts.history ?? [];
    if (opts.pick) {
      this.mode = "pick";
      this.menuItems = opts.pick;
    } else if (opts.secret) {
      this.mode = "secret";
    } else {
      this.mode = "edit";
    }
    const prefill = opts.seed ?? opts.initial;
    if (prefill) {
      this.lines = prefill.split("\n");
      this.row = this.lines.length - 1;
      this.col = (this.lines[this.row] ?? "").length;
    }
  }

  attach(): void {
    this.draw();
    this.opts.keys.onKey((str, key) => this.onKey(str, key));
  }

  private finish(result: EditorResult): void {
    this.opts.keys.onKey(null);
    // Collapse the drawn region to just the prompt + submitted line (drop the
    // menu/picker rows below), leaving the cursor at the end so the line stays
    // in scrollback. We move from wherever the cursor currently is to the
    // region bottom, then erase from the first line after the input upward.
    this.collapseToInput();
    stdout.write("\n");
    this.resolve(result);
  }

  /**
   * Erase the whole drawn region (input frame + any menu rows) and reprint a
   * plain, unboxed representation of the submitted line so scrollback stays
   * clean. Used on submit/cancel, right before finish() writes a newline.
   */
  private collapseToInput(): void {
    if (!this.opts.keys.isTTY) return;
    // Go from the current cursor row down to the region bottom, then erase the
    // entire region back up to its top.
    const down = this.lastRows - 1 - this.lastCursorRow;
    if (down > 0) stdout.write(`\x1b[${down}B`);
    stdout.write("\r");
    if (this.lastRows > 1) stdout.write(`\x1b[${this.lastRows - 1}A`);
    stdout.write("\x1b[J");
    // Reprint the plain submitted line (no frame).
    if (this.mode === "secret") {
      stdout.write(this.opts.prompt + "•".repeat((this.lines[0] ?? "").length));
    } else if (this.mode === "pick") {
      stdout.write(this.opts.prompt);
    } else {
      const plain = this.lines
        .map((line, i) => (i === 0 ? this.opts.prompt : "  ") + line)
        .join("\n");
      stdout.write(plain);
    }
    this.lastRows = 0;
    this.lastCursorRow = 0;
  }

  private onKey(str: string | undefined, key: Key): void {
    // Ctrl-C: cancel in a picker; clear a non-empty line; on an empty buffer a
    // double-press within 1s exits (single press shows a dim hint — #7).
    if (key.ctrl && key.name === "c") {
      if (this.mode === "pick") return this.finish({ kind: "cancel" });
      if (this.bufferText() !== "") {
        this.lines = [""];
        this.row = 0;
        this.col = 0;
        this.lastCtrlC = 0; // a clear resets the exit timer
        this.closeMenu();
        return this.draw();
      }
      // Empty buffer: first press hints, second within 1s exits.
      const now = Date.now();
      if (now - this.lastCtrlC < 1000) return this.finish({ kind: "exit" });
      this.lastCtrlC = now;
      this.drawHint(dim("(press Ctrl-C again to exit)"));
      return;
    }

    if (this.mode === "pick") return this.onPickKey(key);

    // A bracketed paste delivers its body as plain `str` with the pasting flag
    // set on the KeySource; newlines in it must be inserted as text, not submit.
    if (this.opts.keys.pasting && str && !key.ctrl && !key.meta) {
      this.insertText(str);
      return this.draw();
    }

    switch (key.name) {
      case "return":
      case "enter":
        return this.onEnter(key);
      case "backspace":
        return this.onBackspace();
      case "delete":
        return this.onDelete();
      case "left":
        return this.moveLeft();
      case "right":
        return this.moveRight();
      case "up":
        return this.onUp();
      case "down":
        return this.onDown();
      case "home":
        this.col = 0;
        return this.draw();
      case "end":
        this.col = (this.lines[this.row] ?? "").length;
        return this.draw();
      case "escape":
        if (this.mode === "menu") {
          this.closeMenu();
          return this.draw();
        }
        return;
      case "tab":
        if (this.mode === "menu") return this.acceptMenu();
        return;
    }

    if (key.ctrl) return this.onCtrlChord(key);
    if (key.meta) return; // unhandled Alt-chord

    // Printable input.
    if (str && !key.ctrl && !key.meta) {
      this.insertText(str);
      this.refreshMenu();
      return this.draw();
    }
  }

  // --- text mutation ---

  private bufferText(): string {
    return this.lines.join("\n");
  }

  private insertText(str: string): void {
    // Split a multi-line paste into the buffer at the cursor.
    const parts = str.split(/\r\n|\r|\n/);
    const line = this.lines[this.row] ?? "";
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    if (parts.length === 1) {
      this.lines[this.row] = before + parts[0] + after;
      this.col += (parts[0] ?? "").length;
    } else {
      const inserted = [...parts];
      inserted[0] = before + inserted[0];
      const lastIdx = inserted.length - 1;
      this.col = (inserted[lastIdx] ?? "").length;
      inserted[lastIdx] = inserted[lastIdx] + after;
      this.lines.splice(this.row, 1, ...inserted);
      this.row += parts.length - 1;
    }
  }

  private onBackspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row] ?? "";
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col -= 1;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1] ?? "";
      const cur = this.lines[this.row] ?? "";
      this.col = prev.length;
      this.lines[this.row - 1] = prev + cur;
      this.lines.splice(this.row, 1);
      this.row -= 1;
    }
    this.refreshMenu();
    this.draw();
  }

  private onDelete(): void {
    const line = this.lines[this.row] ?? "";
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + (this.lines[this.row + 1] ?? "");
      this.lines.splice(this.row + 1, 1);
    }
    this.refreshMenu();
    this.draw();
  }

  // --- enter / newline (B4) ---

  private onEnter(key: Key): void {
    if (this.mode === "menu") return this.acceptMenu();
    // Alt+Enter or a trailing backslash inserts a newline instead of submitting.
    const line = this.lines[this.row] ?? "";
    if (key.meta || (this.col === line.length && line.endsWith("\\"))) {
      if (!key.meta) {
        // Drop the trailing backslash that signalled "continue".
        this.lines[this.row] = line.slice(0, -1);
        this.col -= 1;
      }
      this.insertText("\n");
      return this.draw();
    }
    const value = this.bufferText();
    this.finish({ kind: "submit", value });
  }

  // --- cursor movement ---

  private moveLeft(): void {
    if (this.col > 0) this.col -= 1;
    else if (this.row > 0) {
      this.row -= 1;
      this.col = (this.lines[this.row] ?? "").length;
    }
    this.draw();
  }

  private moveRight(): void {
    const line = this.lines[this.row] ?? "";
    if (this.col < line.length) this.col += 1;
    else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
    this.draw();
  }

  // --- up / down: menu navigation, history at edges, else cursor row ---

  private onUp(): void {
    if (this.mode === "menu" || this.mode === "pick") {
      this.menuSel = Math.max(0, this.menuSel - 1);
      return this.draw();
    }
    if (this.row > 0) {
      this.row -= 1;
      this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
      return this.draw();
    }
    this.recallHistory(1);
  }

  private onDown(): void {
    if (this.mode === "menu" || this.mode === "pick") {
      this.menuSel = Math.min(this.menuItems.length - 1, this.menuSel + 1);
      return this.draw();
    }
    if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
      return this.draw();
    }
    this.recallHistory(-1);
  }

  /** Move through history: dir=+1 older, dir=-1 newer. */
  private recallHistory(dir: number): void {
    if (this.history.length === 0 || this.mode === "secret") return;
    const next = this.histIdx + dir;
    if (next < -1 || next >= this.history.length) return;
    this.histIdx = next;
    const text = next === -1 ? "" : this.history[next] ?? "";
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = (this.lines[this.row] ?? "").length;
    this.draw();
  }

  // --- emacs chords ---

  private onCtrlChord(key: Key): void {
    const line = this.lines[this.row] ?? "";
    switch (key.name) {
      case "a": // start of line
        this.col = 0;
        break;
      case "e": // end of line
        this.col = line.length;
        break;
      case "k": // kill to end of line
        this.lines[this.row] = line.slice(0, this.col);
        break;
      case "u": // kill to start of line
        this.lines[this.row] = line.slice(this.col);
        this.col = 0;
        break;
      case "w": { // kill previous word
        const left = line.slice(0, this.col);
        const trimmed = left.replace(/\s*\S+\s*$/, "");
        this.lines[this.row] = trimmed + line.slice(this.col);
        this.col = trimmed.length;
        break;
      }
      case "l": // clear screen + redraw
        stdout.write("\x1b[2J\x1b[H");
        this.lastRows = 0;
        break;
      case "d": // EOF on empty buffer is handled by the façade; ignore here
        return;
      default:
        return;
    }
    this.refreshMenu();
    this.draw();
  }

  // --- menu (`/` dropdown) + pick ---

  /** Recompute the live menu from the current buffer/cursor (edit mode only).
   * Prefers an `@…` file mention under the cursor (#4); otherwise falls back to
   * the `/…` command menu when the whole buffer is a slash line. */
  private refreshMenu(): void {
    if (this.mode === "pick" || this.mode === "secret") return;

    // 1) `@` file mention: look at the token ending at the cursor on this line.
    if (this.opts.fileMenu) {
      const tok = this.atTokenAtCursor();
      if (tok) {
        const items = this.opts.fileMenu(tok.query);
        if (items && items.length > 0) {
          const wasClosed = this.mode !== "menu" || this.menuKind !== "token";
          this.mode = "menu";
          this.menuKind = "token";
          this.menuTokenStart = tok.start;
          this.menuItems = items;
          this.menuSel = wasClosed ? 0 : Math.min(this.menuSel, items.length - 1);
          return;
        }
      }
    }

    // 2) `/` command menu (whole-buffer).
    if (this.opts.menu) {
      const items = this.opts.menu(this.bufferText());
      if (items && items.length > 0) {
        const wasClosed = this.mode !== "menu" || this.menuKind !== "command";
        this.mode = "menu";
        this.menuKind = "command";
        this.menuItems = items;
        this.menuSel = wasClosed ? 0 : Math.min(this.menuSel, items.length - 1);
        return;
      }
    }

    this.closeMenu();
  }

  /**
   * If the cursor sits at the end of an `@…` token on the current line, return
   * its start column and the query text after the `@`. The token starts at an
   * `@` that is at line start or preceded by whitespace, and runs up to the
   * cursor with no whitespace. Returns null when there's no such token.
   */
  private atTokenAtCursor(): { start: number; query: string } | null {
    const line = this.lines[this.row] ?? "";
    const left = line.slice(0, this.col);
    const at = left.lastIndexOf("@");
    if (at === -1) return null;
    // Must be at line start or preceded by whitespace.
    if (at > 0 && !/\s/.test(left[at - 1] ?? "")) return null;
    const query = left.slice(at + 1);
    // The query itself must not contain whitespace (token ended already).
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  private closeMenu(): void {
    if (this.mode === "menu") this.mode = "edit";
    this.menuItems = [];
    this.menuSel = 0;
  }

  /** Accept the highlighted menu item. For a `/` command this replaces the
   * whole buffer; for an `@` mention it replaces just the token under the
   * cursor with the chosen path (#4). */
  private acceptMenu(): void {
    const item = this.menuItems[this.menuSel];
    if (!item) return;
    if (this.menuKind === "token") {
      const line = this.lines[this.row] ?? "";
      const before = line.slice(0, this.menuTokenStart);
      const after = line.slice(this.col);
      const insert = item.value + " ";
      this.lines[this.row] = before + insert + after;
      this.col = before.length + insert.length;
      this.closeMenu();
      this.refreshMenu();
      return this.draw();
    }
    // Command menu: replace the buffer with the chosen command.
    this.lines = [item.value + " "];
    this.row = 0;
    this.col = this.lines[0]!.length;
    this.closeMenu();
    // Re-open in case the value itself has sub-candidates.
    this.refreshMenu();
    this.draw();
  }

  private onPickKey(key: Key): void {
    if (key.name === "escape") return this.finish({ kind: "cancel" });
    if (key.name === "return" || key.name === "enter") {
      const item = this.menuItems[this.menuSel];
      return this.finish(item ? { kind: "submit", value: item.value } : { kind: "cancel" });
    }
    if (key.name === "up") {
      this.menuSel = Math.max(0, this.menuSel - 1);
      return this.draw();
    }
    if (key.name === "down") {
      this.menuSel = Math.min(this.menuItems.length - 1, this.menuSel + 1);
      return this.draw();
    }
  }

  // --- rendering (anchored redraw) ---

  /**
   * Redraw the whole editable region, then place the cursor. The input lives
   * inside a box frame (#8) whose border tints by mode (gray normal · yellow
   * `!`-shell · cyan plan); the `/`-menu renders BELOW the frame. Pick/secret
   * have no boxed text area, so they take a simpler unboxed path.
   *
   * Cursor bookkeeping: `lastCursorRow` is the row (from the region top) the
   * cursor was parked on last time. We move up to the region top, erase
   * downward, reprint, then move back down to the logical cursor row — now
   * offset by +1 for the top border row.
   */
  private draw(): void {
    if (!this.opts.keys.isTTY) return;
    if (this.lastCursorRow > 0) stdout.write(`\x1b[${this.lastCursorRow}A`);
    stdout.write("\r\x1b[J");

    if (this.mode === "pick") return this.drawPick();

    // Content lines that go INSIDE the box (prompt + buffer, or masked secret).
    const contentLines: string[] =
      this.mode === "secret"
        ? [this.opts.prompt + "•".repeat((this.lines[0] ?? "").length)]
        : this.lines.map((line, i) => (i === 0 ? this.opts.prompt : "  ") + line);

    // Border tone: `!` shell (yellow) wins, else plan (cyan), else gray.
    const tone = inputBorderTone(
      this.lines[0] ?? "",
      this.opts.planMode?.() ?? false,
    );
    const color = tone === "shell" ? yellow : tone === "plan" ? cyan : gray;

    const cols = stdout.columns ?? 80;
    const inner = frameInnerWidth(contentLines, cols);
    const out: string[] = frameInput(contentLines, color, inner);

    // Live `/` menu rows render below the frame.
    if (this.mode === "menu") {
      const view = renderMenu(
        this.menuItems.map((m): MenuRow => ({ label: m.label, hint: m.hint })),
        this.menuSel,
      );
      for (const r of view.rows) out.push(r);
    }

    // Persistent footer (workdir + branch) as the bottom-left row (#10).
    const footer = this.opts.footer?.() ?? "";
    if (footer) out.push(footer);

    stdout.write(out.join("\n"));
    this.lastRows = out.length;

    // Place the cursor. The content row is offset by +1 (top border); the
    // column is offset by 2 for the "│ " left border + padding.
    const cursorRow = this.mode === "secret" ? 0 : this.row;
    const cursorRowInRegion = 1 + cursorRow;
    const rowsUp = out.length - 1 - cursorRowInRegion;
    if (rowsUp > 0) stdout.write(`\x1b[${rowsUp}A`);
    stdout.write("\r");
    const promptW = visibleWidth(this.opts.prompt);
    const lead = cursorRow === 0 ? promptW : 2;
    const colW =
      this.mode === "secret"
        ? (this.lines[0] ?? "").length
        : visibleWidth((this.lines[cursorRow] ?? "").slice(0, this.col));
    const targetCol = 2 + lead + colW;
    if (targetCol > 0) stdout.write(`\x1b[${targetCol}C`);
    this.lastCursorRow = cursorRowInRegion;
  }

  /** Unboxed redraw for pick mode: a prompt line plus the picker list. */
  private drawPick(): void {
    const out: string[] = [this.opts.prompt];
    const view = renderMenu(
      this.menuItems.map((m): MenuRow => ({ label: m.label, hint: m.hint })),
      this.menuSel,
    );
    for (const r of view.rows) out.push(r);
    stdout.write(out.join("\n"));
    this.lastRows = out.length;
    const rowsUp = out.length - 1;
    if (rowsUp > 0) stdout.write(`\x1b[${rowsUp}A`);
    stdout.write("\r");
    const w = visibleWidth(this.opts.prompt);
    if (w > 0) stdout.write(`\x1b[${w}C`);
    this.lastCursorRow = 0;
  }

  /**
   * Redraw the (empty) prompt with a transient hint line beneath it (#7). The
   * next keystroke's draw() clears it, since draw() erases the whole region.
   * Only meaningful in edit mode with an empty buffer, which is when it's used.
   */
  private drawHint(hint: string): void {
    if (!this.opts.keys.isTTY) return;
    if (this.lastCursorRow > 0) stdout.write(`\x1b[${this.lastCursorRow}A`);
    stdout.write("\r\x1b[J");
    const promptLine = this.opts.prompt + (this.lines[0] ?? "");
    stdout.write(promptLine + "\n" + "  " + hint);
    this.lastRows = 2;
    // Park the cursor back on the input row, at the end of the prompt.
    stdout.write("\x1b[1A\r");
    const col = visibleWidth(promptLine);
    if (col > 0) stdout.write(`\x1b[${col}C`);
    this.lastCursorRow = 0;
  }
}

