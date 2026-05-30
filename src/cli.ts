import { stdout } from "node:process";
import { resolveConfig, isConfigured, type Config } from "./config.js";
import { collectOnboarding, applyOnboarding } from "./onboarding.js";
import { createProvider } from "./model/index.js";
import { defaultRegistry } from "./tools/registry.js";
import { runAgentLoop } from "./loop/agentLoop.js";
import { compactHistory } from "./loop/compact.js";
import type { SessionState } from "./commands/registry.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { createGate, type Confirmer, type ConfirmRequest } from "./permissions/confirm.js";
import { Renderer } from "./ui/render.js";
import { box, bold, cyan, dim, symbols } from "./ui/theme.js";
import { statusLine, workdirLine } from "./ui/status.js";
import { contextWindowFor } from "./model/contextWindow.js";
import { mascot } from "./ui/mascot.js";
import { InterruptController } from "./ui/interrupt.js";
import { LineReader } from "./ui/input.js";
import { renderTranscript } from "./ui/transcript.js";
import { systemPrompt } from "./prompt.js";
import { buildRegistry } from "./commands/builtins.js";
import { loadStore, storePath } from "./profiles.js";
import { newSession, saveSession, deriveTitle } from "./sessions.js";
import { loadCustomCommandDefs, buildCustomCommands } from "./ext/commands.js";
import { searchFiles } from "./ext/fileSearch.js";
import { runShell } from "./util/shell.js";
import { gitBranchCached } from "./util/git.js";

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
    // Tint the input frame cyan in plan mode (#8). `state` is initialized below
    // and this runs lazily on each draw, so it always sees the live mode.
    planMode: () => state.mode === "plan",
    // Bottom-left footer beneath the frame: workdir + cached git branch (#10).
    footer: () => workdirLine({
      workdir: state.config.workdir,
      branch: gitBranchCached(state.config.workdir),
    }),
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
        bold("Welcome to Harness-Agent.") +
        dim(" No credentials found — let's set one up.\n") +
        dim(`  (Saved to ${storePath()}, locked to your user.)\n\n`),
    );
    try {
      const result = await collectOnboarding(ask);
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
  const policy = new PermissionPolicy();

  // Session state with a mutable provider/config: slash commands can switch the
  // active profile and rebuild() the provider in place — no restart needed.
  const state: SessionState = {
    config,
    provider: createProvider(config),
    profileName: loadStore().activeProfile,
    history: [],
    session: newSession({ provider: config.provider, model: config.model }),
    mode: policy.getMode(),
    usage: { input: 0, output: 0 },
    pendingContext: [],
    rebuild() {
      const next = resolveConfig();
      if (!next) return;
      this.config = next;
      this.provider = createProvider(next);
      this.profileName = loadStore().activeProfile;
      printBanner(this.config, this.profileName);
    },
    save() {
      // Persist the live history into the session file. Title is derived from
      // the first user message until the user renames it (feature #6).
      this.session.messages = this.history;
      this.session.provider = this.config.provider;
      this.session.model = this.config.model;
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

  // The renderer streams loop events; its onUsage hook records the last turn's
  // input-token count as the current context size for the status line (#7).
  const renderer = new Renderer({
    onUsage: (u) => {
      state.usage = { input: u.inputTokens, output: u.outputTokens };
    },
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
  });

  stdout.write(mascot() + "\n");
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
  };

  // REPL loop: read a line; "/" → command; else run a turn.
  // `seedNext` refills the prompt after a mid-stream Ctrl-C with the question
  // that was interrupted, so the user can edit and resend it (#7).
  let seedNext: string | undefined;
  while (true) {
    // Lean one-line footer above the prompt: model · mode · thinking · ctx% (#9).
    if (reader.isTTY) {
      stdout.write(
        statusLine({
          model: state.config.model,
          mode: state.mode,
          used: state.usage.input,
          total: contextWindowFor(state.config.model, state.config.contextWindow),
          thinking: state.config.thinkingDepth ?? "off",
        }) + "\n",
      );
    }
    const seed = seedNext;
    seedNext = undefined;
    let input = (await reader.ask(cyan(symbols.arrow) + " ", seed)).trim();
    // Double Ctrl-C on an empty prompt asks to quit (#7).
    if (reader.exitRequested) break;
    if (input === "") continue;

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
      await runShellCommand(cmd, state.config.workdir);
      stdout.write("\n");
      continue;
    }

    if (input.startsWith("/")) {
      const result = await commands.dispatch(input, baseCtx);
      if (result.exit) break;
      // A custom command may queue a prompt to run as this turn's input (B2).
      if (state.queuedInput) {
        input = state.queuedInput;
        state.queuedInput = undefined;
      } else {
        stdout.write("\n");
        continue;
      }
    }

    const interrupt = new InterruptController();
    const stopListening = reader.captureInterrupts(() => interrupt.abort());

    // Drain any pending skill context into the system prompt for THIS turn only
    // (B2 progressive disclosure). Untrusted data — never bypasses the gate.
    const extraContext = state.pendingContext.join("\n\n");
    state.pendingContext = [];
    const system = extraContext
      ? systemPrompt(state.config.workdir) + "\n\n" + extraContext
      : systemPrompt(state.config.workdir);

    try {
      for await (const ev of runAgentLoop({
        provider: state.provider,
        registry,
        system,
        userInput: input,
        history: state.history,
        maxTurns: state.config.maxTurns,
        workdir: state.config.workdir,
        signal: interrupt.signal,
        ...(state.config.thinkingDepth
          ? { thinking: state.config.thinkingDepth }
          : {}),
        // allowAll mode lifts the workdir sandbox for filesystem tools (#9).
        ...(state.mode === "allowAll" ? { allowOutsideWorkdir: true } : {}),
        gate,
      })) {
        renderer.on(ev);
      }
    } finally {
      stopListening();
    }
    // If the turn was interrupted mid-stream (Ctrl-C), refill the next prompt
    // with the interrupted question so the user can edit and resend it (#7).
    if (interrupt.aborted) {
      seedNext = input;
      stdout.write(dim("  Interrupted — your question is back in the prompt.\n"));
    }
    // Auto-save the conversation after each turn so it can be resumed later.
    state.save();

    // Auto-compact when the last turn pushed context past the threshold (#1).
    // Uses the recorded input-token count vs the model's window; runs the same
    // machinery as /compact, then reprints so the shorter state is visible.
    await maybeAutoCompact(state, stdout.write.bind(stdout));

    stdout.write("\n");
  }

  reader.close();
  stdout.write(dim("Bye.\n"));
}

