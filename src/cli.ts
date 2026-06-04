#!/usr/bin/env node

import { stdout } from "node:process";
import { resolveConfig, isConfigured, type Config } from "./config.js";
import { collectOnboarding, applyOnboarding } from "./onboarding.js";
import { createProvider } from "./model/index.js";
import { defaultRegistry } from "./tools/registry.js";
import { runAgentLoop } from "./loop/agentLoop.js";
import { compactHistory, compactModeForUsage } from "./loop/compact.js";
import type { SessionState } from "./commands/registry.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { createGate, type Confirmer, type ConfirmRequest } from "./permissions/confirm.js";
import { Renderer } from "./ui/render.js";
import { box, bold, cyan, dim, red, symbols, visibleWidth, yellow } from "./ui/theme.js";
import { statusLine, workdirLine } from "./ui/status.js";
import { contextWindowFor } from "./model/contextWindow.js";
import { beside, mascot, mascotTagline } from "./ui/mascot.js";
import { InterruptController } from "./ui/interrupt.js";
import { LineReader } from "./ui/input.js";
import { renderTranscript, transcriptLines } from "./ui/transcript.js";
import { appendPromptBlocks, systemPrompt } from "./prompt.js";
import { buildRegistry } from "./commands/builtins.js";
import { loadStore, storePath } from "./profiles.js";
import { newSession, saveSession, deriveTitle } from "./sessions.js";
import { loadCustomCommandDefs, buildCustomCommands } from "./ext/commands.js";
import { loadSkills, formatSkillCatalog } from "./ext/skills.js";
import { type Skill } from "./ext/skills.js";
import { loadRepoAgentConfig } from "./ext/repoConfig.js";
import { searchFiles } from "./ext/fileSearch.js";
import { runForegroundShell } from "./util/shell.js";
import { gitBranchCached } from "./util/git.js";
import { cloneTodos, type TodoItem } from "./todos.js";
import { ToolRegistry } from "./tools/registry.js";
import type { Message } from "./model/types.js";
import type { LoopStopReason } from "./loop/types.js";
import type { SubagentRequest, SubagentResult } from "./subagents.js";
import { LocalMcpRuntime } from "./mcp/runtime.js";
import { estimateContextTokens } from "./model/contextEstimate.js";
import { formatContextPercent } from "./ui/status.js";
import { formatMemoryContext, retrieveMemoryContext } from "./memory/retrieve.js";
import { appendTranscriptMessages, readTranscriptTurns } from "./memory/transcript.js";
import { extractAndApplyMemory } from "./memory/extract.js";
import { writeCoreDigest } from "./memory/digest.js";
import { logger } from "./util/logger.js";
import { classifyRuntimeError } from "./util/errors.js";
import {
  consumeImagePathsFromText,
  detectDroppedImagePaths,
  enforceVisionMode,
  importClipboardImage,
} from "./util/images.js";
import { runSchedulerDaemon } from "./scheduler/runner.js";
import {
  attachmentBadges,
  groupPendingAttachments,
  imageAttachment,
  pendingUserContent,
  popPendingAttachment,
  pushPendingAttachment,
  removePendingAttachment,
  skillAttachment,
} from "./pendingContext.js";

function attachSkillToState(state: SessionState, skill: Skill): void {
  pushPendingAttachment(state, skillAttachment(skill));
}

function detachLastPendingAttachment(state: SessionState): boolean {
  return popPendingAttachment(state) !== null;
}

/**
 * CLI entry — the REPL that wires every module together (docs/01, docs/08).
 *
 * Input is owned by LineReader (readline in cooked mode): ↑/↓ history, Tab
 * completion of slash commands, line editing, correct CJK input, and native
 * terminal selection/copy. The renderer adapts loop events to the terminal; the
 * confirmer reads approval from real stdin (the only trusted approval channel —
 * injection defense, docs/04); Ctrl-C interrupts a turn. Slash commands manage
 * profiles/config and can rebuild the provider live.
 */

