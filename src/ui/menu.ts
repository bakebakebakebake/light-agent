import { cyan, dim, gray, bold, green, visibleWidth } from "./theme.js";

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
  selectable?: boolean;
  tone?: "green" | "dim";
}

export interface MenuView {
  /** Styled lines to print (no trailing newline on the last one). */
  rows: string[];
}

const MAX_HEIGHT = 8;

function truncatePlain(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  let out = "";
  for (const ch of text) {
    const next = out + ch;
    if (visibleWidth(next) > maxWidth - 1) break;
    out = next;
  }
  return out + "…";
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/** Lightweight fuzzy match: query chars must appear in order. */
export function fuzzyScore(text: string, query: string): number | null {
  const hay = normalize(text);
  const needle = normalize(query);
  if (!needle) return 0;
  let score = 0;
  let idx = -1;
  let contiguous = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, idx + 1);
    if (found === -1) return null;
    if (found === idx + 1) {
      contiguous += 1;
      score += 4 + contiguous;
    } else {
      contiguous = 0;
      score += 1;
    }
    if (found === 0) score += 2;
    idx = found;
  }
  return score;
}

export function matchesMenuRow(item: MenuRow, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  const haystacks = [item.label, item.hint ?? ""];
  const terms = needle.split(/\s+/).filter(Boolean);
  return terms.every((term) =>
    haystacks.some((hay) => fuzzyScore(hay, term) !== null),
  );
}

/** Filter menu rows while preserving group headings with matching children only. */
export function filterMenuRows(items: MenuRow[], query: string): MenuRow[] {
  const needle = normalize(query);
  if (!needle) return items;

  const out: MenuRow[] = [];
  let pendingGroup: MenuRow | null = null;
  let emittedGroup = false;

  for (const item of items) {
    if (item.selectable === false) {
      pendingGroup = item;
      emittedGroup = false;
      continue;
    }
    if (!matchesMenuRow(item, needle)) continue;
    if (pendingGroup && !emittedGroup) {
      out.push(pendingGroup);
      emittedGroup = true;
    }
    out.push(item);
  }
  return out;
}

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
  maxWidth = Infinity,
): MenuView {
  if (items.length === 0) {
    return { rows: [dim("  (no matches)")] };
  }
  const [start, end] = windowFor(items.length, selected, height);
  const rows: string[] = [];
  const prefixWidth = 4; // "  " + marker + " "
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const selectable = item.selectable !== false;
    const isSel = selectable && i === selected;
    const marker = selectable ? (isSel ? cyan("›") : " ") : " ";
    const bodyWidth = Math.max(0, maxWidth - prefixWidth);
    let labelText = item.label;
    let hintText = item.hint ?? "";
    if (visibleWidth(labelText) > bodyWidth) {
      labelText = truncatePlain(labelText, bodyWidth);
      hintText = "";
    } else if (hintText) {
      const hintBudget = Math.max(0, bodyWidth - visibleWidth(labelText) - 2);
      hintText = truncatePlain(hintText, hintBudget);
    }
    let label = labelText;
    if (isSel) label = bold(cyan(labelText));
    else if (item.tone === "green") label = green(labelText);
    else if (!selectable || item.tone === "dim") label = dim(labelText);
    const hint = hintText ? "  " + dim(hintText) : "";
    rows.push(`  ${marker} ${label}${hint}`);
  }
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, items.length - end);
  const footerParts: string[] = [];
  if (hiddenAbove > 0) footerParts.push(`↑ ${hiddenAbove} earlier`);
  if (hiddenBelow > 0) footerParts.push(`↓ ${hiddenBelow} more`);
  if (footerParts.length > 0) {
    rows.push(gray(truncatePlain(`    ${footerParts.join("  ·  ")}`, maxWidth)));
  }
  return { rows };
}
