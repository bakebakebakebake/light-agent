import {
  bold,
  italic,
  strike,
  code,
  cyan,
  gray,
  green,
  magenta,
  dim,
  hr,
} from "./theme.js";

/**
 * Zero-dependency streaming markdown renderer (docs/08, feature #1 + A2).
 *
 * The model streams text in arbitrary chunks. We render line-by-line: text is
 * buffered until a newline, then the completed line is classified (heading,
 * list, quote, rule, code fence, table) and styled before being written. This
 * keeps block detection simple and deterministic while still feeling live —
 * most model prose has frequent newlines. A very long single line only appears
 * once its newline arrives; `flush()` emits any trailing partial line at turn
 * end.
 *
 * Two block constructs need MORE than one line before they can render, so they
 * are buffered in the renderer state:
 *   - Fenced code blocks (``` … ```): rendered with a left gutter + a tiny
 *     syntax highlighter keyed by language. No inline markdown inside.
 *   - GFM tables: a header row + a |---| separator + body rows; buffered until
 *     a non-table line (or flush) so column widths can be computed.
 */

interface RenderState {
  inFence: boolean;
  fenceLang: string;
  /** Buffered table lines (raw), collected until the table ends. */
  table: string[];
}

function newState(): RenderState {
  return { inFence: false, fenceLang: "", table: [] };
}

export class MarkdownStream {
  private buf = "";
  private readonly state = newState();
  private readonly write: (s: string) => void;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  /** Feed a chunk of text; emits any newline-terminated lines immediately. */
  push(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const out = feedLine(line, this.state);
      if (out) this.write(out + "\n");
    }
  }

  /** Emit any buffered partial line + open table (call at end of the turn). */
  flush(): void {
    if (this.buf.length > 0) {
      const out = feedLine(this.buf, this.state);
      if (out) this.write(out);
      this.buf = "";
    }
    // A table that ran to the end of the stream still needs to be drawn.
    const tail = flushTable(this.state);
    if (tail) this.write((this.buf.length > 0 ? "\n" : "") + tail + "\n");
    // Reset block state so the next turn starts clean.
    this.state.inFence = false;
    this.state.fenceLang = "";
    this.state.table = [];
  }
}

/**
 * Feed one complete line through the block state machine. Returns the styled
 * text to write (may be multiple lines, e.g. a flushed table), or "" when the
 * line was buffered (inside a forming table).
 */
