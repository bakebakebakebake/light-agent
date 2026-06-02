import { stdout } from "node:process";
import type { Key, KeySource } from "./keys.js";
import { dim } from "./theme.js";
import {
  buildHintView,
  buildRenderView,
  changedRowIndices,
  filterPickItems,
  shouldFullRedraw,
  wrapTextRows,
  type RenderView,
} from "./editorRender.js";
import { logger } from "../util/logger.js";

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
  selectable?: boolean;
  tone?: "green" | "dim";
}

export interface EditorOptions {
  keys: KeySource;
  prompt: string;
  /** Visible next-turn context labels, e.g. selected skill names. */
  badges?: string[] | (() => string[]);
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
   * Candidate provider for the `#` inline-skill picker. Accepting a match
   * attaches the skill to the current draft and removes the `#token`.
   */
  skillMenu?: (query: string) => EditorMenuItem[] | null;
  /** Called when a skill is attached inline through the `#` picker. */
  attachSkill?: (skillName: string) => void;
  /** Called when backspacing an empty draft should drop the last attached skill. */
  detachLastSkill?: () => boolean;
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
export { buildHintView, buildRenderView, changedRowIndices, shouldFullRedraw, wrapTextRows };

class Editor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private lastRenderedRows: string[] = [];
  private lastView: RenderView | null = null;
  private mode: Mode;
  private menuItems: EditorMenuItem[] = [];
  private menuSel = 0;
  /**
   * What the open menu is anchored to (#4). "command" → the whole buffer is a
   * `/…` line and accepting replaces it. "token" → an `@…` mention somewhere in
   * the line; accepting replaces just that token (menuTokenStart..col).
   */
  private menuKind: "command" | "file" | "skill" = "command";
  private menuTokenStart = 0;
  private menuTokenQuery = "";
  private histIdx = -1; // -1 = current (not recalled)
  /** Timestamp of the last Ctrl-C on an empty buffer, for double-press exit (#7). */
  private lastCtrlC = 0;
  /** Timestamp of the first Esc press in a slash-command context. */
  private lastEsc = 0;
  private pickItemsBase: EditorMenuItem[] = [];
  private pickQuery = "";
  private readonly history: string[];
  private readonly opts: EditorOptions;
  private readonly resolve: (r: EditorResult) => void;
  private readonly onTerminalRefresh = (): void => {
    logger.debug("editor terminal refresh");
    if (!this.opts.keys.isTTY) return;
    this.restoreRegionAnchor();
    stdout.write("\x1b[J");
    this.lastRenderedRows = [];
    this.lastView = null;
    this.draw();
  };

