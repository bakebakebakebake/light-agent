import { cyan, dim, gray, bold } from "./theme.js";

/**
 * Pure dropdown / picker row renderer (B1).
 *
 * Stateless: given the items, the selected index, and a height cap, it returns
 * the styled rows to draw beneath the prompt. The selected row is highlighted
 * with FOREGROUND color only — never a background escape — so it doesn't fight
 * the terminal's own selection highlight (the selection-contrast note in
 * theme.ts). The view scrolls to keep the selected row visible and shows a
 * "· N more" footer when the list overflows.
 */

export interface MenuRow {
  label: string;
  hint?: string;
}

export interface MenuView {
  /** Styled lines to print (no trailing newline on the last one). */
  rows: string[];
}

const MAX_HEIGHT = 8;

/** Compute the scroll window [start, end) that keeps `selected` visible. */
export function windowFor(
  total: number,
  selected: number,
  height = MAX_HEIGHT,
): [number, number] {
  if (total <= height) return [0, total];
  let start = selected - Math.floor(height / 2);
  if (start < 0) start = 0;
  if (start + height > total) start = total - height;
  return [start, start + height];
}

/** Render the visible rows of a menu. */
export function renderMenu(
  items: MenuRow[],
  selected: number,
  height = MAX_HEIGHT,
): MenuView {
  if (items.length === 0) {
    return { rows: [dim("  (no matches)")] };
  }
  const [start, end] = windowFor(items.length, selected, height);
  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const isSel = i === selected;
    const marker = isSel ? cyan("›") : " ";
    const label = isSel ? bold(cyan(item.label)) : item.label;
    const hint = item.hint ? "  " + dim(item.hint) : "";
    rows.push(`  ${marker} ${label}${hint}`);
  }
  const hidden = items.length - (end - start);
  if (hidden > 0) {
    rows.push(gray(`    · ${hidden} more`));
  }
  return { rows };
}