function feedLine(line: string, st: RenderState): string {
  // Code fences take priority: a ``` line toggles fence state.
  const fence = /^\s*```(.*)$/.exec(line);
  if (fence) {
    if (st.inFence) {
      st.inFence = false;
      st.fenceLang = "";
      return gray("└" + "─".repeat(12)); // closing rule
    }
    // Opening fence: flush any forming table first, then start the block.
    const pre = flushTable(st);
    st.inFence = true;
    st.fenceLang = (fence[1] ?? "").trim().toLowerCase();
    // Header rule carries the language label; body lines get NO per-line gutter
    // so the code can be selected/copied cleanly (#2). The header/footer rules
    // sit on their own lines, outside any body-line selection.
    const label = st.fenceLang || "code";
    const head = gray("┌── ") + dim(label) + gray(" " + "─".repeat(8));
    return pre ? pre + "\n" + head : head;
  }
  if (st.inFence) {
    // Pure highlighted code, no prefix — copy yields exactly the source line.
    return highlight(line, st.fenceLang);
  }

  // GFM tables: buffer |…| lines until the table ends.
  const isTableRow = /^\s*\|.*\|\s*$/.test(line);
  if (isTableRow) {
    st.table.push(line);
    return ""; // buffered; rendered on the first non-table line / flush
  }
  if (st.table.length > 0) {
    // The table just ended on this (non-table) line. Render it, then the line.
    const rendered = flushTable(st);
    const after = renderBlockLine(line);
    return rendered + "\n" + after;
  }

  return renderBlockLine(line);
}

/** Render and clear any buffered table; "" if there is none / it isn't valid. */
function flushTable(st: RenderState): string {
  if (st.table.length === 0) return "";
  const rows = st.table;
  st.table = [];
  return renderTable(rows);
}

/** Classify and style one complete non-code, non-table line. */
function renderBlockLine(line: string): string {
  // Horizontal rule: a line of only ---, ***, or ___ (3+).
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return hr();
  }

  // Heading: 1–6 leading #.
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return bold(cyan(renderInline(heading[2] ?? "")));
  }

  // Blockquote: leading > (optionally repeated).
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) {
    return gray("│ ") + gray(renderInline(quote[1] ?? ""));
  }

  // Unordered list item: -, *, or + followed by a space.
  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (ul) {
    const indent = ul[1] ?? "";
    return `${indent}  ${cyan("•")} ${renderInline(ul[2] ?? "")}`;
  }

  // Ordered list item: N. or N) followed by a space.
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) {
    const indent = ol[1] ?? "";
    return `${indent}  ${cyan((ol[2] ?? "") + ".")} ${renderInline(ol[3] ?? "")}`;
  }

  // Plain paragraph line.
  return renderInline(line);
}

/**
 * Apply inline styling to a single line of text. Handles (in priority order):
 * `` `code` ``, `**bold**`/`__bold__`, `~~strike~~`, `*italic*`/`_italic_`.
 * Code spans are extracted first so their contents are never re-parsed.
 * Unmatched markers are left literal.
 */
export function renderInline(text: string): string {
  // 1) Protect inline code spans: replace with sentinel placeholders (NUL-
  //    wrapped index, which can't occur in normal text), style them later.
  const spans: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, inner: string) => {
    spans.push(code(inner));
    return `\x00${spans.length - 1}\x00`;
  });

  // 2) Bold (greedy pair, before italic so ** wins over *).
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => bold(t));
  s = s.replace(/__([^_]+)__/g, (_m, t: string) => bold(t));

  // 3) Strikethrough.
  s = s.replace(/~~([^~]+)~~/g, (_m, t: string) => strike(t));

  // 4) Italic: single * or _ around non-empty, non-marker text.
  s = s.replace(/\*([^*\n]+)\*/g, (_m, t: string) => italic(t));
  s = s.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?=[^A-Za-z0-9_]|$)/g, (_m, pre: string, t: string) => pre + italic(t));

  // 5) Restore code spans.
  s = s.replace(/\x00(\d+)\x00/g, (_m, i: string) => spans[Number(i)] ?? "");
  return s;
}

/** Keyword sets per language family for the lightweight highlighter. */
const KEYWORDS: Record<string, RegExp> = {
  js: /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|typeof|instanceof|extends|super|this|null|undefined|true|false)\b/g,
  py: /\b(def|return|if|elif|else|for|while|class|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|None|True|False|and|or|not|in|is)\b/g,
  go: /\b(func|return|if|else|for|range|type|struct|interface|map|chan|go|defer|package|import|var|const|nil|true|false|switch|case|select)\b/g,
  rust: /\b(fn|let|mut|return|if|else|for|while|loop|match|struct|enum|impl|trait|pub|use|mod|async|await|move|ref|Some|None|Ok|Err|true|false)\b/g,
  sh: /\b(if|then|else|fi|for|in|do|done|while|case|esac|function|return|export|local|echo)\b/g,
};

/** Resolve a fence language label to a keyword family key (or "" for none). */
function langFamily(lang: string): string {
  if (/^(ts|tsx|js|jsx|javascript|typescript|json)$/.test(lang)) return "js";
  if (/^(py|python)$/.test(lang)) return "py";
  if (/^(go|golang)$/.test(lang)) return "go";
  if (/^(rs|rust)$/.test(lang)) return "rust";
  if (/^(sh|bash|zsh|shell)$/.test(lang)) return "sh";
  return "";
}

/**
 * A tiny, zero-dependency syntax highlighter. Tokenizes a single code line into
 * strings / comments / numbers / keywords and colors them. Deliberately
 * approximate — good enough to make code scannable without a real parser.
 */
function highlight(line: string, lang: string): string {
  const fam = langFamily(lang);
  // Order matters: protect strings and comments first so keyword/number regexes
  // don't reach inside them. We tokenize by scanning with a combined regex.
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(line)) !== null) {
    out += highlightPlain(line.slice(last, m.index), fam);
    if (m[1]) out += green(m[1]); // string
    else if (m[2] || m[3]) out += gray(m[0]); // comment
    last = m.index + m[0].length;
  }
  out += highlightPlain(line.slice(last), fam);
  return out;
}

/** Highlight keywords + numbers in a plain (non-string/comment) code segment. */
function highlightPlain(seg: string, fam: string): string {
  if (!seg) return "";
  let s = seg.replace(/\b(\d[\d_.eExXa-fA-F]*)\b/g, (n) => cyan(n));
  const kw = KEYWORDS[fam];
  if (kw) s = s.replace(kw, (k) => magenta(k));
  return s;
}

/** Visible length of a string, ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Split a GFM table row "| a | b |" into trimmed cell strings. */
function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** True if a row is a GFM alignment separator like |---|:--:|. */
function isSeparator(row: string): boolean {
  return splitRow(row).every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")));
}

type Align = "left" | "right" | "center";

/**
 * Render buffered GFM table rows into a light box. Falls back to rendering the
 * rows as plain lines when they don't form a valid header+separator table.
 */
function renderTable(rows: string[]): string {
  const sepIndex = rows.findIndex(isSeparator);
  // A valid table needs a header, a separator on line 2, and the box drawing
  // only makes sense with at least the header.
  if (sepIndex !== 1) {
    // Not a real table — emit the raw lines styled as paragraphs.
    return rows.map((r) => renderInline(r)).join("\n");
  }
  const header = splitRow(rows[0] ?? "");
  const aligns: Align[] = splitRow(rows[1] ?? "").map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
  const bodyRows = rows.slice(2).map(splitRow);
  const cols = Math.max(header.length, ...bodyRows.map((r) => r.length));

  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = visibleLen(header[c] ?? "");
    for (const r of bodyRows) w = Math.max(w, visibleLen(r[c] ?? ""));
    widths[c] = Math.max(3, w);
  }

  const padCell = (text: string, c: number): string => {
    const w = widths[c] ?? 3;
    const len = visibleLen(text);
    const space = Math.max(0, w - len);
    const align = aligns[c] ?? "left";
    if (align === "right") return " ".repeat(space) + text;
    if (align === "center") {
      const l = Math.floor(space / 2);
      return " ".repeat(l) + text + " ".repeat(space - l);
    }
    return text + " ".repeat(space);
  };

  const bar = (l: string, mid: string, r: string): string =>
    gray(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r);
  const line = (cells: string[], styler: (s: string) => string): string =>
    gray("│ ") +
    widths
      .map((_w, c) => styler(padCell(cells[c] ?? "", c)))
      .join(gray(" │ ")) +
    gray(" │");

  const out: string[] = [];
  out.push(bar("┌", "┬", "┐"));
  out.push(line(header, (s) => bold(s)));
  out.push(bar("├", "┼", "┤"));
  for (const r of bodyRows) out.push(line(r, (s) => renderInline(s)));
  out.push(bar("└", "┴", "┘"));
  return out.join("\n");
}

/**
 * Render a whole markdown string to styled ANSI (non-streaming). Shares the
 * same line engine as MarkdownStream so output is identical to the streamed
 * path — the streaming invariant the tests assert on.
 */
export function renderMarkdown(text: string): string {
  const st = newState();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const rendered = feedLine(line, st);
    if (rendered) out.push(rendered);
  }
  const tail = flushTable(st);
  if (tail) out.push(tail);
  return out.join("\n");
}
