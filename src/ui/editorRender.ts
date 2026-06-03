import { filterMenuRows, renderMenu, type MenuRow } from "./menu.js";
import { frameInput, frameInnerWidth, inputBorderTone } from "./frame.js";
import { visibleWidth, dim, gray, yellow, cyan, bgDark } from "./theme.js";
import type { EditorMenuItem } from "./lineEditor.js";

type Mode = "edit" | "menu" | "pick" | "secret";
type RenderKind = "frame" | "pick" | "hint";

export interface RenderView {
  kind: RenderKind;
  rows: string[];
  cursorRowInRegion: number;
  targetCol: number;
  collapseRows: string[];
  structureKey: string;
}

export interface RenderViewOptions {
  prompt: string;
  lines: string[];
  row: number;
  col: number;
  mode: Mode;
  cols: number;
  badges?: string[];
  menuItems?: EditorMenuItem[];
  menuSel?: number;
  footer?: string;
  planMode?: boolean;
  pickQuery?: string;
  menuQuery?: string;
}

export function changedRowIndices(prev: string[], next: string[]): number[] {
  const out: number[] = [];
  const total = Math.max(prev.length, next.length);
  for (let i = 0; i < total; i++) {
    if (prev[i] !== next[i]) out.push(i);
  }
  return out;
}

export function shouldFullRedraw(prev: RenderView | null, next: RenderView): boolean {
  if (!prev) return true;
  if (prev.kind !== next.kind) return true;
  if (prev.rows.length !== next.rows.length) return true;
  return prev.structureKey !== next.structureKey;
}

function plainCollapseRows(prompt: string, lines: string[], mode: Mode): string[] {
  if (mode === "secret") {
    return [prompt + "•".repeat((lines[0] ?? "").length)];
  }
  if (mode === "pick") {
    return [prompt];
  }
  return lines.map((line, i) => bgDark((i === 0 ? prompt : "  ") + line));
}

function menuRowsOf(items: EditorMenuItem[]): MenuRow[] {
  return items.map((item) => ({
    label: item.label,
    hint: item.hint,
    selectable: item.selectable,
    tone: item.tone,
  }));
}

function badgeRowsOf(badges: string[], width: number): string[] {
  if (badges.length === 0) return [];
  return badges.flatMap((badge) =>
    wrapTextRows(badge, width, width).map((row) => dim(row)),
  );
}

