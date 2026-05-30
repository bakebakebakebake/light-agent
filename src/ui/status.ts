import { gray, bold, cyan, dim, symbols } from "./theme.js";
import { homedir } from "node:os";
import type { PermissionMode } from "../permissions/policy.js";
import type { ThinkingDepth } from "../model/types.js";

/**
 * Status block printed above the input prompt (docs/08, feature #7).
 *
 * Cooked-mode rendition of the requested layout: the workdir sits in the frame
 * title (top-left), and the body line carries model · context-usage · mode. The
 * readline prompt (›) is written separately just beneath, since readline owns
 * the editable line.
 *
 *   ╭─ ~/Public/Code/Harness-Agent ─────────────╮
 *   │ gpt-4o · 12.3k/128k ctx · plan mode       │
 *   ╰────────────────────────────────────────────╯
 */

export interface StatusInfo {
  workdir: string;
  model: string;
  /** Approx tokens currently in context (last request's input size). */
  used: number;
  /** Model's context window. */
  total: number;
  mode: PermissionMode;
}

/** Visible length ignoring ANSI escapes (mirror of theme.box's helper). */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Collapse the home dir to ~ for a shorter, friendlier path. */
export function tildify(p: string): string {
  const home = homedir();
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/** Compact a token count: 1234 → "1.2k", 999 → "999". */
export function humanTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/**
 * Friendly mode label shown in the status line. `default` returns "" so the
 * footer stays quiet when nothing notable is set.
 */
function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "";
    case "plan":
      return "plan mode";
    case "acceptEdits":
      return "accept-edits mode";
    case "allowAll":
      return "allow-all mode";
  }
}

/**
 * Lean one-line status footer (A4 / #9), printed just above the prompt.
 *
 * Per the user's request it always surfaces the live knobs so nothing is
 * hidden: model, permission mode (including the `default` mode), reasoning
 * depth, and context-window usage as a percentage. The fuller `/usage` command
 * adds a fill bar and token counts.
 *
 *   gpt-4o · default mode · thinking off · 3% context
 *   o3-mini · plan mode · thinking high · 61% context
 */
export function statusLine(info: {
  model: string;
  mode: PermissionMode;
  used: number;
  total: number;
  /** Reasoning depth (A1). Defaults to "off" when omitted. */
  thinking?: ThinkingDepth;
}): string {
  const parts: string[] = [cyan(info.model)];
  parts.push(cyan(`${info.mode} mode`));
  parts.push(dim(`thinking ${info.thinking ?? "off"}`));
  const pct = info.total > 0 ? Math.round((info.used / info.total) * 100) : 0;
  parts.push(dim(`${pct}% context`));
  return "  " + parts.join(gray(" · "));
}

/**
 * Bottom-left footer printed BELOW the input frame (#10): the working directory
 * (home-collapsed, dim) and, when inside a git repo, the current branch in cyan
 * to its right with a branch glyph. A null branch (not a repo / git missing)
 * shows just the path. Single working directory only — no multi-root handling.
 *
 *   ~/Public/Code/Harness-Agent  ⎇ main
 */
export function workdirLine(info: { workdir: string; branch: string | null }): string {
  const path = dim(tildify(info.workdir));
  if (!info.branch) return "  " + path;
  return "  " + path + "  " + cyan(`${symbols.branch} ${info.branch}`);
}

/**
 * Render the framed status block (without the trailing prompt). The frame width
 * adapts to the wider of the title (workdir) and the body line, measured on
 * visible characters so ANSI color never misaligns the border.
 */
export function statusBlock(info: StatusInfo): string {
  const title = tildify(info.workdir);
  const ctx = `${humanTokens(info.used)}/${humanTokens(info.total)} ctx`;
  // Color is applied AFTER width is measured (on the plain pieces).
  const bodyPlain = `${info.model} ${"·"} ${ctx} ${"·"} ${blockModeLabel(info.mode)}`;
  const body =
    cyan(info.model) +
    gray(" · ") +
    dim(ctx) +
    gray(" · ") +
    cyan(blockModeLabel(info.mode));

  const inner = Math.max(title.length + 1, visibleLength(bodyPlain));
  const dash = (n: number): string => "─".repeat(Math.max(0, n));

  const top = gray("╭─ ") + bold(title) + " " + gray(dash(inner - title.length - 1) + "╮");
  const mid = gray("│ ") + body + " ".repeat(inner - visibleLength(bodyPlain)) + gray(" │");
  const bottom = gray("╰" + dash(inner + 2) + "╯");

  return [top, mid, bottom].join("\n");
}

/** Verbose mode label for the (legacy) framed block — always non-empty. */
function blockModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "default mode";
    case "plan":
      return "plan mode";
    case "acceptEdits":
      return "accept-edits mode";
    case "allowAll":
      return "allow-all mode";
  }
}
