/**
 * Shared terminal styling (docs/08).
 *
 * One place for ANSI color + box-drawing so the renderer, banner, commands, and
 * spinner all look consistent. Zero dependencies — just escape codes — and it
 * degrades to plain text when stdout isn't a TTY (pipes, CI, redirects).
 */

const useColor = process.stdout.isTTY === true;

const wrap = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = (s: string): string => wrap("2", s);
export const bold = (s: string): string => wrap("1", s);
export const italic = (s: string): string => wrap("3", s);
export const strike = (s: string): string => wrap("9", s);
export const cyan = (s: string): string => wrap("36", s);
export const red = (s: string): string => wrap("31", s);
export const yellow = (s: string): string => wrap("33", s);
export const green = (s: string): string => wrap("32", s);
export const magenta = (s: string): string => wrap("35", s);
export const gray = (s: string): string => wrap("90", s);

/**
 * Inline-code styling. Uses a foreground color only (no background escape) so it
 * never fights the terminal's own selection highlight — a deliberate choice so
 * selected text stays legible (see docs/08, the selection-contrast note).
 */
export const code = (s: string): string => wrap("36", s);

/**
 * A horizontal rule spanning the terminal width (capped), drawn in gray. Used by
 * the markdown renderer for `---` / `***` / `___`.
 */
export function hr(width?: number): string {
  const cols = width ?? (process.stdout.columns ?? 80);
  return gray("─".repeat(Math.max(3, Math.min(cols, 80))));
}

/** Status / list glyphs used across the UI. */
export const symbols = {
  tool: "⏺", // a tool call is starting
  ok: "✓", // tool succeeded
  fail: "✗", // tool failed
  warn: "⚠", // approval needed
  bullet: "•", // notify-tier / list item
  arrow: "›", // the input prompt
  dot: "·", // separator
  branch: "⎇", // git branch (footer, #10)
} as const;

/** Visible length of a string, ignoring ANSI escape sequences. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Display width of a string on a terminal: ignores ANSI escapes and counts
 * wide (CJK / fullwidth) code points as 2 columns. Used by the raw-mode line
 * editor so the cursor never desyncs from what's drawn.
 */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** Rough East-Asian-wide / fullwidth detection (enough for terminal layout). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

/**
 * Draw a rounded box around a title and a set of lines, e.g. the launch banner.
 * Width adapts to the longest visible line. Color codes inside content lines are
 * fine — width is measured on visible characters so borders stay aligned, and
 * only the border glyphs are colored (so a content line's own reset can't bleed
 * into the frame).
 */
export function box(title: string, lines: string[]): string {
  const all = [title, ...lines];
  const inner = Math.max(...all.map(visibleLength));
  const pad = (s: string): string => s + " ".repeat(inner - visibleLength(s));

  const dash = (n: number): string => "─".repeat(Math.max(0, n));
  const top = gray("╭─ ") + bold(title) + " " + gray(dash(inner - visibleLength(title) - 1) + "╮");
  const body = lines.map((l) => gray("│ ") + pad(l) + gray(" │"));
  const bottom = gray("╰" + dash(inner + 2) + "╯");

  return [top, ...body, bottom].join("\n");
}
