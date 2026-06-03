import {
  CommandRegistry,
  type SlashCommand,
  type CommandContext,
} from "./registry.js";
import { configCommand, modelCommand, profileCommand } from "./profileCommands.js";
import {
  debugCommand,
  diffCommand,
  searchCommand,
  skillCommand,
} from "./interactionCommands.js";
import {
  forgetCommand,
  memoryCommand,
  rememberCommand,
} from "./memoryCommands.js";
import {
  getActiveProfile,
  loadStore,
  saveStore,
  upsertProfile,
  type Profile,
} from "../profiles.js";
import {
  listSessions,
  loadSession,
  renameSession,
  newSession,
  deriveTitle,
} from "../sessions.js";
import type { PermissionMode } from "../permissions/policy.js";
import type { ThinkingDepth, Message } from "../model/types.js";
import { parseThinkingDepth } from "../config.js";
import { loadSkills } from "../ext/skills.js";
import { loadCustomCommandDefs, buildCustomCommands } from "../ext/commands.js";
import { loadMcpServerDefinitions } from "../ext/mcp.js";
import { loadRepoAgentConfig, saveRepoAgentConfig } from "../ext/repoConfig.js";
import { renderTranscript } from "../ui/transcript.js";
import { compactHistory } from "../loop/compact.js";
import { contextWindowFor } from "../model/contextWindow.js";
import { humanTokens, formatContextPercent } from "../ui/status.js";
import { bold, cyan, dim, green, yellow, red, symbols } from "../ui/theme.js";
import { cloneTodos, formatTodoList } from "../todos.js";
import {
  mcpAttachment,
  pushPendingAttachment,
  removePendingAttachment,
  clearPendingAttachmentsByKind,
} from "../pendingContext.js";

/**
 * Built-in slash commands (docs/08).
 *
 * These manage profiles and runtime config from inside the REPL. Commands that
 * change the active profile or its fields persist to the store and then call
 * state.rebuild() so the provider is swapped live — no restart.
 *
 * Security (docs/04): API keys are collected via ctx.ask (real user input) and
 * only ever shown masked. The raw key is never printed.
 */

/** Build the registry with all built-ins registered. */
export function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const cmd of BUILTINS) reg.register(cmd);
  // Commands needing a closure over the registry are registered last.
  reg.register(reloadCommand(reg));
  reg.register(helpCommand(reg));
  return reg;
}

const exitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit"],
  description: "Leave Light-Agent",
  priority: -200,
  dangerous: true,
  async run() {
    return { exit: true };
  },
};

const clearCommand: SlashCommand = {
  name: "clear",
  description: "Start a fresh conversation (clear history)",
  priority: -40,
  dangerous: true,
  async run(ctx) {
    ctx.state.history.length = 0;
    // Start a new persisted session so the cleared chat is saved separately.
    ctx.state.session = newSession({
      provider: ctx.state.config.provider,
      model: ctx.state.config.model,
    });
    ctx.state.todos = [];
    ctx.state.pendingContext = [];
    ctx.state.pendingAttachments = [];
    ctx.out(dim("  Conversation cleared."));
    return {};
  },
};

/**
 * /compact — summarize older turns into one note, keep the recent tail verbatim
 * (#1). Frees context without losing the thread. Auto-compaction near the
 * window limit reuses the same machinery (compactHistory) from cli.ts; this is
 * the manual trigger. After compacting, the screen is cleared and the shortened
 * conversation reprinted so the result is visible (身临其境).
 */
const compactCommand: SlashCommand = {
  name: "compact",
  description: "Summarize older turns to free up context",
  keywords: ["summarize", "context"],
  priority: 30,
  async run(ctx) {
    const { state } = ctx;
    if (state.history.length === 0) {
      ctx.out(dim("  Nothing to compact — the conversation is empty."));
      return {};
    }
    const usedBefore = state.estimateContext();
    ctx.out(dim("  Compacting…"));
    let result;
    try {
      result = await compactHistory(state.provider, state.history);
    } catch (err) {
      ctx.out(red(`  Compaction failed: ${(err as Error).message}`));
      return {};
    }
    if (result.collapsed === 0) {
      ctx.out(dim("  Not enough history to compact yet."));
      return {};
    }
    // Replace history in place (cli.ts and the loop share this array reference).
    state.history.length = 0;
    state.history.push(...result.messages);
    state.save();

    if (ctx.clear) ctx.clear();
    renderTranscript(state.history, ctx.out);
    const total = contextWindowFor(state.config.model, state.config.contextWindow);
    ctx.out(
      dim(
        `  Compacted ${result.collapsed} message(s) into a summary ` +
          `(${formatContextPercent(usedBefore, total)} context before compaction).`,
      ),
    );
    return {};
  },
};

