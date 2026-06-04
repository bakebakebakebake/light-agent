import type { CommandContext, PickItem, SlashCommand } from "./registry.js";
import { contextWindowFor } from "../model/contextWindow.js";
import { modelHint, selectModel } from "../model/selection.js";
import { smokeTestModel } from "../model/smoke.js";
import { probeCompatibility, summarizeCompatFailure } from "../model/compat.js";
import { collectOnboarding } from "../onboarding.js";
import { globalEnvPath, writeGlobalEnvEntries } from "../config.js";
import {
  getActiveProfile,
  listProfiles,
  loadStore,
  maskKey,
  rememberModel,
  removeProfile,
  saveStore,
  setActive,
  upsertProfile,
  type Profile,
} from "../profiles.js";
import { humanTokens } from "../ui/status.js";
import { bold, cyan, dim, green, red, symbols, yellow } from "../ui/theme.js";

function currentSearchBackend(): string {
  return process.env.LIGHT_AGENT_SEARCH_BACKEND ?? process.env.HARNESS_SEARCH_BACKEND ?? "auto";
}

function searchConfigPickerItems(): PickItem[] {
  const backend = currentSearchBackend();
  return [
    {
      label: "Show search config",
      value: "show",
      hint: `${backend} ${symbols.dot} ${process.env.TAVILY_API_KEY ? "Tavily set" : "no Tavily key"}`,
    },
    { label: "Backend: auto", value: "backend:auto" },
    { label: "Backend: tavily", value: "backend:tavily" },
    { label: "Backend: bing", value: "backend:bing" },
    { label: "Set Tavily key", value: "tavily-key" },
    { label: "Clear Tavily key", value: "clear-tavily-key" },
  ];
}

async function runSearchConfigAction(
  ctx: CommandContext,
  action: string,
  args: string[],
): Promise<{}> {
  if (!action || action === "show") {
    ctx.out(bold("  Search config"));
    ctx.out(`  ${dim("env file")} ${globalEnvPath()}`);
    ctx.out(`  ${dim("backend")} ${currentSearchBackend()}`);
    ctx.out(
      `  ${dim("tavily")} ${process.env.TAVILY_API_KEY ? green("configured") : yellow("not set")}`,
    );
    ctx.out(dim("  Set backend: /config search backend <auto|tavily|bing>"));
    ctx.out(dim("  Set key:     /config search tavily-key"));
    ctx.out(dim("  Clear key:   /config search clear-tavily-key"));
    return {};
  }
  if (action === "backend") {
    let value = (args[2] ?? "").trim().toLowerCase();
    if (!value && ctx.pick) {
      value =
        (await ctx.pick("  Search backend", [
          { label: "auto", value: "auto" },
          { label: "tavily", value: "tavily" },
          { label: "bing", value: "bing" },
        ])) ?? "";
    }
    if (!["auto", "tavily", "bing"].includes(value)) {
      ctx.out(dim("  Usage: /config search backend <auto|tavily|bing>"));
      return {};
    }
    const path = writeGlobalEnvEntries({ LIGHT_AGENT_SEARCH_BACKEND: value });
    process.env.LIGHT_AGENT_SEARCH_BACKEND = value;
    ctx.out(green(`  Saved search backend "${value}" to ${path}.`));
    return {};
  }
  if (action === "tavily-key") {
    const key = (await ctx.ask("Tavily API key: ", { secret: true })).trim();
    if (!key) {
      ctx.out(yellow("  No key entered."));
      return {};
    }
    const path = writeGlobalEnvEntries({ TAVILY_API_KEY: key });
    process.env.TAVILY_API_KEY = key;
    ctx.out(green(`  Saved Tavily key to ${path}.`));
    return {};
  }
  if (action === "clear-tavily-key") {
    const path = writeGlobalEnvEntries({ TAVILY_API_KEY: "" });
    delete process.env.TAVILY_API_KEY;
    ctx.out(green(`  Cleared Tavily key in ${path}.`));
    return {};
  }
  ctx.out(dim("  Usage: /config search"));
  ctx.out(dim("         /config search backend <auto|tavily|bing>"));
  ctx.out(dim("         /config search tavily-key"));
  ctx.out(dim("         /config search clear-tavily-key"));
  return {};
}

