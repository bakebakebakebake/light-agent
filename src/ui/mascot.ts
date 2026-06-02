import { cyan, dim, bold, visibleWidth } from "./theme.js";

/**
 * Startup mascot (docs/08, feature #7).
 *
 * A small ASCII creature used by the launch banner — the friendly face of the
 * REPL, in the spirit of Claude Code's opening glyph. Pure string output so it
 * composes with the rest of the UI; colors come from theme.ts, which already
 * degrades to plain text off-TTY. No dependencies, no side effects.
 */

/** Render the mascot as a multi-line string (no trailing newline). */
export function mascot(): string {
  // Original mascot: a compact, top-heavy bot with a clear face and short
  // harness body. Kept simple so it reads well in a terminal banner.
  const art = [
    "  ╭───────╮",
    "  │ ◣ ◯ ◢ │",
    "  ╰──┬─┬──╯",
    " ╶──┤   ├──╴",
    "    ╰─┴─╯",
  ];
  const colored = [
    "  " + cyan("╭───────╮"),
    "  " + cyan("│ ") + bold("◣ ◯ ◢") + cyan(" │"),
    "  " + cyan("╰──┬─┬──╯"),
    " " + cyan("╶──┤   ├──╴"),
    "    " + cyan("╰─┴─╯"),
  ];
  void art;
  return colored.join("\n");
}

/** One-line product label shown next to the mascot on startup. */
export function mascotTagline(): string {
  return bold("Light-Agent") + dim("  · your terminal coding companion");
}

function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/**
 * Render two blocks side by side and center the shorter one vertically.
 * Color codes are width-safe because padding uses visible terminal width.
 */
export function beside(left: string[], right: string[], gap = 3): string {
  const rows = Math.max(left.length, right.length);
  const padRows = (block: string[]): string[] => {
    const missing = rows - block.length;
    const top = Math.floor(missing / 2);
    const bottom = missing - top;
    return [
      ...Array.from({ length: top }, () => ""),
      ...block,
      ...Array.from({ length: bottom }, () => ""),
    ];
  };
  const leftRows = padRows(left);
  const rightRows = padRows(right);
  const leftWidth = Math.max(0, ...leftRows.map(visibleWidth));
  return leftRows
    .map((line, i) => `${padVisible(line, leftWidth)}${" ".repeat(gap)}${rightRows[i] ?? ""}`)
    .join("\n");
}