/** Format an ISO timestamp as a short, locale-stable "YYYY-MM-DD HH:MM". */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

const resumeCommand: SlashCommand = {
  name: "resume",
  description: "List saved conversations, or resume one by number/id",
  keywords: ["session", "conversation", "history"],
  priority: 100,
  async run(ctx, args) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      ctx.out(dim("  No saved conversations yet."));
      return {};
    }
    const target = args[0];
    let id: string | null = null;

    if (!target && ctx.pick) {
      // Arrow picker of recent sessions (B1).
      const items = sessions.slice(0, 20).map((s) => ({
        label: s.title,
        value: s.id,
        hint: `${shortTime(s.updatedAt)} ${symbols.dot} ${s.messageCount} msgs`,
      }));
      const choice = await ctx.pick("  Resume which conversation?", items);
      if (choice === null) {
        ctx.out(dim("  Resume cancelled."));
        return {};
      }
      id = choice;
    } else if (!target) {
      // Non-TTY / no picker: list with timestamps (feature #6).
      const rows = sessions.slice(0, 20).map((s, i) => {
        const active = s.id === ctx.state.session.id;
        const marker = active ? green(symbols.tool) : `${i + 1})`;
        return (
          `  ${marker} ${bold(s.title)} ` +
          dim(`${symbols.dot} ${shortTime(s.updatedAt)} ${symbols.dot} ${s.messageCount} msgs`)
        );
      });
      ctx.out(rows.join("\n"));
      ctx.out(dim("  Resume with /resume <number> or /resume <id>."));
      return {};
    } else {
      // Resolve by 1-based number from the list, or by (prefix of) id.
      id = target;
      const n = Number(target);
      if (Number.isInteger(n) && n >= 1 && n <= sessions.length) {
        id = sessions[n - 1]!.id;
      } else {
        const match = sessions.find((s) => s.id === target || s.id.startsWith(target));
        if (match) id = match.id;
      }
    }

    const session = loadSession(id);
    if (!session) {
      ctx.out(red(`  No conversation "${target ?? id}".`));
      return {};
    }
    // Swap history in place so the agent loop (which holds the same array
    // reference) keeps working, then point state at the resumed session.
    ctx.state.history.length = 0;
    ctx.state.history.push(...session.messages);
    ctx.state.session = session;
    ctx.state.todos = cloneTodos(session.todos ?? []);
    // Immersive re-render: show the resumed conversation as if you'd been in it.
    reprintTranscript(ctx);
    ctx.out(
      dim(`  Resumed "${session.title}" `) +
        dim(`(${session.messages.length} messages, ${shortTime(session.updatedAt)}).`),
    );
    return {};
  },
};

const todoCommand: SlashCommand = {
  name: "todo",
  description: "Show the current session todo list",
  priority: 70,
  async run(ctx) {
    ctx.out(bold("  Session todo"));
    ctx.out("  " + formatTodoList(ctx.state.todos).split("\n").join("\n  "));
    return {};
  },
};

const renameCommand: SlashCommand = {
  name: "rename",
  description: "Rename the current conversation",
  async run(ctx, args) {
    const title = args.join(" ").trim();
    if (!title) {
      ctx.out(dim(`  Current title: ${bold(ctx.state.session.title)}`));
      ctx.out(dim("  Usage: /rename <new title>"));
      return {};
    }
    ctx.state.session.title = title;
    // Persist immediately (renameSession is a no-op if never saved yet, so
    // also save the live session to be safe).
    renameSession(ctx.state.session.id, title);
    ctx.state.save();
    ctx.out(green(`  Renamed to "${title}".`));
    return {};
  },
};

/**
 * /usage — a fuller snapshot of the live session (#9): model, permission mode,
 * reasoning depth, and context-window consumption (whole current prompt vs.
 * the model's window). Complements the always-on one-line footer.
 */
