import { spawnSync } from "node:child_process";

/**
 * Tiny git helpers (#2 diff, #10 branch). Parameterized spawnSync (shell:false)
 * so no value is ever interpolated into a shell string. All functions degrade
 * gracefully when git is missing or the directory isn't a repo — they return
 * null/empty rather than throwing, so callers can show a friendly message.
 */

/** Run git with args in `cwd`, returning stdout (or null on any failure). */
function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (r.status !== 0 || r.error) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  const out = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out?.trim() === "true";
}

/**
 * Current branch name, or null if not a repo / git missing / detached HEAD
 * (in which case the short commit is returned instead when available).
 */
export function gitBranch(cwd: string): string | null {
  const out = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (out === null) return null;
  const name = out.trim();
  if (!name) return null;
  if (name === "HEAD") {
    // Detached: fall back to the short SHA so the footer still says something.
    const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
    return sha ? sha.trim() : null;
  }
  return name;
}

/**
 * Cached wrapper over gitBranch for the prompt footer (#10). The footer is
 * reprinted before every prompt, but the branch rarely changes; spawning git
 * each time would be wasteful. Results are cached per-cwd for `ttlMs` (default
 * 5s) so a `git checkout` between prompts is still picked up promptly.
 */
const branchCache = new Map<string, { value: string | null; at: number }>();

export function gitBranchCached(cwd: string, ttlMs = 5000): string | null {
  const now = Date.now();
  const hit = branchCache.get(cwd);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = gitBranch(cwd);
  branchCache.set(cwd, { value, at: now });
  return value;
}

/** Drop cached branch data (used by tests and after a known branch change). */
export function clearBranchCache(): void {
  branchCache.clear();
}

/**
 * Working-tree diff. With `staged`, shows the index diff (`--staged`).
 * Returns the raw unified diff (possibly empty), or null if not a repo.
 */
export function gitDiff(cwd: string, opts: { staged?: boolean } = {}): string | null {
  if (!isGitRepo(cwd)) return null;
  const args = ["--no-pager", "diff", "--no-color"];
  if (opts.staged) args.push("--staged");
  return git(cwd, args);
}
