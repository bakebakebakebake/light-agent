import type { Config } from "../config.js";
import type { ModelProvider } from "../model/types.js";
import type { Message } from "../model/types.js";
import type { Session } from "../sessions.js";
import type { PermissionMode } from "../permissions/policy.js";
import type { TodoItem } from "../todos.js";
import { fuzzyScore } from "../ui/menu.js";
import { logger } from "../util/logger.js";
import type { McpServerStatus } from "../mcp/types.js";
import type { PendingAttachment } from "../pendingContext.js";

/**
 * Slash-command system (docs/08).
 *
 * Anything the user types starting with "/" is a command, not a prompt for the
 * model. Commands manage profiles and runtime config and can mutate session
 * state live — e.g. switching a profile rebuilds the provider in place without
 * restarting the process.
 *
 * Commands receive `ask` (the single trusted stdin channel — keys are typed by
 * the real user, never fabricated or echoed, docs/04) and `out` (the styled
 * writer), so the registry stays decoupled from readline and stdout.
 */

/** Mutable per-session state the commands act on. */
export interface SessionState {
  config: Config;
  provider: ModelProvider;
  /** Name of the active profile, or null when running off env/.env fallback. */
  profileName: string | null;
  /** Conversation history (shared with the agent loop; /clear empties it). */
  history: Message[];
  /** The persisted session this conversation maps to (feature #6). */
  session: Session;
  /** Active permission mode (feature #5); mirrors the live PermissionPolicy. */
  mode: PermissionMode;
  /** Approx context usage from the last turn (feature #7). */
  usage: { input: number; output: number };
  /** Local estimate of the whole prompt footprint for the next turn. */
  estimateContext(): number;
  /** Session-scoped todo list shown via /todo and persisted in the session. */
  todos: TodoItem[];
  /** Always-on skill name/description catalog injected into the system prompt. */
  skillCatalog: string[];
  /**
   * Context to prepend to the NEXT turn only (B2 Skills): a chosen skill's body
   * is injected here, consumed by cli.ts, then cleared. Kept out of permanent
   * history so it doesn't bloat every subsequent request (progressive
   * disclosure). Treated as untrusted data, same as any tool output.
   */
  pendingContext: string[];
  /** Ordered next-turn attachments, e.g. selected skills or MCP server hints. */
  pendingAttachments: PendingAttachment[];
  /**
   * A prompt queued by a custom command to run as the next turn's input (B2).
   * cli.ts drains this after a command dispatch and feeds it to the agent loop.
   */
  queuedInput?: string;
  /**
   * A prompt seed to prefill the NEXT input box without auto-submitting it.
   * Used by rewind/interrupt flows so the user can edit and resend naturally.
   */
  seedInput?: string;
  /**
   * Re-resolve the active profile and rebuild config + provider in place.
   * Called after any command that changes which profile is active or its
   * fields, so the next turn uses the new settings with no restart.
   */
  rebuild(): void;
  /** Persist the current history into the session file (auto-save hook). */
  save(): void;
  /** Switch the permission mode live (updates state + the live policy). */
  setMode(mode: PermissionMode): void;
  /** Re-scan skills and refresh the cached prompt catalog. */
  refreshSkills(): void;
}

/** Everything a command needs to do its job. */
export interface CommandContext {
  state: SessionState;
  /** Prompt the real user and resolve with their typed line. The optional
   * `secret` flag mutes echo for sensitive input (API keys). */
  ask(prompt: string, opts?: { secret?: boolean }): Promise<string>;
  /** Write styled output to the terminal. */
  out(text: string): void;
  /**
   * Arrow-selectable picker (B1). Resolves the chosen value, or null if the
   * user cancels. Falls back to a numbered text prompt on non-TTY. Optional so
   * tests can supply a context without one.
   */
  pick?(prompt: string, items: PickItem[]): Promise<string | null>;
  /** Clear the screen (B5 immersive rewind/resume). Optional for the same reason. */
  clear?(): void;
  /** Current MCP server status snapshot for /mcp and badge rendering. */
  mcpStatus?(): McpServerStatus[];
}

/** A selectable item for the `pick` helper. */
export interface PickItem {
  label: string;
  value: string;
  hint?: string;
  selectable?: boolean;
  tone?: "green" | "dim";
}

/** A candidate row for the live `/` menu (B1). */
export type MenuCandidate = PickItem;

/** Result of running a command. */
export interface CommandResult {
  /** When true, the REPL should exit. */
  exit?: boolean;
}

/** A single slash command. */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  /** Extra search terms for the live slash menu. */
  keywords?: string[];
  /** Relative menu priority for empty-slash and tie-break ordering. */
  priority?: number;
  /** Dangerous commands are de-emphasized unless explicitly targeted. */
  dangerous?: boolean;
  /** Known subcommands (e.g. /profile use|new|edit|rm) — used for Tab completion. */
  subcommands?: string[];
  run(ctx: CommandContext, args: string[]): Promise<CommandResult>;
}