const usageCommand: SlashCommand = {
  name: "usage",
  aliases: ["status", "ctx"],
  description: "Show model, mode, thinking depth, and context usage",
  keywords: ["context", "tokens"],
  priority: 80,
  async run(ctx) {
    const { config, mode, usage } = ctx.state;
    const total = contextWindowFor(config.model, config.contextWindow);
    const used = ctx.state.estimateContext();
    const bar = usageBar(used, total);
    const depth = config.thinkingDepth ?? "off";
    const overridden = config.contextWindow ? dim(" (override)") : "";
    const lines = [
      bold("  Session usage"),
      `  ${dim("model")}    ${cyan(config.model)}`,
      `  ${dim("mode")}     ${cyan(mode)}`,
      `  ${dim("thinking")} ${cyan(depth)}`,
      `  ${dim("context")}  ${bar} ${dim(
        `${humanTokens(used)}/${humanTokens(total)} (${formatContextPercent(used, total)})`,
      )}${overridden}`,
      `  ${dim("last call")} ${dim(
        `${humanTokens(usage.input)} in ${symbols.dot} ${humanTokens(usage.output)} out`,
      )}`,
    ];
    ctx.out(lines.join("\n"));
    return {};
  },
};

/** A compact 20-cell context-fill bar, color-graded by fullness. */
function usageBar(used: number, total: number): string {
  const width = 20;
  const frac = total > 0 ? Math.min(1, used / total) : 0;
  const filled = Math.round(frac * width);
  const fill = "█".repeat(filled);
  const rest = "░".repeat(width - filled);
  const colored = frac >= 0.85 ? red(fill) : frac >= 0.6 ? yellow(fill) : green(fill);
  return colored + dim(rest);
}

const MODE_NAMES: Record<string, PermissionMode> = {
  default: "default",
  plan: "plan",
  acceptedits: "acceptEdits",
  "accept-edits": "acceptEdits",
  acceptedit: "acceptEdits",
  allowall: "allowAll",
  "allow-all": "allowAll",
  all: "allowAll",
};

const MODE_HELP: Array<[PermissionMode, string]> = [
  ["default", "ask before risky actions (edits notify, bash confirms)"],
  ["plan", "read-only: no file edits or commands"],
  ["acceptEdits", "auto-approve file edits; still confirm bash"],
  ["allowAll", "auto-approve everything (use with care)"],
];

const modeCommand: SlashCommand = {
  name: "mode",
  description: "Show or set the permission mode (default|plan|acceptEdits|allowAll)",
  keywords: ["permission", "plan", "allow"],
  priority: 130,
  subcommands: ["default", "plan", "acceptEdits", "allowAll"],
  async run(ctx, args) {
    let value = (args[0] ?? "").trim().toLowerCase();
    if (!value && ctx.pick) {
      const choice = await ctx.pick(
        `  Permission mode ${dim(`(now: ${ctx.state.mode})`)}`,
        MODE_HELP.map(([mode, desc]) => ({
          label: mode,
          value: mode,
          hint: desc,
        })),
      );
      if (!choice) {
        ctx.out(dim("  Unchanged."));
        return {};
      }
      value = choice.toLowerCase();
    }
    if (!value) {
      ctx.out(`  ${dim("mode")} ${cyan(ctx.state.mode)}`);
      for (const [m, desc] of MODE_HELP) {
        const mark = m === ctx.state.mode ? green(symbols.tool) : " ";
        ctx.out(`  ${mark} ${cyan(m.padEnd(12))} ${dim(desc)}`);
      }
      return {};
    }
    const mode = MODE_NAMES[value];
    if (!mode) {
      ctx.out(red(`  Unknown mode "${args[0]}". Try: default, plan, acceptEdits, allowAll.`));
      return {};
    }
    ctx.state.setMode(mode);
    ctx.out(green(`  Mode set to ${mode}.`));
    return {};
  },
};

