import { visibleWidth } from "./theme.js";

/**
 * Pure helpers for the input frame box (#8). Kept free of color/TTY state so
 * they're unit-testable; the line editor passes in a `color` function and the
 * terminal width, and positions the cursor around the rows returned here.
 */

/** Which tint the frame border gets, by buffer state / session mode. */
export type BorderTone = "shell" | "plan" | "normal";

/**
 * Decide the border tone: a `!`-prefixed buffer is a shell command (yellow) and
 * wins over everything; otherwise plan mode tints cyan; otherwise normal (gray).
 */
export function inputBorderTone(firstLine: string, planMode: boolean): BorderTone {
  if (firstLine.startsWith("!")) return "shell";
  if (planMode) return "plan";
  return "normal";
}

/**
 * Inner content width for the frame: the longest content line, floored at
 * `minInner` so an empty/short prompt still shows a real box, and capped at the
 * terminal width minus the border/padding so it never wraps.
 */
export function frameInnerWidth(
  contentLines: string[],
  cols: number,
  minInner = 24,
): number {
  const maxInner = Math.max(8, cols - 4);
  const longest = contentLines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
  return Math.min(maxInner, Math.max(minInner, longest));
}

/**
 * Render the box rows around the given content lines. Only the border glyphs
 * are colored (via `color`) so a content line's own ANSI reset can't bleed into
 * the frame. Each content line is right-padded to `inner` so the right edge
 * stays aligned regardless of CJK/ANSI in the text.
 */
export function frameInput(
  contentLines: string[],
  color: (s: string) => string,
  inner: number,
): string[] {
  const dash = (n: number): string => "─".repeat(Math.max(0, n));
  const rows: string[] = [color("╭" + dash(inner + 2) + "╮")];
  for (const cl of contentLines) {
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(cl)));
    rows.push(color("│ ") + cl + pad + color(" │"));
  }
  rows.push(color("╰" + dash(inner + 2) + "╯"));
  return rows;
}