interface RankedCommand {
  command: SlashCommand;
  score: number;
  exact: boolean;
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function boundaryScore(text: string, query: string): number {
  const idx = text.indexOf(query);
  if (idx === -1) return 0;
  const prev = idx === 0 ? "" : text[idx - 1] ?? "";
  return idx === 0 || /[-_/.\s]/.test(prev) ? 1 : 0;
}

function fieldScore(text: string, raw: string): number | null {
  const hay = normalize(text);
  const query = normalize(raw);
  if (!hay || !query) return null;
  if (hay === query) return 5000;
  if (hay.startsWith(query)) return 4200 - Math.max(0, hay.length - query.length);
  const wordBoundary = boundaryScore(hay, query);
  if (wordBoundary > 0) return 3600 - hay.indexOf(query) * 8;
  const idx = hay.indexOf(query);
  if (idx >= 0) return 2800 - idx * 4;
  const fuzzy = fuzzyScore(hay, query);
  if (fuzzy === null) return null;
  return 1600 + fuzzy;
}

function commandRank(command: SlashCommand, raw: string): RankedCommand | null {
  const query = normalize(raw);
  if (!query) {
    const score =
      (command.priority ?? 0) +
      (command.dangerous ? -400 : 0) +
      (command.name === "help" ? 40 : 0);
    return { command, score, exact: false };
  }

  const names = [command.name, ...(command.aliases ?? [])];
  const keywordScore = Math.max(
    ...[...(command.keywords ?? []), ...names].map((value) => fieldScore(value, query) ?? -Infinity),
  );
  const nameScore = Math.max(...names.map((value) => fieldScore(value, query) ?? -Infinity));
  const descScore = fieldScore(command.description, query) ?? -Infinity;
  const best = Math.max(nameScore, keywordScore - 250, descScore - 800);
  if (!Number.isFinite(best)) return null;

  const exact = names.some((value) => normalize(value) === query);
  const prefix = names.some((value) => normalize(value).startsWith(query));
  let score = best + (command.priority ?? 0);
  if (exact) score += 8000;
  else if (prefix) score += 1600;
  if (command.dangerous && !exact && !prefix) score -= 2400;
  return { command, score, exact };
}

/** A registry of commands, indexed by name and alias. */
export class CommandRegistry {
  private readonly byName = new Map<string, SlashCommand>();
  private readonly ordered: SlashCommand[] = [];

  register(cmd: SlashCommand): void {
    this.ordered.push(cmd);
    this.byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) this.byName.set(a, cmd);
  }

  get(name: string): SlashCommand | undefined {
    return this.byName.get(name);
  }

  /** All registered commands in registration order (for /help). */
  list(): readonly SlashCommand[] {
    return this.ordered;
  }

  /**
   * Tab-completion candidates for a partial "/…" line (docs/08). Returns the
   * full replacement strings the readline completer should offer:
   *  - one token typed ("/mod") → matching command names ("/model").
   *  - a command + partial subcommand ("/profile us") → that command's known
   *    subcommands ("/profile use"), when it declares any.
   * Returns [] for anything that isn't a slash line so Tab stays inert in prose.
   */
  completions(line: string): string[] {
    if (!line.startsWith("/")) return [];
    const raw = line.slice(1);
    const parts = raw.split(/\s+/);

    // Still typing the command name (no trailing space yet).
    if (parts.length <= 1) {
      const prefix = parts[0] ?? "";
      return this.ordered
        .map((c) => "/" + c.name)
        .filter((s) => s.startsWith("/" + prefix));
    }

    // A command is chosen; offer its subcommands if it advertises any.
    const cmd = this.byName.get(parts[0] ?? "");
    const subs = cmd?.subcommands ?? [];
    if (subs.length === 0) return [];
    const subPrefix = parts[1] ?? "";
    return subs
      .filter((s) => s.startsWith(subPrefix))
      .map((s) => `/${parts[0]} ${s}`);
  }

  /**
   * Completion candidates formatted for DISPLAY (feature #3). Same matches as
   * `completions`, but when more than one matches, each top-level command is
   * suffixed with its description so Tab on `/` shows a labeled menu.
   *
   * The single-match case returns the bare string so readline completes the line
   * cleanly (no description text gets inserted). With multiple matches readline
   * only advances the line to the candidates' common prefix and prints the rest
   * as a column list, so the labels are safe to include.
   */
  completionsWithDescriptions(line: string): string[] {
    const cands = this.completions(line);
    if (cands.length <= 1) return cands;
    return cands.map((c) => {
      const name = c.slice(1).split(/\s+/)[0] ?? "";
      const command = this.byName.get(name);
      // Only label bare top-level command matches ("/model"), not subcommands.
      if (command && c === "/" + name) {
        return ("/" + name).padEnd(12) + "  " + command.description;
      }
      return c;
    });
  }


  /**
   * Candidates for the live `/` menu (B1). Returns rich items (command + its
   * description) filtered by what's typed so far, or null when the buffer isn't
   * a slash line (so the editor closes the menu). Only fires while the user is
   * still typing the command name — once there's a space, the menu closes and
   * normal editing continues.
   */
  menuItems(line: string): MenuCandidate[] | null {
    if (!line.startsWith("/")) return null;
    const raw = line.slice(1);
    if (/\s/.test(raw)) return null; // past the command name → no menu
    const matches = this.ordered
      .map((command) => commandRank(command, raw))
      .filter((entry): entry is RankedCommand => entry !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.exact) - Number(a.exact) ||
          a.command.name.localeCompare(b.command.name),
      )
      .map((entry) => entry.command);
    logger.debug("slash menu ranked", {
      query: raw,
      results: matches.slice(0, 6).map((cmd) => cmd.name),
    });
    if (matches.length === 0) return null;
    return matches.map((c) => ({
      label: "/" + c.name,
      value: "/" + c.name,
      hint: c.description,
    }));
  }

  /**
   * Parse and run a "/command args…" line. Returns the command's result, or a
   * plain `{}` after reporting an unknown command. The leading "/" is optional
   * in `line` (cli passes the raw input).
   */
  async dispatch(line: string, ctx: CommandContext): Promise<CommandResult> {
    const trimmed = line.trim().replace(/^\//, "");
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const name = parts[0] ?? "";
    const args = parts.slice(1);

    const cmd = this.byName.get(name);
    if (!cmd) {
      ctx.out(`Unknown command "/${name}". Type /help for the list.`);
      return {};
    }
    return cmd.run(ctx, args);
  }
}