const rewindCommand: SlashCommand = {
  name: "rewind",
  description: "Jump back to an earlier turn (truncate later history)",
  keywords: ["history", "undo", "back"],
  priority: 60,
  async run(ctx, args) {
    // Index every user turn (text messages, not tool_result user messages).
    const turns: Array<{ index: number; title: string; text: string }> = [];
    ctx.state.history.forEach((m, i) => {
      if (m.role !== "user") return;
      const text = userTextOf(m);
      if (text) turns.push({ index: i, title: deriveTitle([m], 60), text });
    });

    if (turns.length === 0) {
      ctx.out(dim("  Nothing to rewind to yet."));
      return {};
    }

    const arg = (args[0] ?? "").trim();
    let targetIndex: number | null = null;
    let targetText = "";

    if (!arg && ctx.pick) {
      // Arrow picker of turns, newest-first (B1). The visible re-render is the
      // confirmation — no separate y/N.
      const items = turns
        .map((t, i) => ({ label: `${i + 1}. ${t.title}`, value: String(t.index) }))
        .reverse();
      const choice = await ctx.pick("  Rewind to which turn?", items);
      if (choice === null) {
        ctx.out(dim("  Rewind cancelled."));
        return {};
      }
      targetIndex = Number(choice);
      targetText = turns.find((t) => t.index === targetIndex)?.text ?? "";
    } else if (!arg) {
      // Non-TTY / no picker: list turns newest-first with a 1-based number.
      const rows = turns.map((t, i) => `  ${i + 1}) ${t.title}`).reverse();
      ctx.out(rows.join("\n"));
      ctx.out(dim("  Rewind with /rewind <number> (drops that turn and everything after)."));
      return {};
    } else {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > turns.length) {
        ctx.out(red(`  No turn "${arg}". Use /rewind to list turns.`));
        return {};
      }
      targetIndex = turns[n - 1]!.index;
      targetText = turns[n - 1]!.text;
    }

    // Truncate in place so the loop's shared array reference stays valid.
    ctx.state.history.length = targetIndex;
    if (targetText) ctx.state.seedInput = targetText;
    ctx.state.save();
    // Immersive re-render: clear the screen and reprint the conversation up to
    // the rewind point, so the screen shows exactly the state you jumped to.
    reprintTranscript(ctx);
    ctx.out(dim(`  Rewound — ${targetIndex} message(s) kept.`));
    return {};
  },
};

