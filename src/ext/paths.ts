import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Extension directory resolution (B2, docs/09).
 *
 * Skills and custom commands are discovered from `.agents` (preferred) or
 * `.agent` directories at two scopes:
 *   - user-level:    $HARNESS_HOME/.agents / ~/.agents
 *   - workdir-level: <cwd>/.agents
 *
 * Workdir entries override user entries on a name clash, so a project can
 * specialize a globally-defined skill/command. Each scope has `skills/` and
 * `commands/` subdirectories (and a reserved `hooks/` slot for a later round).
 */

export type ExtScope = "user" | "project";

export interface ExtRoot {
  scope: ExtScope;
  /** Absolute path to the `.agent` (or `.agents`) directory. */
  dir: string;
}

/** Base directory for the user-level extension dir (honors $HARNESS_HOME). */
function userBase(): string {
  return process.env.HARNESS_HOME ?? homedir();
}

/** All existing `.agents`/`.agent` dirs under `base` (both, if both exist). */
function existingRoots(base: string): string[] {
  const found: string[] = [];
  for (const name of [".agent", ".agents"]) {
    const dir = join(base, name);
    if (existsSync(dir)) found.push(dir);
  }
  return found;
}

/**
 * Resolve the active extension roots, user scope first then project scope.
 * Both `.agents` and `.agent` are scanned at each scope (a user may have either
 * or both). `.agents` is preferred when both exist at the same scope. Callers
 * that merge by name should let later (project) entries win.
 */
export function extRoots(cwd: string): ExtRoot[] {
  const roots: ExtRoot[] = [];
  const userDirs = existingRoots(userBase());
  for (const dir of userDirs) roots.push({ scope: "user", dir });
  for (const dir of existingRoots(cwd)) {
    // Don't double-count when cwd === userBase (e.g. running from home).
    if (!userDirs.includes(dir)) roots.push({ scope: "project", dir });
  }
  return roots;
}