export const configCommand: SlashCommand = {
  name: "config",
  description: "Show profile settings or configure global search env",
  keywords: ["settings", "profile"],
  priority: 40,
  subcommands: ["search"],
  async run(ctx, args) {
    const sub = (args[0] ?? "").trim().toLowerCase();
    if (!sub && ctx.pick) {
      const choice = await ctx.pick("  Config", [
        {
          label: "Runtime config",
          value: "runtime",
          hint: `${ctx.state.config.provider} ${symbols.dot} ${ctx.state.config.model}`,
        },
        {
          label: "Search config",
          value: "search",
          hint: `${currentSearchBackend()} ${symbols.dot} ${process.env.TAVILY_API_KEY ? "Tavily set" : "no Tavily key"}`,
        },
      ]);
      if (choice === "search") {
        const action = await ctx.pick("  Search config", searchConfigPickerItems());
        if (!action) return {};
        if (action === "show") return runSearchConfigAction(ctx, "show", args);
        if (action.startsWith("backend:")) {
          return runSearchConfigAction(ctx, "backend", ["search", "backend", action.split(":")[1] ?? ""]);
        }
        return runSearchConfigAction(ctx, action, ["search", action]);
      }
      if (!choice || choice !== "runtime") return {};
    }
    if (sub === "search") {
      const action = (args[1] ?? "").trim().toLowerCase();
      if (!action && ctx.pick) {
        const picked = await ctx.pick("  Search config", searchConfigPickerItems());
        if (!picked) return {};
        if (picked === "show") return runSearchConfigAction(ctx, "show", args);
        if (picked.startsWith("backend:")) {
          return runSearchConfigAction(ctx, "backend", ["search", "backend", picked.split(":")[1] ?? ""]);
        }
        return runSearchConfigAction(ctx, picked, ["search", picked]);
      }
      return runSearchConfigAction(ctx, action, args);
    }
    const { config, profileName } = ctx.state;
    const ctxWin = contextWindowFor(config.model, config.contextWindow);
    const ctxLabel = config.contextWindow
      ? `${humanTokens(ctxWin)} ${dim("(override)")}`
      : `${humanTokens(ctxWin)} ${dim("(auto)")}`;
    const lines = [
      `  ${dim("profile")}  ${profileName ? cyan(profileName) : dim("(env/.env)")}`,
      `  ${dim("provider")} ${config.provider}`,
      `  ${dim("actual")}   ${config.compat?.preferredProtocol ?? config.provider}`,
      `  ${dim("model")}    ${config.model}`,
      `  ${dim("baseURL")}  ${config.baseURL ?? dim("(default)")}`,
      `  ${dim("chatURL")}  ${config.compat?.chatURL ?? dim("(auto)")}`,
      `  ${dim("context")}  ${ctxLabel}`,
      `  ${dim("vision")}   ${config.visionMode ?? "auto"}`,
      `  ${dim("apiKey")}   ${maskKey(config.apiKey)}`,
    ];
    ctx.out(lines.join("\n"));
    return {};
  },
};

function patchActiveProfile(ctx: CommandContext, patch: Partial<Profile>): boolean {
  const name = ctx.state.profileName;
  if (!name) {
    ctx.out(
      red("  No active profile to edit.") +
        dim(" This session is using env/.env. Run /profile new to create one."),
    );
    return false;
  }
  const store = loadStore();
  const current = getActiveProfile(store);
  if (!current) {
    ctx.out(red(`  Active profile "${name}" not found in the store.`));
    return false;
  }
  upsertProfile(store, name, { ...current, ...patch });
  saveStore(store);
  ctx.state.rebuild();
  return true;
}

function printProfiles(ctx: CommandContext): void {
  const store = loadStore();
  const names = listProfiles(store);
  if (names.length === 0) {
    ctx.out(dim("  No profiles yet. Run /profile new to add one."));
    return;
  }
  const rows = names.map((name) => {
    const profile = store.profiles[name]!;
    const active = name === store.activeProfile;
    const marker = active ? green(symbols.tool) : " ";
    const label = active ? bold(green(name)) : name;
    const compat =
      profile.compat?.preferredProtocol && profile.compat.preferredProtocol !== profile.provider
        ? `${profile.provider} -> ${profile.compat.preferredProtocol}`
        : profile.provider;
    return `  ${marker} ${label} ${dim(`${compat} ${symbols.dot} ${profile.model}`)}`;
  });
  ctx.out(rows.join("\n"));
}