function userTextOf(m: Message): string {
  return m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Clear the screen and reprint the conversation (A3 + B5 immersive jump). */
function reprintTranscript(ctx: CommandContext): void {
  if (ctx.clear) {
    ctx.clear();
    renderTranscript(ctx.state.history, ctx.out);
  }
}

const THINKING_HELP: Array<[ThinkingDepth, string]> = [
  ["off", "no extended reasoning (fastest)"],
  ["low", "a little reasoning before answering"],
  ["medium", "moderate reasoning budget"],
  ["high", "maximum reasoning budget (slowest)"],
];

function patchActiveProfile(
  ctx: CommandContext,
  patch: Partial<Profile>,
): boolean {
  const name = ctx.state.profileName;
  if (!name) return false;
  const store = loadStore();
  const current = getActiveProfile(store);
  if (!current) return false;
  upsertProfile(store, name, { ...current, ...patch });
  saveStore(store);
  ctx.state.rebuild();
  return true;
}

const thinkingCommand: SlashCommand = {
  name: "thinking",
  aliases: ["think"],
  description: "Show or set reasoning depth (off|low|medium|high)",
  keywords: ["reasoning", "depth"],
  priority: 65,
  subcommands: ["off", "low", "medium", "high"],
  async run(ctx, args) {
    const current = ctx.state.config.thinkingDepth ?? "off";
    let value = (args[0] ?? "").trim().toLowerCase();
    // No arg: arrow-picker when available, else just show the current value.
    if (!value && ctx.pick) {
      const choice = await ctx.pick(
        `  Reasoning depth ${dim(`(now: ${current})`)}`,
        THINKING_HELP.map(([d, desc]) => ({ label: d, value: d, hint: desc })),
      );
      if (!choice) {
        ctx.out(dim("  Unchanged."));
        return {};
      }
      value = choice;
    } else if (!value) {
      ctx.out(`  ${dim("thinking")} ${cyan(current)}`);
      for (const [d, desc] of THINKING_HELP) {
        const mark = d === current ? green(symbols.tool) : " ";
        ctx.out(`  ${mark} ${cyan(d.padEnd(8))} ${dim(desc)}`);
      }
      return {};
    }
    const depth = parseThinkingDepth(value);
    if (patchActiveProfile(ctx, { thinkingDepth: depth })) {
      ctx.out(green(`  Reasoning depth set to ${depth}.`));
    } else {
      // No profile to persist to (env/.env): still apply for this session.
      ctx.state.config = { ...ctx.state.config, thinkingDepth: depth };
      ctx.out(green(`  Reasoning depth set to ${depth} (session only).`));
    }
    return {};
  },
};

const keysCommand: SlashCommand = {
  name: "keys",
  description: "Show keyboard shortcuts",
  keywords: ["shortcuts", "keyboard"],
  priority: 10,
  async run(ctx) {
    const row = (k: string, d: string): string => `  ${cyan(k.padEnd(10))} ${dim(d)}`;
    ctx.out(
      [
        bold("  Keyboard shortcuts"),
        row("/", "open the command menu (↑↓ to select, Enter to run)"),
        row("↑ / ↓", "previous / next input from history"),
        row("Enter", "send · Alt-Enter (or trailing \\) inserts a newline"),
        row("Ctrl-A/E", "jump to line start / end"),
        row("Ctrl-K/U", "delete to end / clear the line"),
        row("Ctrl-W", "delete the previous word"),
        row("Ctrl-L", "clear the screen"),
        row("Ctrl-C", "stop the turn (refills your question) · twice to quit"),
        row("Esc", "abort the turn · double Esc on an empty prompt opens /rewind"),
      ].join("\n"),
    );
    return {};
  },
};
const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show, attach, or remove MCP server hints",
  keywords: ["server", "tools"],
  priority: 90,
  subcommands: ["list", "use", "attach", "remove", "detach", "rm", "clear"],
  async run(ctx, args) {
    const defs = loadMcpServerDefinitions(ctx.state.config.workdir);
    const status = ctx.mcpStatus?.() ?? [];
    if (defs.length === 0 && status.length === 0) {
      ctx.out(dim("  No MCP servers configured. Add JSON files under .agents/mcp or .agent/mcp."));
      return {};
    }
    const sub = (args[0] ?? "").trim().toLowerCase();

    const queueServer = (name: string): boolean => {
      const def = defs.find((item) => item.name === name.toLowerCase());
      if (!def) return false;
      pushPendingAttachment(ctx.state, mcpAttachment(def.name, def.description));
      return true;
    };

    if (sub === "clear") {
      clearPendingAttachmentsByKind(ctx.state, "mcp");
      ctx.out(green("  Cleared attached MCP servers."));
      return {};
    }
    if (sub === "use" || sub === "attach") {
      const name = args.slice(1).join(" ").trim().toLowerCase();
      if (!name) {
        ctx.out(dim("  Usage: /mcp use <server>"));
        return {};
      }
      if (!queueServer(name)) {
        ctx.out(red(`  No MCP server "${name}". Type /mcp list to inspect configured servers.`));
        return {};
      }
      ctx.state.seedInput ??= "";
      return {};
    }
    if (sub === "remove" || sub === "detach" || sub === "rm") {
      const name = args.slice(1).join(" ").trim().toLowerCase();
      if (!name) {
        ctx.out(dim(`  Usage: /mcp ${sub} <server>`));
        return {};
      }
      if (!removePendingAttachment(ctx.state, "mcp", name)) {
        ctx.out(dim(`  MCP server "${name}" is not currently attached.`));
        return {};
      }
      ctx.out(green(`  Removed MCP server "${name}" from the next message.`));
      return {};
    }

    if (!sub && ctx.pick) {
      const items: Array<{
        label: string;
        value: string;
        hint?: string;
        selectable?: boolean;
        tone?: "dim";
      }> = [
        { label: "Available MCP servers", value: "__available__", selectable: false, tone: "dim" as const },
      ];
      for (const def of defs) {
        const live = status.find((item) => item.name === def.name);
        items.push({
          label: def.name,
          value: `use:${def.name}`,
          hint:
            `${live?.connected ? "connected" : "idle"} ${symbols.dot} ` +
            `${live?.loadedTools ?? 0} tool(s) ${symbols.dot} ${def.scope}` +
            (def.description ? ` ${symbols.dot} ${def.description}` : ""),
        });
      }
      const picked = await ctx.pick("  Choose an MCP server", items);
      if (!picked) return {};
      if (picked.startsWith("use:")) {
        const target = picked.slice("use:".length);
        queueServer(target);
        ctx.state.seedInput ??= "";
        return {};
      }
    }

    if (sub && sub !== "list") {
      ctx.out(red(`  Unknown subcommand "/mcp ${args[0]}". Try: list.`));
      return {};
    }
    ctx.out(bold("  MCP servers"));
    for (const def of defs) {
      const live = status.find((item) => item.name === def.name);
      ctx.out(
        `  ${cyan(def.name.padEnd(16))} ${dim(
          `${live?.connected ? "connected" : "idle"} ${symbols.dot} ` +
          `${live?.loadedTools ?? 0} tool(s) ${symbols.dot} ${def.scope}`,
        )}`,
      );
      ctx.out(
        `  ${dim(" ".repeat(18) + def.command + (def.args?.length ? ` ${def.args.join(" ")}` : ""))}`,
      );
      if (def.description) ctx.out(`  ${dim(" ".repeat(18) + def.description)}`);
    }
    ctx.out(dim("  Matching tools are still loaded on demand through mcp_search."));
    ctx.out(dim("  Attach one with /mcp use <server> so the next turn prefers that server."));
    return {};
  },
};

