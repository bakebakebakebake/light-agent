import { cyan, dim, bold } from "./theme.js";

/**
 * Startup mascot (docs/08, feature #7).
 *
 * A small ASCII creature printed above the launch banner — the friendly face of
 * the REPL, in the spirit of Claude Code's opening glyph. Pure string output so
 * it composes with the rest of the UI; colors come from theme.ts, which already
 * degrades to plain text off-TTY. No dependencies, no side effects.
 */

/** Render the mascot as a multi-line string (no trailing newline). */
export function mascot(): string {
  // A little harness-wearing bot: the brackets are its "harness" straps, the
  // ◣◢ its visor. Kept compact so it never dominates the first screen.
  const art = [
    "    ╭───────╮",
    "    │ ◣ ◯ ◢ │",
    "    ╰──┬─┬──╯",
    "   ╶──┤   ├──╴",
    "      ╰─┴─╯",
  ];
  const colored = [
    "    " + cyan("╭───────╮"),
    "    " + cyan("│ ") + bold("◣ ◯ ◢") + cyan(" │"),
    "    " + cyan("╰──┬─┬──╯"),
    "   " + dim("╶──") + cyan("┤   ├") + dim("──╴"),
    "      " + cyan("╰─┴─╯"),
  ];
  void art;
  const tagline = "  " + bold("Harness-Agent") + dim("  · your terminal coding companion");
  return colored.join("\n") + "\n" + tagline;
}