function profilePickerItems(store: ReturnType<typeof loadStore>): PickItem[] {
  const items: PickItem[] = [
    {
      label: "Profiles",
      value: "__profiles__",
      selectable: false,
      tone: "dim",
    },
  ];
  const names = listProfiles(store);
  if (names.length === 0) {
    items.push({
      label: "(none yet)",
      value: "__profiles_empty__",
      selectable: false,
      tone: "dim",
    });
  } else {
    for (const name of names) {
      const profile = store.profiles[name]!;
      const active = name === store.activeProfile;
      items.push({
        label: active ? `${name} (active)` : name,
        value: `use:${name}`,
        hint: `${profile.provider} ${symbols.dot} ${profile.model}`,
        ...(active ? { tone: "green" as const } : {}),
      });
    }
  }

  items.push({
    label: "Actions",
    value: "__actions__",
    selectable: false,
    tone: "dim",
  });
  items.push({
    label: "New profile",
    value: "new",
    hint: "Create a fresh profile",
  });
  if (store.activeProfile) {
    items.push({
      label: "Edit active profile",
      value: "edit",
      hint: store.activeProfile,
    });
    items.push({
      label: "Remove active profile",
      value: "rm",
      hint: store.activeProfile,
    });
  }
  return items;
}

function printProfileHomeText(ctx: CommandContext, store: ReturnType<typeof loadStore>): void {
  const names = listProfiles(store);
  ctx.out(dim("  Profiles"));
  if (names.length === 0) {
    ctx.out(dim("    (none yet)"));
  } else {
    for (const name of names) {
      const profile = store.profiles[name]!;
      const active = name === store.activeProfile;
      const label = active ? green(`${name} (active)`) : name;
      const compat =
        profile.compat?.preferredProtocol && profile.compat.preferredProtocol !== profile.provider
          ? `${profile.provider} -> ${profile.compat.preferredProtocol}`
          : profile.provider;
      ctx.out(`    ${label} ${dim(`${compat} ${symbols.dot} ${profile.model}`)}`);
    }
  }
  ctx.out(dim("  Actions"));
  ctx.out("    New profile");
  if (store.activeProfile) {
    ctx.out(`    Edit active profile ${dim(`(${store.activeProfile})`)}`);
    ctx.out(`    Remove active profile ${dim(`(${store.activeProfile})`)}`);
  }
  ctx.out(dim("  Use /profile use <name>, /profile new, /profile edit, or /profile rm."));
}

async function profileHome(ctx: CommandContext): Promise<{ exit?: boolean }> {
  const store = loadStore();
  const items = profilePickerItems(store);

  if (!ctx.pick) {
    printProfileHomeText(ctx, store);
    return {};
  }

  const choice = await ctx.pick("  Choose a profile", items);
  if (!choice) {
    ctx.out(dim("  Cancelled."));
    return {};
  }
  if (choice === "new") return profileNew(ctx);
  if (choice === "edit") return profileEdit(ctx, undefined);
  if (choice === "rm") return profileRemove(ctx, store.activeProfile ?? undefined);
  if (choice.startsWith("use:")) return profileUse(ctx, choice.slice(4));
  return {};
}

async function profileUse(
  ctx: CommandContext,
  name: string | undefined,
): Promise<{ exit?: boolean }> {
  if (!name) {
    ctx.out(dim("  Usage: /profile use <name>"));
    return {};
  }
  const store = loadStore();
  try {
    setActive(store, name);
  } catch (err) {
    ctx.out(red(`  ${(err as Error).message}`));
    return {};
  }
  saveStore(store);
  ctx.state.rebuild();
  ctx.out(green(`  Switched to profile "${name}".`));
  return {};
}

async function profileNew(ctx: CommandContext): Promise<{ exit?: boolean }> {
  const result = await collectOnboarding(ctx.ask, undefined, ctx.pick);
  if (!result.entries.ANTHROPIC_API_KEY && !result.entries.OPENAI_API_KEY) {
    ctx.out(yellow("  No API key entered — profile not created."));
    return {};
  }
  const store = loadStore();
  let name = (await ctx.ask("Name this profile [default]: ")).trim() || "default";
  while (name in store.profiles) {
    const answer = (await ctx.ask(`Profile "${name}" exists. Overwrite? [y/N] or new name: `)).trim();
    if (/^(y|yes)$/i.test(answer)) break;
    if (answer && !/^(n|no)$/i.test(answer)) {
      name = answer;
      continue;
    }
    name = (await ctx.ask("New profile name: ")).trim() || name;
    if (!(name in store.profiles)) break;
  }
  let profile: Profile = {
    provider: result.provider,
    model: result.model,
    apiKey: result.entries.ANTHROPIC_API_KEY ?? result.entries.OPENAI_API_KEY!,
    ...(result.baseURL ? { baseURL: result.baseURL } : {}),
    ...(result.compat ? { compat: result.compat } : {}),
  };
  profile = rememberModel(profile, result.model);
  upsertProfile(store, name, profile);
  setActive(store, name);
  saveStore(store);
  ctx.state.rebuild();
  ctx.out(green(`  Created and switched to profile "${name}".`));
  return {};
}