/** Fraction of the context window at which auto-compaction kicks in (#1). */
const COMPACT_THRESHOLD = 0.85;

/**
 * If the last turn's input tokens crossed COMPACT_THRESHOLD of the model's
 * context window, summarize older turns in place and reprint the conversation.
 * No-op below the threshold or when there's too little history to compact.
 */
async function maybeAutoCompact(
  state: SessionState,
  write: (s: string) => void,
): Promise<void> {
  const total = contextWindowFor(state.config.model, state.config.contextWindow);
  if (total <= 0) return;
  const frac = state.usage.input / total;
  if (frac < COMPACT_THRESHOLD) return;

  write(
    dim(
      `\n  Context at ${Math.round(frac * 100)}% — compacting older turns…\n`,
    ),
  );
  let result;
  try {
    result = await compactHistory(state.provider, state.history);
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
  write(dim(`  Compacted ${result.collapsed} message(s) to free context.\n`));
}

/**
 * Run a user-typed `!` shell command (#5): execute the raw line through the
 * shell in the workdir, streaming a header then the captured output. The human
 * typed it, so it gets full shell features and is NOT gated like the model's
 * bash tool. Output is echoed only — it never enters the model's history.
 */
async function runShellCommand(cmd: string, workdir: string): Promise<void> {
  stdout.write(dim(`  ${symbols.dot} $ ${cmd}\n`));
  const r = await runShell(cmd, { cwd: workdir, timeoutMs: 120_000 });
  if (r.error) {
    stdout.write(`  ${cmd}: ${r.error}\n`);
    return;
  }
  if (r.stdout) stdout.write(indent(r.stdout.trimEnd()) + "\n");
  if (r.stderr) stdout.write(indent(r.stderr.trimEnd()) + "\n");
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
  const lines = [
    `${dim("profile")}  ${profileName ? cyan(profileName) : dim("(env/.env)")}  ${dim(symbols.dot)}  ${config.provider}`,
    `${dim("model")}    ${config.model}`,
  ];
  if (config.baseURL) lines.push(`${dim("endpoint")} ${config.baseURL}`);
  lines.push(`${dim("workdir")}  ${config.workdir}`);
  stdout.write(box("Harness-Agent", lines) + "\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

main().catch((err) => {
  process.stderr.write("Fatal: " + (err as Error).stack + "\n");
  process.exit(1);
});