async function main(): Promise<void> {
  const commands = buildRegistry();
  // Load project/user extension commands (B2) so they appear in the menu/help.
  reloadExtensions(commands);
  let state: SessionState | null = null;
  let replayIdleViewport: ((reservedRows: number) => void) | null = null;
  let replayStreamingViewport: (() => void) | null = null;
  // One stdin consumer (raw mode): a live `/` command menu, arrow pickers,
  // multiline input, and Ctrl-C that interrupts but never exits (B1/B3/B4).
  const reader = new LineReader({
    complete: (line) => commands.completions(line),
    menu: (line) => commands.menuItems(line),
    // `@` file-mention menu (#4): search the workdir for the typed query and
    // offer matching paths; accepting inserts the path in place of the @token.
    fileMenu: (query) => {
      const hits = searchFiles(process.cwd(), query, 12);
      if (hits.length === 0) return null;
      return hits.map((h) => ({
        label: h.path,
        value: h.path,
        ...(h.dir ? { hint: h.dir } : {}),
      }));
    },
    skillMenu: (query) => {
      const skills = [...loadSkills(process.cwd()).values()];
      if (skills.length === 0) return null;
      const needle = query.trim().toLowerCase();
      const filtered = skills
        .map((skill) => {
          const name = skill.name.toLowerCase();
          const desc = skill.description.toLowerCase();
          let score = 0;
          if (!needle) score = 1;
          else if (name === needle) score = 5000;
          else if (name.startsWith(needle)) score = 4200;
          else if (name.includes(needle)) score = 3000;
          else if (desc.includes(needle)) score = 800;
          return { skill, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
        .slice(0, 12)
        .map(({ skill }) => ({
          label: skill.name,
          value: skill.name,
          hint:
            `${skill.scopeLabel} ${symbols.dot} ~${skill.approxTokens} tok` +
            (skill.description ? ` ${symbols.dot} ${skill.description}` : ""),
        }));
      return filtered.length > 0 ? filtered : null;
    },
    attachSkill: (skillName) => {
      if (!state) return;
      const skill = loadSkills(process.cwd()).get(skillName.toLowerCase());
      if (!skill) return;
      attachSkillToState(state, skill);
    },
    attachClipboardImage: () => {
      if (!state) throw new Error("Session is not ready for attachments yet.");
      const image = importClipboardImage();
      pushPendingAttachment(state, imageAttachment(image));
      state.seedInput ??= "";
    },
    attachDroppedImages: (text) => {
      if (!state) return false;
      const images = detectDroppedImagePaths(text, state.config.workdir);
      if (images.length === 0) return false;
      for (const image of images) {
        pushPendingAttachment(state, imageAttachment(image));
      }
      state.seedInput ??= "";
      return true;
    },
    badges: () => (state ? attachmentBadges(state.pendingAttachments) : []),
    detachLastSkill: () => (state ? detachLastPendingAttachment(state) : false),
    attachments: () =>
      state
        ? groupPendingAttachments(state.pendingAttachments)
        : { skills: [], mcps: [], images: [] },
    detachAttachment: (kind, label) =>
      state ? removePendingAttachment(state, kind, label) : false,
    // Tint the input frame cyan in plan mode (#8). `state` is initialized below
    // and this runs lazily on each draw, so it always sees the live mode.
    planMode: () => state?.mode === "plan",
    // Bottom-left footer beneath the frame: workdir + cached git branch (#10).
    footer: () =>
      state
        ? workdirLine({
            workdir: state.config.workdir,
            branch: gitBranchCached(state.config.workdir),
          })
        : "",
    replayViewport: (reservedRows) => replayIdleViewport?.(reservedRows),
  });
  const ask = (prompt: string, opts?: { secret?: boolean }): Promise<string> =>
    opts?.secret ? reader.askSecret(prompt) : reader.ask(prompt);

  // First-run onboarding (docs/08): if nothing is configured, walk the user
  // through setup (saved as a profile), then continue into the REPL. The API
  // key is typed by the real user here — never fabricated or echoed.
  if (!isConfigured()) {
    stdout.write(mascot() + "\n");
    stdout.write(
      "  " +
        bold("Welcome to Light-Agent.") +
        dim(" No credentials found — let's set one up.\n") +
        dim(`  (Saved to ${storePath()}, locked to your user.)\n\n`),
    );
    try {
      const result = await collectOnboarding(ask, undefined, (prompt, items) => reader.pick(prompt, items));
      if (!result.entries.ANTHROPIC_API_KEY && !result.entries.OPENAI_API_KEY) {
        stdout.write("\n  No API key entered. Exiting — run again when ready.\n");
        reader.close();
        process.exit(1);
      }
      const { path } = await applyOnboarding(ask, result);
      stdout.write(dim(`\n  Saved profile to ${path}\n\n`));
    } catch (err) {
      stdout.write("\n  Setup cancelled: " + (err as Error).message + "\n");
      reader.close();
      process.exit(1);
    }
  }

  const config = resolveConfig();
  if (!config) {
    process.stderr.write("Could not resolve a configuration. Try again.\n");
    reader.close();
    process.exit(1);
  }

  const registry = defaultRegistry({ bashTimeoutMs: config.bashTimeoutMs });
  const mcp = new LocalMcpRuntime(config.workdir);
  const policy = new PermissionPolicy();
  let skillCatalog = formatSkillCatalog(loadSkills(config.workdir));

  // Session state with a mutable provider/config: slash commands can switch the
  // active profile and rebuild() the provider in place — no restart needed.
  state = {
    config,
    provider: createProvider(config),
    profileName: config.profileName ?? loadStore().activeProfile,
    history: [],
    session: newSession({ provider: config.provider, model: config.model }),
    mode: policy.getMode(),
    usage: { input: 0, output: 0 },
    skillCatalog,
    estimateContext() {
      const system = appendPromptBlocks(
        systemPrompt(this.config.workdir, this.skillCatalog),
        this.pendingContext,
      );
      return estimateContextTokens({
        system,
        messages: this.history,
        tools: registry.specs(),
      });
    },
    todos: [],
    pendingContext: [],
    pendingAttachments: [],
    refreshSkills() {
      skillCatalog = formatSkillCatalog(loadSkills(this.config.workdir));
      this.skillCatalog = skillCatalog;
    },
    rebuild() {
      const next = resolveConfig();
      if (!next) return;
      this.config = next;
      this.provider = createProvider(next);
      this.profileName = next.profileName ?? loadStore().activeProfile;
      this.refreshSkills();
      printBanner(this.config, this.profileName);
    },
    save() {
      // Persist the live history into the session file. Title is derived from
      // the first user message until the user renames it (feature #6).
      this.session.messages = this.history;
      this.session.provider = this.config.provider;
      this.session.model = this.config.model;
      this.session.todos = cloneTodos(this.todos);
      if (this.session.title === "Untitled") {
        this.session.title = deriveTitle(this.history);
      }
      try {
        saveSession(this.session);
      } catch {
        /* non-fatal: a failed save shouldn't crash the REPL */
      }
    },
    setMode(mode) {
      // Keep state and the live gate's policy in lock-step (feature #5).
      this.mode = mode;
      policy.setMode(mode);
    },
  };

  const splashLines = (): string[] => [
    ...buildBannerLines(state.config, state.profileName),
    "",
    dim("  Type a request, ") +
      cyan("/help") +
      dim(" for commands, or ") +
      cyan("/exit") +
      dim(" to quit. ") +
      dim("Type / for the command menu · ↑↓ history · Ctrl-C interrupts."),
  ];

  const viewportTranscriptLines = (): string[] =>
    state!.history.length > 0 ? transcriptLines(state!.history) : splashLines();

  const writeViewportPrelude = (
    reservedRows: number,
    opts?: { includeStatus?: boolean },
  ): number => {
    if (!reader.isTTY || !state) return 0;
    const totalRows = Math.max(8, stdout.rows ?? 24);
    const budget = Math.max(0, totalRows - Math.max(0, reservedRows));
    const includeStatus = opts?.includeStatus ?? false;
    const contentBudget = Math.max(0, budget - (includeStatus ? 1 : 0));
    const content = viewportTranscriptLines();
    const clipped =
      contentBudget <= 0 ? [] : content.slice(Math.max(0, content.length - contentBudget));

    if (clipped.length > 0) {
      stdout.write(clipped.join("\n"));
    }
    if (includeStatus && budget > 0) {
      if (clipped.length > 0) stdout.write("\n");
      stdout.write(
        statusLine({
          model: state.config.model,
          mode: state.mode,
          used: state.estimateContext(),
          total: contextWindowFor(state.config.model, state.config.contextWindow),
          thinking: state.config.thinkingDepth ?? "off",
        }),
      );
      return clipped.length + 1;
    }
    return clipped.length;
  };

  replayIdleViewport = (reservedRows) => {
    const written = writeViewportPrelude(reservedRows, { includeStatus: true });
    if (written > 0) stdout.write("\n");
  };
  replayStreamingViewport = () => {
    const written = writeViewportPrelude(0);
    if (written > 0) stdout.write("\n");
  };

  // The renderer streams loop events; its onUsage hook records the provider's
  // last-call usage for diagnostics while UI context uses a local whole-prompt
  // estimate.
  const renderer = new Renderer({
    onUsage: (u) => {
      state.usage = { input: u.inputTokens, output: u.outputTokens };
    },
    replayPrelude: () => replayStreamingViewport?.(),
  });

  // Approval comes only from this interactive prompt — never from model or
  // tool output. The agent loop is paused (awaiting) while we ask.
  const confirmer: Confirmer = {
    async confirm(req: ConfirmRequest): Promise<boolean> {
      stdout.write(`\n  ${cyan(symbols.warn)} ${req.summary}\n`);
      if (req.details) {
        stdout.write(indent(req.details) + "\n");
      }
      const answer = await ask(`  Approve? ${dim("[y/N]")} `);
      return /^(y|yes)$/i.test(answer.trim());
    },
  };

  const gate = createGate({
    policy,
    confirmer,
    workdir: config.workdir,
    notify: (req) => renderer.notify(req.summary),
    repoConfig: () => loadRepoAgentConfig(state.config.workdir),
  });
  const subagentGate = createGate({
    policy,
    confirmer,
    workdir: config.workdir,
    repoConfig: () => loadRepoAgentConfig(state.config.workdir),
  });

  const runSubagent = async (request: SubagentRequest): Promise<SubagentResult> => {
    const allowedNames = new Set(
      request.toolWhitelist !== undefined ? request.toolWhitelist : DEFAULT_SUBAGENT_TOOLS,
    );
    const missing = [...allowedNames].filter((name) => !registry.get(name));
    if (missing.length > 0) {
      throw new Error(
        `Unknown tools in tool_whitelist: ${missing.join(", ")}. ` +
          `Available tools: ${registry.list().map((t) => t.name).join(", ")}.`,
      );
    }

    const subRegistry = new ToolRegistry(
      registry.list().filter((tool) => allowedNames.has(tool.name)),
    );
    const history: Message[] = [];
    let todos: TodoItem[] = [];
    let currentText = "";
    let summary = "";
    let doneReason: LoopStopReason | null = null;
    let turns = 0;
    const userInput = request.instructions?.trim()
      ? `${request.task}\n\nAdditional instructions:\n${request.instructions}`
      : request.task;
    const memoryBlock = state.config.memoryEnabled
      ? formatMemoryContext(
          retrieveMemoryContext({
            cwd: state.config.workdir,
            query: userInput,
            budget: state.config.memoryInjectionBudget,
          }),
        )
      : "";
    const system = appendPromptBlocks(
      [
        systemPrompt(state.config.workdir, state.skillCatalog),
        "",
        "You are running as an isolated subagent.",
        "Focus only on the assigned subtask, keep the parent context small, and",
        "finish with a concise summary of what matters.",
      ].join("\n"),
      [memoryBlock],
    );

    for await (const ev of runAgentLoop({
      provider: state.provider,
      registry: subRegistry,
      system,
      userInput,
      history,
      maxTurns: request.maxTurns ?? 8,
      workdir: state.config.workdir,
      ...(state.config.thinkingDepth ? { thinking: state.config.thinkingDepth } : {}),
      ...(state.mode === "allowAll" ? { allowOutsideWorkdir: true } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      todoStore: {
        get: () => cloneTodos(todos),
        set: (items) => {
          todos = cloneTodos(items);
        },
      },
      gate: subagentGate,
      runSubagent: undefined,
      mcp,
    })) {
      if (ev.type === "turn_start") currentText = "";
      else if (ev.type === "text_delta") currentText += ev.text;
      else if (ev.type === "done") {
        doneReason = ev.reason;
        turns = ev.turns;
        if (currentText.trim()) summary = currentText.trim();
      }
    }

    if (doneReason !== "end_turn") {
      throw new Error(
        `subagent stopped with ${doneReason ?? "unknown reason"} after ${turns} turn(s).`,
      );
    }
    if (!summary) {
      throw new Error("subagent returned an empty summary.");
    }
    return { summary, turns, history };
  };

  printBanner(state.config, state.profileName);
  stdout.write(
    dim("  Type a request, ") +
      cyan("/help") +
      dim(" for commands, or ") +
      cyan("/exit") +
      dim(" to quit. ") +
      dim("Type / for the command menu · ↑↓ history · Ctrl-C interrupts.\n\n"),
  );

  // Shared command context: pick (arrow picker) and clear (screen) let commands
  // present immersive UIs (B1/B5). Both degrade gracefully on non-TTY.
  const baseCtx = {
    state,
    ask,
    out: (text: string) => stdout.write(text + "\n"),
    pick: (prompt: string, items: { label: string; value: string; hint?: string }[]) =>
      reader.pick(prompt, items),
    clear: () => stdout.write("\x1b[2J\x1b[H"),
    mcpStatus: () => mcp.status(),
  };

  // REPL loop: read a line; "/" → command; else run a turn.
  // `seedNext` refills the prompt after a mid-stream Ctrl-C with the question
  // that was interrupted, so the user can edit and resend it (#7).
  let seedNext: string | undefined;
  while (true) {
    renderer.deactivateViewport();
    // Lean one-line footer above the prompt: model · mode · thinking · ctx% (#9).
    if (reader.isTTY) {
      stdout.write(
        statusLine({
          model: state.config.model,
          mode: state.mode,
          used: state.estimateContext(),
          total: contextWindowFor(state.config.model, state.config.contextWindow),
          thinking: state.config.thinkingDepth ?? "off",
        }) + "\n",
      );
    }
    const seed = state.seedInput ?? seedNext;
    state.seedInput = undefined;
    seedNext = undefined;
    const rawInput = await reader.ask(cyan(symbols.arrow) + " ", seed);
    let input = rawInput.trim();
    if (!commands.hasCommand(input)) {
      const inlineImages = consumeImagePathsFromText(input, state.config.workdir);
      if (inlineImages.images.length > 0) {
        for (const image of inlineImages.images) {
          pushPendingAttachment(state, imageAttachment(image));
        }
        input = inlineImages.text;
      }
    }
    const hasImageOnlyDraft = state.pendingAttachments.some((item) => item.kind === "image");
    // Double Ctrl-C on an empty prompt asks to quit (#7).
    if (reader.exitRequested) break;
    if (input === "" && !hasImageOnlyDraft) continue;

    // `!`-prefix: run the rest as a shell command and bypass the model (#5).
    // The human typed it, so it runs through their shell (pipes/globs work) —
    // same trust level as their own terminal. Output is echoed, not added to
    // history, so it never reaches the model unless the user copies it back.
    if (input.startsWith("!")) {
      const cmd = input.slice(1).trim();
      if (cmd === "") {
        stdout.write(dim("  (empty shell command)\n\n"));
        continue;
      }
      await runShellCommand(reader, cmd, state.config.workdir);
      stdout.write("\n");
      continue;
    }

    if (input.startsWith("/")) {
      try {
        const result = await commands.dispatch(input, baseCtx);
        if (result.exit) break;
        // A custom command may queue a prompt to run as this turn's input (B2).
        if (state.queuedInput) {
          input = state.queuedInput;
          state.queuedInput = undefined;
        } else if (state.seedInput) {
          stdout.write("\n");
          continue;
        } else {
          stdout.write("\n");
          continue;
        }
      } catch (err) {
        logger.error("slash command failed", {
          input,
          error: (err as Error).stack ?? (err as Error).message,
        });
        stdout.write(red(`  Command failed: ${(err as Error).message}\n\n`));
        continue;
      }
    }

    const interrupt = new InterruptController();
    const stopListening = reader.captureInterrupts(
      () => interrupt.abort(),
      () => interrupt.abort(),
    );
    const historyBefore = state.history.length;

    // Drain any pending skill context into the system prompt for THIS turn only
    // (B2 progressive disclosure). Untrusted data — never bypasses the gate.
    const memoryBlock = state.config.memoryEnabled
      ? formatMemoryContext(
          retrieveMemoryContext({
            cwd: state.config.workdir,
            query: input,
            budget: state.config.memoryInjectionBudget,
          }),
        )
      : "";
    const extraContext = state.pendingContext;
    const turnAttachments = [...state.pendingAttachments];
    const userContent = pendingUserContent(input, turnAttachments);
    const userImages = userContent.filter(
      (block): block is Extract<Message["content"][number], { type: "image" }> => block.type === "image",
    );
    state.pendingContext = [];
    state.pendingAttachments = [];
    const system = appendPromptBlocks(
      systemPrompt(state.config.workdir, state.skillCatalog),
      [memoryBlock, ...extraContext],
    );
    try {
      enforceVisionMode(state.config, userImages);
    } catch (err) {
      stdout.write(red(`  ${(err as Error).message}\n\n`));
      continue;
    }

    try {
      let loopError: { message: string; retryable: boolean; contextOverflow?: boolean } | null =
        null;
      if (reader.isTTY) renderer.activateViewport();
      for await (const ev of runAgentLoop({
        provider: state.provider,
        registry,
        system,
        userInput: input,
        ...(userContent.length > 0 ? { userContent } : {}),
        history: state.history,
        maxTurns: state.config.maxTurns,
        workdir: state.config.workdir,
        signal: interrupt.signal,
        ...(state.config.thinkingDepth
          ? { thinking: state.config.thinkingDepth }
          : {}),
        // allowAll mode lifts the workdir sandbox for filesystem tools (#9).
        ...(state.mode === "allowAll" ? { allowOutsideWorkdir: true } : {}),
        todoStore: {
          get: () => cloneTodos(state.todos),
          set: (items) => {
            state.todos = cloneTodos(items);
            state.session.todos = cloneTodos(items);
          },
        },
        gate,
        runSubagent,
        mcp,
      })) {
        if (ev.type === "error") loopError = ev;
        renderer.on(ev);
      }
      if (loopError?.contextOverflow) {
        const last = state.history[state.history.length - 1];
        if (last?.role === "user" && state.history.length === historyBefore + 1) {
          state.history.pop();
        }
        seedNext = input;
        await maybeAutoCompact(state, stdout.write.bind(stdout), {
          contextOverflow: true,
        });
        stdout.write(dim("  Your question is back in the prompt.\n"));
      }
    } catch (err) {
      logger.error("agent loop failed", {
        input,
        error: (err as Error).stack ?? (err as Error).message,
      });
      stdout.write(
        yellow(
          `  Turn failed: ${classifyRuntimeError(err as Error)} ` +
            "Your session is still intact; you can retry.\n",
        ),
      );
    } finally {
      renderer.deactivateViewport();
      stopListening();
    }
    // If the turn was interrupted mid-stream (Ctrl-C), refill the next prompt
    // with the interrupted question so the user can edit and resend it (#7).
    if (interrupt.aborted) {
      seedNext = input;
      stdout.write(dim("  Interrupted — your question is back in the prompt.\n"));
    }
    // Auto-save the conversation after each turn so it can be resumed later.
    appendTranscriptMessages(state.session.id, state.history.slice(historyBefore));
    state.save();

    if (state.config.memoryEnabled) {
      const transcript = readTranscriptTurns(state.session.id);
      const userTurns = transcript.filter((turn) => turn.role === "user").length;
      if (userTurns > 0 && userTurns % state.config.memoryExtractEvery === 0) {
        extractAndApplyMemory(
          state.config.workdir,
          transcript.slice(-Math.max(4, state.config.memoryExtractEvery * 4)),
        );
        writeCoreDigest(state.config.workdir);
      }
    }

    // Auto-compact when the live prompt estimate nears the context threshold.
    // Runs the same machinery as /compact, then reprints so the shorter state
    // is visible.
    await maybeAutoCompact(state, stdout.write.bind(stdout));

    stdout.write("\n");
  }

  reader.close();
  stdout.write(
    dim(
      `Bye. Session: ${state.session.title} (${state.session.id.slice(0, 8)})\n`,
    ),
  );
}

async function runInternalCommand(argv: string[]): Promise<boolean> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "internal-run-scheduler") return false;
  const once = rest.includes("--once");
  const jobFlag = rest.findIndex((item) => item === "--job");
  const onlyJobId = jobFlag >= 0 ? rest[jobFlag + 1] : undefined;
  await runSchedulerDaemon({ once, ...(onlyJobId ? { onlyJobId } : {}) });
  return true;
}

const DEFAULT_SUBAGENT_TOOLS = [
  "read",
  "ls",
  "grep",
  "glob",
  "todo_read",
  "skill_load",
] as const;

/**
 * If the live prompt estimate crosses COMPACT_THRESHOLD of the model's context
 * window, summarize older turns in place and reprint the conversation. No-op
 * below the threshold or when there's too little history to compact.
 */
async function maybeAutoCompact(
  state: SessionState,
  write: (s: string) => void,
  opts: { contextOverflow?: boolean } = {},
): Promise<void> {
  const total = contextWindowFor(state.config.model, state.config.contextWindow);
  const used = state.estimateContext();
  const mode = compactModeForUsage({
    usedTokens: used,
    totalTokens: total,
    ...(opts.contextOverflow ? { contextOverflow: true } : {}),
  });
  if (!mode) return;

  write(
    dim(
      opts.contextOverflow
        ? "\n  Provider reported context overflow — emergency compacting older turns…\n"
        : `\n  Context at ${formatContextPercent(used, total)} — ${mode} compacting older turns…\n`,
    ),
  );
  let result;
  try {
    result = await compactHistory(state.provider, state.history, { mode });
  } catch (err) {
    write(dim(`  Auto-compaction skipped: ${(err as Error).message}\n`));
    return;
  }
  if (result.collapsed === 0) return;

  state.history.length = 0;
  state.history.push(...result.messages);
  state.save();
  write("\x1b[2J\x1b[H"); // clear screen + home
  renderTranscript(state.history, (line) => write(line + "\n"));
  write(
    dim(
      `  Compacted ${result.collapsed} message(s) into layered summaries (${mode}).\n`,
    ),
  );
}

/**
 * Run a user-typed `!` shell command (#5): execute the raw line through the
 * shell in the workdir, handing the real foreground TTY to the child process.
 * The human typed it, so it gets full shell features and is NOT gated like the
 * model's bash tool. Output goes straight to the terminal and never enters the
 * model's history.
 */
async function runShellCommand(
  reader: LineReader,
  cmd: string,
  workdir: string,
): Promise<void> {
  stdout.write(dim(`  ${symbols.dot} $ ${cmd}\n`));
  const r = await reader.withTerminalReleased(() =>
    runForegroundShell(cmd, {
      cwd: workdir,
      timeoutMs: 120_000,
      shellPath: process.env.SHELL,
      // Foreground `!` commands avoid a real interactive shell because job
      // control can suspend inherited TTY sessions. The wrapper still sources
      // the user's rc files for aliases like `ll`.
      loginShell: false,
      interactiveShell: true,
    }),
  );
  if (r.error) {
    stdout.write(`  ${cmd}: ${r.error}\n`);
    return;
  }
  if (r.timedOut) {
    stdout.write(dim("  (timed out after 120s and was killed)\n"));
  } else if ((r.exitCode ?? 0) !== 0) {
    stdout.write(dim(`  (exit ${r.exitCode})\n`));
  }
}

/** Load custom extension commands and (re)register them on the registry (B2). */
function reloadExtensions(commands: ReturnType<typeof buildRegistry>): number {
  const defs = loadCustomCommandDefs(process.cwd());
  const cmds = buildCustomCommands(defs);
  for (const c of cmds) commands.register(c);
  return cmds.length;
}

/** Print the boxed launch/status banner. */
function printBanner(config: Config, profileName: string | null): void {
  stdout.write(buildBannerBlock(config, profileName) + "\n");
}

function buildBannerLines(config: Config, profileName: string | null): string[] {
  return buildBannerBlock(config, profileName).split("\n");
}

function buildBannerBlock(config: Config, profileName: string | null): string {
  const lines = [
    `${dim("profile")}  ${profileName ? cyan(profileName) : dim("(env/.env)")}  ${dim(symbols.dot)}  ${config.provider}`,
    `${dim("model")}    ${config.model}`,
  ];
  if (config.baseURL) lines.push(`${dim("endpoint")} ${config.baseURL}`);
  lines.push(`${dim("workdir")}  ${config.workdir}`);
  const right = [
    mascotTagline(),
    ...box("Session", lines).split("\n"),
  ];
  const left = mascot().split("\n");
  const cols = process.stdout.columns ?? 80;
  const widestLeft = Math.max(0, ...left.map(visibleWidth));
  const widestRight = Math.max(0, ...right.map(visibleWidth));
  const inlineWidth = widestLeft + 3 + widestRight;
  const block =
    process.stdout.isTTY && inlineWidth <= cols
      ? beside(left, right, 3)
      : [...left, "", ...right].join("\n");
  return block;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", {
    error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", {
    error: err.stack ?? err.message,
  });
});

runInternalCommand(process.argv.slice(2))
  .then((handled) => {
    if (handled) return;
    return main();
  })
  .catch((err) => {
    logger.error("fatal startup error", {
      error: (err as Error).stack ?? (err as Error).message,
    });
    process.stderr.write("Fatal: " + classifyRuntimeError(err as Error) + "\n");
    process.exit(1);
  });