function shouldDiscoverModels(source: { apiKey: string }): boolean {
  return source.apiKey.trim().length > 0;
}

async function profileEdit(
  ctx: CommandContext,
  nameArg: string | undefined,
): Promise<{ exit?: boolean }> {
  const store = loadStore();
  const name = nameArg ?? store.activeProfile ?? "";
  const current = store.profiles[name];
  if (!current) {
    ctx.out(red(`  No profile named "${name}".`));
    return {};
  }
  ctx.out(dim(`  Editing "${name}". Press Enter to keep the current value.`));
  if ((current.recentModels ?? []).length > 1) {
    ctx.out(dim(`  recent models: ${current.recentModels!.slice(0, 6).join(", ")}`));
  }
  const baseURL = (await ctx.ask(`Base URL [${current.baseURL ?? "(default)"}]: `)).trim();
  const key = (await ctx.ask("API key [keep current]: ", { secret: true })).trim();
  const source = {
    provider: current.provider,
    apiKey: key || current.apiKey,
    ...(current.compat ? { compat: current.compat } : {}),
    ...(baseURL ? { baseURL } : current.baseURL ? { baseURL: current.baseURL } : {}),
  } as const;
  const selection = await selectModel({
    ask: ctx.ask,
    pick: ctx.pick,
    currentModel: current.model,
    recentModels: current.recentModels ?? [],
    ...source,
    discover: shouldDiscoverModels(source),
    manualPrompt: `Model [${current.model}]: `,
    choosePrompt: `  Model for "${name}"`,
  });
  const model = selection.model || current.model;
  const resolvedBaseURL =
    baseURL || current.baseURL ? { baseURL: baseURL || current.baseURL } : {};
  const compatReport = await probeCompatibility({
    preferredProtocol: current.provider,
    apiKey: key || current.apiKey,
    ...(resolvedBaseURL.baseURL ? { baseURL: resolvedBaseURL.baseURL } : {}),
    model,
  });

  let next: Profile = {
    ...current,
    provider: compatReport.selected?.preferredProtocol ?? current.provider,
    model,
    ...(key ? { apiKey: key } : {}),
    ...(compatReport.selected ? { compat: compatReport.selected } : {}),
  };
  if (compatReport.selected?.resolvedBaseURL) next.baseURL = compatReport.selected.resolvedBaseURL;
  else if (baseURL) next.baseURL = baseURL;
  next = rememberModel(next, model);
  upsertProfile(store, name, next);
  saveStore(store);
  if (name === store.activeProfile) ctx.state.rebuild();
  ctx.out(green(`  Updated profile "${name}".`));
  return {};
}

async function profileRemove(
  ctx: CommandContext,
  name: string | undefined,
): Promise<{ exit?: boolean }> {
  if (!name) {
    ctx.out(dim("  Usage: /profile rm <name>"));
    return {};
  }
  const store = loadStore();
  if (!(name in store.profiles)) {
    ctx.out(red(`  No profile named "${name}".`));
    return {};
  }
  if (name === store.activeProfile) {
    const answer = (await ctx.ask(`"${name}" is the active profile. Remove it anyway? [y/N] `)).trim();
    if (!/^(y|yes)$/i.test(answer)) {
      ctx.out(dim("  Cancelled."));
      return {};
    }
  }
  removeProfile(store, name);
  saveStore(store);
  ctx.state.rebuild();
  ctx.out(green(`  Removed profile "${name}".`));
  if (!store.activeProfile) {
    ctx.out(yellow("  No profiles left — run /profile new to add one."));
  }
  return {};
}

export const profileCommand: SlashCommand = {
  name: "profile",
  aliases: ["profiles"],
  description: "Manage profiles: pick | use | new | edit | rm",
  keywords: ["provider", "account"],
  priority: 140,
  subcommands: ["use", "new", "edit", "rm", "list"],
  async run(ctx, args) {
    const sub = args[0];
    switch (sub) {
      case undefined:
        return profileHome(ctx);
      case "list":
        printProfiles(ctx);
        return {};
      case "use":
        return profileUse(ctx, args[1]);
      case "new":
        return profileNew(ctx);
      case "edit":
        return profileEdit(ctx, args[1]);
      case "rm":
      case "remove":
        return profileRemove(ctx, args[1]);
      default:
        ctx.out(red(`  Unknown subcommand "/profile ${sub}".`) + dim(" Try: use | new | edit | rm"));
        return {};
    }
  },
};

function activeRecentModels(ctx: CommandContext): string[] {
  const store = loadStore();
  const current = getActiveProfile(store);
  return current?.recentModels ?? [];
}