  constructor(opts: EditorOptions, resolve: (r: EditorResult) => void) {
    this.opts = opts;
    this.resolve = resolve;
    this.history = opts.history ?? [];
    if (opts.pick) {
      this.mode = "pick";
      this.pickItemsBase = opts.pick;
      this.applyPickFilter();
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
    process.on("SIGWINCH", this.onTerminalRefresh);
    process.on("SIGCONT", this.onTerminalRefresh);
    this.captureRegionAnchor();
    this.draw();
    this.opts.keys.onKey((str, key) => this.onKey(str, key));
  }

  private finish(result: EditorResult): void {
    this.opts.keys.onKey(null);
    process.off("SIGWINCH", this.onTerminalRefresh);
    process.off("SIGCONT", this.onTerminalRefresh);
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
    this.restoreRegionAnchor();
    stdout.write("\x1b[J");
    const view = this.buildCurrentView();
    stdout.write(view.collapseRows.join("\n"));
    this.lastRenderedRows = [];
    this.lastView = null;
  }

  private onKey(str: string | undefined, key: Key): void {
    // Ctrl-C: cancel in a picker; clear a non-empty line; on an empty buffer a
    // double-press within 1s exits (single press shows a dim hint — #7).
    if (key.ctrl && key.name === "c") {
      this.lastEsc = 0;
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

    if (this.mode === "pick") return this.onPickKey(str, key);

    // A bracketed paste delivers its body as plain `str` with the pasting flag
    // set on the KeySource; newlines in it must be inserted as text, not submit.
    if (this.opts.keys.pasting && str && !key.ctrl && !key.meta) {
      this.insertText(str);
      this.refreshMenu();
      this.lastEsc = 0;
      return this.draw();
    }

    switch (key.name) {
      case "return":
      case "enter":
        this.lastEsc = 0;
        return this.onEnter(key);
      case "backspace":
        this.lastEsc = 0;
        return this.onBackspace();
      case "delete":
        this.lastEsc = 0;
        return this.onDelete();
      case "left":
        this.lastEsc = 0;
        return this.moveLeft();
      case "right":
        this.lastEsc = 0;
        return this.moveRight();
      case "up":
        this.lastEsc = 0;
        return this.onUp();
      case "down":
        this.lastEsc = 0;
        return this.onDown();
      case "home":
        this.lastEsc = 0;
        this.col = 0;
        this.refreshMenu();
        return this.draw();
      case "end":
        this.lastEsc = 0;
        this.col = (this.lines[this.row] ?? "").length;
        this.refreshMenu();
        return this.draw();
      case "escape":
        return this.onEscape();
      case "tab":
        this.lastEsc = 0;
        if (this.mode === "menu") return this.acceptMenu();
        return;
    }

    if (key.ctrl) {
      this.lastEsc = 0;
      return this.onCtrlChord(key);
    }
    if (key.meta) {
      this.lastEsc = 0;
      return; // unhandled Alt-chord
    }

    // Printable input.
    if (str && !key.ctrl && !key.meta) {
      this.lastEsc = 0;
      this.insertText(str);
      this.refreshMenu();
      return this.draw();
    }
  }

  /**
   * Esc has two meanings:
   *  - a single press closes the live menu if one is open
   *  - a double press on an EMPTY prompt submits `/rewind`
   */
  private onEscape(): void {
    if (this.mode === "pick") return this.finish({ kind: "cancel" });

    const now = Date.now();
    const empty = this.bufferText() === "";
    const armed = empty && this.lastEsc !== 0 && now - this.lastEsc < 1000;

    if (this.mode === "menu") {
      this.closeMenu();
    }

    if (armed) {
      this.lastEsc = 0;
      return this.finish({ kind: "submit", value: "/rewind" });
    }

    this.lastEsc = empty ? now : 0;
    return this.draw();
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
    if (this.bufferText() === "") {
      if (this.opts.detachLastSkill?.()) {
        this.closeMenu();
        return this.draw();
      }
      return;
    }
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
    if (this.mode === "menu") {
      const item = this.menuItems[this.menuSel];
      if (this.menuKind === "command" && item && item.selectable !== false) {
        this.lines = [item.value];
        this.row = 0;
        this.col = item.value.length;
        this.closeMenu();
        return this.finish({ kind: "submit", value: item.value });
      }
      return this.acceptMenu();
    }
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
    this.refreshMenu();
    this.draw();
  }

  private moveRight(): void {
    const line = this.lines[this.row] ?? "";
    if (this.col < line.length) this.col += 1;
    else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
    this.refreshMenu();
    this.draw();
  }

  // --- up / down: menu navigation, history at edges, else cursor row ---

  private onUp(): void {
    if (this.mode === "menu" || this.mode === "pick") {
      this.moveMenuSelection(-1);
      return this.draw();
    }
    if (this.row > 0) {
      this.row -= 1;
      this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
      this.refreshMenu();
      return this.draw();
    }
    this.recallHistory(1);
  }

  private onDown(): void {
    if (this.mode === "menu" || this.mode === "pick") {
      this.moveMenuSelection(1);
      return this.draw();
    }
    if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
      this.refreshMenu();
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
    this.refreshMenu();
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
        this.lastRenderedRows = [];
        this.lastView = null;
        this.captureRegionAnchor();
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
      const tok = this.tokenAtCursor("@");
      if (tok) {
        const items = this.opts.fileMenu(tok.query);
        if (items && items.length > 0) {
          const wasClosed = this.mode !== "menu" || this.menuKind !== "file";
          logger.debug("editor menu open", { kind: "file", query: tok.query, count: items.length });
          this.mode = "menu";
          this.menuKind = "file";
          this.menuTokenStart = tok.start;
          this.menuTokenQuery = tok.query;
          this.menuItems = items;
          this.menuSel = wasClosed
            ? this.firstSelectableIndex(items)
            : this.clampSelectableIndex(this.menuSel);
          return;
        }
      }
    }

    if (this.opts.skillMenu) {
      const tok = this.tokenAtCursor("#");
      if (tok) {
        const items = this.opts.skillMenu(tok.query);
        if (items && items.length > 0) {
          const wasClosed = this.mode !== "menu" || this.menuKind !== "skill";
          logger.debug("editor menu open", { kind: "skill", query: tok.query, count: items.length });
          this.mode = "menu";
          this.menuKind = "skill";
          this.menuTokenStart = tok.start;
          this.menuTokenQuery = tok.query;
          this.menuItems = items;
          this.menuSel = wasClosed
            ? this.firstSelectableIndex(items)
            : this.clampSelectableIndex(this.menuSel);
          return;
        }
      }
    }

    // 2) `/` command menu (whole-buffer).
    if (this.opts.menu) {
      const items = this.opts.menu(this.bufferText());
      if (items && items.length > 0) {
        const wasClosed = this.mode !== "menu" || this.menuKind !== "command";
        logger.debug("editor menu open", { kind: "command", buffer: this.bufferText(), count: items.length });
        this.mode = "menu";
        this.menuKind = "command";
        this.menuTokenQuery = this.bufferText().replace(/^\//, "");
        this.menuItems = items;
        this.menuSel = wasClosed
          ? this.firstSelectableIndex(items)
          : this.clampSelectableIndex(this.menuSel);
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
  private tokenAtCursor(trigger: "@" | "#"): { start: number; query: string } | null {
    const line = this.lines[this.row] ?? "";
    const left = line.slice(0, this.col);
    const at = left.lastIndexOf(trigger);
    if (at === -1) return null;
    // Must be at line start or preceded by whitespace.
    if (at > 0 && !/\s/.test(left[at - 1] ?? "")) return null;
    const query = left.slice(at + 1);
    // The query itself must not contain whitespace (token ended already).
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  private closeMenu(): void {
    if (this.mode === "menu") logger.debug("editor menu close", { kind: this.menuKind });
    if (this.mode === "menu") this.mode = "edit";
    this.menuItems = [];
    this.menuSel = 0;
    this.menuTokenQuery = "";
  }

  /** Accept the highlighted menu item. For a `/` command this replaces the
   * whole buffer; for an `@` mention it replaces just the token under the
   * cursor with the chosen path (#4). */
  private acceptMenu(): void {
    const item = this.menuItems[this.menuSel];
    if (!item || item.selectable === false) return;
    if (this.menuKind === "file") {
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
    if (this.menuKind === "skill") {
      const line = this.lines[this.row] ?? "";
      const before = line.slice(0, this.menuTokenStart);
      const after = line.slice(this.col);
      this.lines[this.row] = before + after;
      this.col = before.length;
      this.opts.attachSkill?.(item.value);
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

  private onPickKey(str: string | undefined, key: Key): void {
    if (key.name === "escape") {
      if (this.pickQuery) {
        this.pickQuery = "";
        this.applyPickFilter();
        return this.draw();
      }
      return this.finish({ kind: "cancel" });
    }
    if (key.name === "return" || key.name === "enter") {
      const item = this.menuItems[this.menuSel];
      if (item && item.selectable !== false) {
        return this.finish({ kind: "submit", value: item.value });
      }
      return this.draw();
    }
    if (key.name === "up") {
      this.moveMenuSelection(-1);
      return this.draw();
    }
    if (key.name === "down") {
      this.moveMenuSelection(1);
      return this.draw();
    }
    if (key.name === "backspace") {
      if (this.pickQuery) {
        this.pickQuery = this.pickQuery.slice(0, -1);
        this.applyPickFilter();
        return this.draw();
      }
      return;
    }
    if (key.name === "delete") return;
    if (str && !key.ctrl && !key.meta) {
      this.pickQuery += str;
      this.applyPickFilter();
      return this.draw();
    }
  }

  // --- rendering (anchored redraw) ---

  private draw(): void {
    if (!this.opts.keys.isTTY) return;
    this.paintView(this.buildCurrentView());
  }

  private drawHint(hint: string): void {
    if (!this.opts.keys.isTTY) return;
    this.paintView(buildHintView(this.opts.prompt, this.lines, hint));
  }

  private buildCurrentView(): RenderView {
    const badges =
      this.mode === "pick" || this.mode === "secret"
        ? []
        : typeof this.opts.badges === "function"
          ? this.opts.badges()
          : this.opts.badges ?? [];
    return buildRenderView({
      prompt: this.opts.prompt,
      lines: this.lines,
      row: this.row,
      col: this.col,
      mode: this.mode,
      cols: stdout.columns ?? 80,
      badges,
      menuItems: this.menuItems,
      menuSel: this.menuSel,
      footer: this.mode === "pick" || this.mode === "secret" ? "" : this.opts.footer?.() ?? "",
      planMode: this.opts.planMode?.() ?? false,
      pickQuery: this.pickQuery,
      menuQuery: this.mode === "menu" ? this.menuTokenQuery : "",
    });
  }

  private captureRegionAnchor(): void {
    if (!this.opts.keys.isTTY) return;
    stdout.write("\x1b7");
  }

  private restoreRegionAnchor(): void {
    if (!this.opts.keys.isTTY) return;
    stdout.write("\x1b8");
    stdout.write("\r");
  }

  private paintView(view: RenderView): void {
    if (!this.opts.keys.isTTY) return;
    this.restoreRegionAnchor();

    if (shouldFullRedraw(this.lastView, view)) {
      stdout.write("\x1b[J");
      stdout.write(view.rows.join("\n"));
    } else {
      const changed = new Set(changedRowIndices(this.lastRenderedRows, view.rows));
      for (let i = 0; i < view.rows.length; i++) {
        if (i > 0) stdout.write("\x1b[1B\r");
        if (changed.has(i)) stdout.write("\x1b[2K" + (view.rows[i] ?? ""));
      }
    }

    this.lastRenderedRows = [...view.rows];
    this.lastView = view;
    const rowsUp = view.rows.length - 1 - view.cursorRowInRegion;
    if (rowsUp > 0) stdout.write(`\x1b[${rowsUp}A`);
    stdout.write("\r");
    if (view.targetCol > 0) stdout.write(`\x1b[${view.targetCol}C`);
  }

  private firstSelectableIndex(items: EditorMenuItem[]): number {
    const idx = items.findIndex((item) => item.selectable !== false);
    return idx >= 0 ? idx : 0;
  }

  private clampSelectableIndex(idx: number): number {
    if (this.menuItems.length === 0) return 0;
    const clamped = Math.max(0, Math.min(this.menuItems.length - 1, idx));
    if (this.menuItems[clamped]?.selectable !== false) return clamped;
    this.menuSel = clamped;
    this.moveMenuSelection(1);
    return this.menuSel;
  }

  private moveMenuSelection(dir: number): void {
    if (this.menuItems.length === 0) return;
    let next = this.menuSel;
    while (true) {
      const candidate = next + dir;
      if (candidate < 0 || candidate >= this.menuItems.length) return;
      next = candidate;
      if (this.menuItems[next]?.selectable !== false) {
        this.menuSel = next;
        return;
      }
    }
  }

  private applyPickFilter(): void {
    const needle = this.pickQuery.trim();
    if (!needle) {
      this.menuItems = [...this.pickItemsBase];
      this.menuSel = this.firstSelectableIndex(this.menuItems);
      return;
    }
    this.menuItems = filterPickItems(this.pickItemsBase, needle);
    this.menuSel = this.firstSelectableIndex(this.menuItems);
  }
}