const protectCommand: SlashCommand = {
  name: "protect",
  description: "Manage blocked model commands and protected paths",
  keywords: ["safety", "guard", "block"],
  priority: 88,
  subcommands: ["list", "add", "rm"],
  async run(ctx, args) {
    const cwd = ctx.state.config.workdir;
    const config = loadRepoAgentConfig(cwd);
    const sub = (args[0] ?? "list").trim().toLowerCase();

    const printSummary = (): void => {
      ctx.out(bold("  Repo protections"));
      ctx.out(`  ${dim("blocked commands")} ${config.blockedCommands.length}`);
      for (const pattern of config.blockedCommands) ctx.out(`    ${pattern}`);
      ctx.out(`  ${dim("protected paths")} ${config.protectedPaths.length}`);
      for (const path of config.protectedPaths) ctx.out(`    ${path}`);
    };

    if (sub === "list") {
      printSummary();
      return {};
    }

    const action = (args[1] ?? "").trim().toLowerCase();
    const value = args.slice(2).join(" ").trim();
    if (!["add", "rm"].includes(sub) || !["command", "path"].includes(action) || !value) {
      ctx.out(dim("  Usage: /protect list"));
      ctx.out(dim("         /protect add command <pattern>"));
      ctx.out(dim("         /protect rm command <pattern>"));
      ctx.out(dim("         /protect add path <path>"));
      ctx.out(dim("         /protect rm path <path>"));
      return {};
    }

    if (action === "command") {
      const next = new Set(config.blockedCommands);
      if (sub === "add") next.add(value.toLowerCase());
      else next.delete(value.toLowerCase());
      saveRepoAgentConfig(cwd, { ...config, blockedCommands: [...next] });
      ctx.out(green(`  ${sub === "add" ? "Added" : "Removed"} blocked command pattern "${value}".`));
      return {};
    }

    const next = new Set(config.protectedPaths);
    if (sub === "add") next.add(value);
    else next.delete(value);
    saveRepoAgentConfig(cwd, { ...config, protectedPaths: [...next] });
    ctx.out(green(`  ${sub === "add" ? "Added" : "Removed"} protected path "${value}".`));
    return {};
  },
};

/** /reload — re-scan extension dirs for skills and custom commands (B2). */
function reloadCommand(reg: CommandRegistry): SlashCommand {
  return {
    name: "reload",
    description: "Re-scan .agents/.agent dirs for skills and custom commands",
    async run(ctx) {
      const defs = loadCustomCommandDefs(ctx.state.config.workdir);
      for (const c of buildCustomCommands(defs)) reg.register(c);
      ctx.state.refreshSkills();
      const skills = loadSkills(ctx.state.config.workdir);
      ctx.out(
        green(`  Reloaded: ${defs.length} command(s), ${skills.size} skill(s).`),
      );
      return {};
    },
  };
}
function helpCommand(reg: CommandRegistry): SlashCommand {
  return {
    name: "help",
    aliases: ["?"],
    description: "Show this help",
    async run(ctx) {
      const fmt = (name: string, desc: string): string =>
        `  ${cyan(("/" + name).padEnd(18))} ${dim(desc)}`;
      // reg.list() already includes /help (registered in buildRegistry).
      const lines = reg.list().map((c) => fmt(c.name, c.description));
      ctx.out(
        bold("  Commands") +
          "\n" +
          lines.join("\n") +
          "\n" +
          dim("  Anything else is sent to the agent. ") +
          dim("Type ") +
          cyan("/") +
          dim(" then Tab to browse commands, or ") +
          cyan("/keys") +
          dim(" for keyboard shortcuts."),
      );
      return {};
    },
  };
}

/** Every built-in except /help and /reload (which need the registry). */
const BUILTINS: SlashCommand[] = [
  exitCommand,
  clearCommand,
  compactCommand,
  diffCommand,
  todoCommand,
  memoryCommand,
  rememberCommand,
  forgetCommand,
  configCommand,
  usageCommand,
  debugCommand,
  profileCommand,
  modelCommand,
  mcpCommand,
  protectCommand,
  searchCommand,
  thinkingCommand,
  skillCommand,
  resumeCommand,
  renameCommand,
  modeCommand,
  rewindCommand,
  keysCommand,
];