export function buildRenderView(opts: RenderViewOptions): RenderView {
  const collapseRows = plainCollapseRows(opts.prompt, opts.lines, opts.mode);
  if (opts.mode === "pick") {
    const menu = renderMenu(menuRowsOf(opts.menuItems ?? []), opts.menuSel ?? 0, undefined, opts.cols);
    const searchRow = dim(`  Search: ${opts.pickQuery ?? ""}`);
    return {
      kind: "pick",
      rows: [opts.prompt, searchRow, ...menu.rows],
      cursorRowInRegion: 1,
      targetCol: visibleWidth("  Search: ") + visibleWidth(opts.pickQuery ?? ""),
      collapseRows,
      structureKey: `pick|items:${menu.rows.length}|search:${Boolean(opts.pickQuery)}`,
    };
  }

  const promptWidth = visibleWidth(opts.prompt);
  const restPrefix = "  ";
  const restPrefixWidth = visibleWidth(restPrefix);
  const inner = frameInnerWidth([opts.prompt], opts.cols);
  const firstWidth = Math.max(1, inner - promptWidth);
  const restWidth = Math.max(1, inner - restPrefixWidth);

  if (opts.mode === "secret") {
    const full = opts.lines[0] ?? "";
    const masked = "•".repeat(full.length);
    const left = "•".repeat(opts.col);
    const rows = wrapTextRows(masked, firstWidth, restWidth);
    const leftRows = wrapTextRows(left, firstWidth, restWidth);
    const framed = frameInput(
      rows.map((row, i) => (i === 0 ? opts.prompt : restPrefix) + row),
      gray,
      inner,
    );
    return {
      kind: "frame",
      rows: framed,
      cursorRowInRegion: 1 + leftRows.length - 1,
      targetCol:
        2 +
        (leftRows.length === 1 ? promptWidth : restPrefixWidth) +
        visibleWidth(leftRows[leftRows.length - 1] ?? ""),
      collapseRows,
      structureKey: `frame|secret|content:${rows.length}|footer:${opts.footer ? 1 : 0}`,
    };
  }

  const contentRows: string[] = [];
  const badgeRows = badgeRowsOf(opts.badges ?? [], inner);
  let rowOffset = 0;
  let cursorRow = 0;
  let cursorCol = promptWidth;
  for (let i = 0; i < opts.lines.length; i++) {
    const text = opts.lines[i] ?? "";
    const prefix = i === 0 ? opts.prompt : restPrefix;
    const prefixWidth = i === 0 ? promptWidth : restPrefixWidth;
    const wrapped = wrapTextRows(text, i === 0 ? firstWidth : restWidth, restWidth);
    for (let j = 0; j < wrapped.length; j++) {
      contentRows.push((j === 0 ? prefix : restPrefix) + wrapped[j]);
    }
    if (i === opts.row) {
      const left = text.slice(0, opts.col);
      const leftRows = wrapTextRows(left, i === 0 ? firstWidth : restWidth, restWidth);
      cursorRow = rowOffset + leftRows.length - 1;
      cursorCol =
        (leftRows.length === 1 ? prefixWidth : restPrefixWidth) +
        visibleWidth(leftRows[leftRows.length - 1] ?? "");
    }
    rowOffset += wrapped.length;
  }

  const tone = inputBorderTone(opts.lines[0] ?? "", opts.planMode ?? false);
  const color = tone === "shell" ? yellow : tone === "plan" ? cyan : gray;
  const rows = frameInput([...badgeRows, ...contentRows], color, inner);
  const menu = opts.mode === "menu"
    ? renderMenu(menuRowsOf(opts.menuItems ?? []), opts.menuSel ?? 0, undefined, opts.cols)
    : { rows: [] as string[] };
  const menuSearch = opts.mode === "menu"
    ? [dim(`  Search: ${opts.menuQuery ?? ""}`)]
    : [];
  const footerRows = opts.footer ? [opts.footer] : [];

  return {
    kind: "frame",
    rows: [...rows, ...menuSearch, ...menu.rows, ...footerRows],
    cursorRowInRegion: 1 + badgeRows.length + cursorRow,
    targetCol: 2 + cursorCol,
    collapseRows,
    structureKey:
      `frame|tone:${tone}|badges:${badgeRows.length}|content:${contentRows.length}|menu:${menu.rows.length}|menuSearch:${menuSearch.length}|footer:${footerRows.length}`,
  };
}

export function buildHintView(prompt: string, lines: string[], hint: string): RenderView {
  const promptLine = prompt + (lines[0] ?? "");
  return {
    kind: "hint",
    rows: [promptLine, "  " + hint],
    cursorRowInRegion: 0,
    targetCol: visibleWidth(promptLine),
    collapseRows: plainCollapseRows(prompt, lines, "edit"),
    structureKey: "hint|rows:2",
  };
}

export function wrapTextRows(
  text: string,
  firstWidth: number,
  restWidth: number,
): string[] {
  const first = Math.max(1, firstWidth);
  const rest = Math.max(1, restWidth);
  if (text === "") return [""];

  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  let limit = first;

  for (const ch of text) {
    const width = visibleWidth(ch);
    if (currentWidth > 0 && currentWidth + width > limit) {
      rows.push(current);
      current = "";
      currentWidth = 0;
      limit = rest;
    }
    current += ch;
    currentWidth += width;
  }

  if (current !== "" || rows.length === 0) rows.push(current);
  return rows;
}

export function filterPickItems(items: EditorMenuItem[], query: string): EditorMenuItem[] {
  return filterMenuRows(items, query) as EditorMenuItem[];
}
