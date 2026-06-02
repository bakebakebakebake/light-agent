import type { GitDiffFile } from "../util/git.js";
import { green, red, gray, dim, bold, cyan, yellow } from "./theme.js";

/**
 * Colorize a unified diff / patch for terminal display (#2).
 *
 * Used both for the inline diff shown after a successful edit/write and for the
 * `/diff` command's git output. Pure string→string so it's trivially testable.
 * We color by line prefix, leaving content untouched:
 *  - `+` added → green, `-` removed → red
 *  - `@@ … @@` hunk headers → gray
 *  - `diff`/`index`/`+++`/`---`/`new file`… file headers → dim
 *  - everything else (context) → unchanged
 *
 * The leading `---`/`+++` file markers are NOT treated as add/remove lines
 * (they'd otherwise mis-color), so they're matched before the +/- rules.
 */
export function colorizeDiff(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      out.push(dim(line));
    } else if (line.startsWith("@@")) {
      out.push(gray(line));
    } else if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("rename ") ||
      line.startsWith("similarity ") ||
      line.startsWith("\\ No newline")
    ) {
      out.push(dim(line));
    } else if (line.startsWith("+")) {
      out.push(green(line));
    } else if (line.startsWith("-")) {
      out.push(red(line));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Trim a unified patch to just its body (drop the `Index:`/`===`/`+++`/`---`
 * header lines that `createTwoFilesPatch` emits) for a tighter inline preview.
 * Keeps hunk headers and the actual +/- lines.
 */
export function diffBody(patch: string): string {
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  if (start === -1) return patch.trim();
  return lines.slice(start).join("\n").trimEnd();
}

function statusLabel(file: GitDiffFile): string {
  switch (file.status) {
    case "added":
      return green("added");
    case "deleted":
      return red("deleted");
    case "renamed":
      return yellow("renamed");
    case "copied":
      return yellow("copied");
    case "modified":
      return cyan("modified");
    default:
      return dim("changed");
  }
}

export function summarizeDiffFile(file: GitDiffFile): string {
  const stats = `${green("+" + file.additions)} ${red("-" + file.deletions)}`;
  const path =
    file.previousPath && file.previousPath !== file.path
      ? `${file.previousPath} ${dim("→")} ${file.path}`
      : file.path;
  return `${statusLabel(file)}  ${path}  ${dim(`(${stats})`)}`;
}

export function diffTotals(
  files: readonly GitDiffFile[],
): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function renderDiffFileList(
  title: string,
  files: readonly GitDiffFile[],
): string[] {
  if (files.length === 0) return [dim(`  No ${title.toLowerCase()} changes.`)];
  return [
    bold(`  ${title}`),
    ...files.map((file) => `  ${summarizeDiffFile(file)}`),
  ];
}

export function renderDiffOverview(
  staged: readonly GitDiffFile[],
  unstaged: readonly GitDiffFile[],
): string[] {
  const stagedTotals = diffTotals(staged);
  const unstagedTotals = diffTotals(unstaged);
  const totalFiles = staged.length + unstaged.length;
  return [
    bold("  Diff browser"),
    dim(
      `  ${totalFiles} file(s) ${cyan("staged " + staged.length)} ${yellow("unstaged " + unstaged.length)} ` +
      `${symbolsLine(stagedTotals.additions, unstagedTotals.additions, stagedTotals.deletions, unstagedTotals.deletions)}`,
    ),
  ];
}

function symbolsLine(
  stagedAdditions: number,
  unstagedAdditions: number,
  stagedDeletions: number,
  unstagedDeletions: number,
): string {
  return `${green("+" + (stagedAdditions + unstagedAdditions))} ${red("-" + (stagedDeletions + unstagedDeletions))}`;
}

export function renderDiffPatchHeader(
  file: GitDiffFile,
  staged: boolean,
): string[] {
  return [
    bold(`  ${staged ? "Staged" : "Unstaged"} patch`),
    `  ${cyan(file.path)}`,
    `  ${dim(
      `${file.status} ${file.previousPath ? `· from ${file.previousPath} ` : ""}· +${file.additions} -${file.deletions}`,
    )}`,
  ];
}

export function truncateDiffPatch(patch: string, maxLines = 220): string {
  const lines = patch.trimEnd().split("\n");
  if (lines.length <= maxLines) return patch.trimEnd();
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n${dim(`… truncated after ${maxLines} lines`)}` 
  );
}