async function setModel(ctx: CommandContext, model: string): Promise<{ exit?: boolean }> {
  const trimmed = model.trim();
  if (!trimmed) {
    ctx.out(red("  Model name cannot be empty."));
    return {};
  }

  const store = loadStore();
  const current = getActiveProfile(store);
  if (current) {
    const next = rememberModel({ ...current, model: trimmed }, trimmed);
    if (patchActiveProfile(ctx, next)) {
      ctx.out(green(`  Model set to "${trimmed}".`));
    }
    return {};
  }

  ctx.state.config = { ...ctx.state.config, model: trimmed };
  ctx.out(green(`  Model set to "${trimmed}" (session only).`));
  return {};
}

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show, pick, or set the active model",
  keywords: ["llm", "engine"],
  priority: 135,
  subcommands: ["test"],
  async run(ctx, args) {
    if ((args[0] ?? "").trim().toLowerCase() === "test") {
      const candidate = args.slice(1).join(" ").trim() || ctx.state.config.model;
      ctx.out(dim(`  Testing model "${candidate}"...`));
      const result = await smokeTestModel(ctx.state.config, { model: candidate });
      ctx.out(`  ${dim("provider")} ${result.provider}`);
      ctx.out(`  ${dim("model")}    ${result.model}`);
      if (result.baseURL) ctx.out(`  ${dim("baseURL")}  ${result.baseURL}`);
      if (result.actualProtocol) ctx.out(`  ${dim("actual")}   ${result.actualProtocol}`);
      if (result.corrected) ctx.out(`  ${dim("corrected")} yes`);
      if (result.chatURL) ctx.out(`  ${dim("chatURL")}  ${result.chatURL}`);
      if (result.catalogResolvedURL) ctx.out(`  ${dim("catalogURL")} ${result.catalogResolvedURL}`);
      const catalogLine = result.catalogOk
        ? green(`ok (${result.catalogCount ?? 0} models visible)`)
        : result.streamOk
          ? yellow("unsupported by this endpoint")
          : red(result.catalogError ?? "failed");
      ctx.out(
        `  ${dim("catalog")}  ` + catalogLine,
      );
      if (!result.catalogOk && result.streamOk && result.catalogError) {
        ctx.out(`  ${dim("catalog note")} ${dim(result.catalogError.slice(0, 160))}`);
      }
      ctx.out(
        `  ${dim("stream")}   ` +
          (result.streamOk ? green("ok") : red(result.streamError ?? "empty response")),
      );
      if (result.supportsTools !== undefined) ctx.out(`  ${dim("tools")}    ${result.supportsTools ? green("yes") : yellow("no")}`);
      if (result.supportsReasoning !== undefined) ctx.out(`  ${dim("reason")}   ${result.supportsReasoning ? green("yes") : yellow("no")}`);
      if (result.supportsVision !== undefined) ctx.out(`  ${dim("vision")}   ${result.supportsVision ? green("yes") : yellow("no")}`);
      if (result.failureKind) ctx.out(`  ${dim("failure")}  ${result.failureKind} ${dim(`(${summarizeCompatFailure(result.failureKind)})`)}`);
      if (!result.streamOk) {
        ctx.out(dim("  Tip: Light-Agent probes both Anthropic and OpenAI-compatible chains and shows the resolved endpoint that actually answered."));
      }
      return {};
    }
    const value = args.join(" ").trim();
    if (!value) {
      const currentProfile = getActiveProfile(loadStore());
      const selection = await selectModel({
        ask: ctx.ask,
        pick: ctx.pick,
        provider: ctx.state.config.provider,
        apiKey: ctx.state.config.apiKey,
        ...(ctx.state.config.compat ? { compat: ctx.state.config.compat } : {}),
        ...(ctx.state.config.baseURL ? { baseURL: ctx.state.config.baseURL } : {}),
        currentModel: ctx.state.config.model,
        recentModels: currentProfile?.recentModels ?? [],
        discover: shouldDiscoverModels({
          apiKey: ctx.state.config.apiKey,
        }),
        manualPrompt: `Model [${ctx.state.config.model}]: `,
        choosePrompt: "  Choose a model",
      });
      if (!selection.model || selection.model === ctx.state.config.model) {
        ctx.out(
          `  ${dim("model")} ${ctx.state.config.model} ${dim(`(${modelHint(ctx.state.config.model)})`)}`,
        );
        const recent = activeRecentModels(ctx);
        if (recent.length > 1) {
          ctx.out(dim(`  recent: ${recent.slice(0, 6).join(", ")}`));
        }
        return {};
      }
      return setModel(ctx, selection.model);
    }
    return setModel(ctx, value);
  },
};
