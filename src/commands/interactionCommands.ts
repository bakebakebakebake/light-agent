import type { CommandContext, SlashCommand } from "./registry.js";
import { loadSkills, listSkills, type Skill, skillContextBlock } from "../ext/skills.js";
import { loadRepoAgentConfig, saveRepoAgentConfig } from "../ext/repoConfig.js";
import {
  colorizeDiff,
  renderDiffOverview,
  renderDiffPatchHeader,
  renderDiffFileList,
  summarizeDiffFile,
  truncateDiffPatch,
} from "../ui/diff.js";
import { bold, cyan, dim, green, red, symbols } from "../ui/theme.js";
import { gitDiff, gitDiffFiles, type GitDiffFile } from "../util/git.js";
import { isDebugEnabled, logger, setDebugEnabled } from "../util/logger.js";
import { fetchWebPage, searchWeb, type SearchBias } from "../util/web.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function diffPickerItems(
  staged: readonly GitDiffFile[],
  unstaged: readonly GitDiffFile[],
): Array<{ label: string; value: string; hint?: string; selectable?: boolean; tone?: "dim" }> {
  const items: Array<{ label: string; value: string; hint?: string; selectable?: boolean; tone?: "dim" }> = [];
  if (staged.length > 0) {
    items.push({ label: "Staged", value: "__staged__", selectable: false, tone: "dim" });
    for (const file of staged) {
      items.push({
        label: file.path,
        value: `staged:${file.path}`,
        hint: stripAnsi(summarizeDiffFile(file)),
      });
    }
  }
  if (unstaged.length > 0) {
    items.push({ label: "Unstaged", value: "__unstaged__", selectable: false, tone: "dim" });
    for (const file of unstaged) {
      items.push({
        label: file.path,
        value: `unstaged:${file.path}`,
        hint: stripAnsi(summarizeDiffFile(file)),
      });
    }
  }
  return items;
}

function renderDiffSections(
  staged: readonly GitDiffFile[],
  unstaged: readonly GitDiffFile[],
): string[] {
  const sections: string[] = [...renderDiffOverview(staged, unstaged), ""];
  if (staged.length > 0) sections.push(...renderDiffFileList("Staged changes", staged));
  if (staged.length > 0 && unstaged.length > 0) sections.push("");
  if (unstaged.length > 0) sections.push(...renderDiffFileList("Unstaged changes", unstaged));
  return sections;
}

function matchesPathFilter(file: GitDiffFile, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (
    file.path.toLowerCase().includes(q) ||
    (file.previousPath?.toLowerCase().includes(q) ?? false)
  );
}

function renderPatch(file: GitDiffFile, raw: string, staged: boolean): string {
  return [...renderDiffPatchHeader(file, staged), "", colorizeDiff(truncateDiffPatch(raw))].join(
    "\n",
  );
}

export const diffCommand: SlashCommand = {
  name: "diff",
  description: "Browse git changes by file, then inspect a patch",
  keywords: ["git", "changes", "patch"],
  priority: 120,
  subcommands: ["--staged", "--cached", "--unstaged", "--name-only"],
  async run(ctx, args) {
    const stagedOnly = args.some((a) => a === "--staged" || a === "--cached");
    const unstagedOnly = args.includes("--unstaged");
    const nameOnly = args.includes("--name-only");
    const filter = args
      .filter((arg) => !["--staged", "--cached", "--unstaged", "--name-only"].includes(arg))
      .join(" ")
      .trim();

    const stagedRaw = stagedOnly || !unstagedOnly
      ? gitDiffFiles(ctx.state.config.workdir, { staged: true })
      : [];
    const unstagedRaw = unstagedOnly || !stagedOnly
      ? gitDiffFiles(ctx.state.config.workdir, { staged: false })
      : [];
    if (stagedRaw === null || unstagedRaw === null) {
      ctx.out(dim("  Not a git repository (or git is unavailable)."));
      return {};
    }
    const stagedFiles = stagedRaw;
    const unstagedFiles = unstagedRaw;
    logger.debug("diff command", {
      filter,
      stagedOnly,
      unstagedOnly,
      nameOnly,
      stagedCount: stagedFiles.length,
      unstagedCount: unstagedFiles.length,
    });
    const stagedFiltered = stagedFiles.filter((file) => matchesPathFilter(file, filter));
    const unstagedFiltered = unstagedFiles.filter((file) => matchesPathFilter(file, filter));
    if (stagedFiltered.length === 0 && unstagedFiltered.length === 0) {
      if (filter) {
        ctx.out(dim(`  No changed files match "${filter}".`));
      } else {
        ctx.out(
          dim(
            stagedOnly
              ? "  No staged changes."
              : unstagedOnly
                ? "  No unstaged changes."
                : "  No uncommitted changes.",
          ),
        );
      }
      return {};
    }
    if (nameOnly || !ctx.pick) {
      for (const line of renderDiffSections(stagedFiltered, unstagedFiltered)) ctx.out(line);
      if (!ctx.pick && !nameOnly) {
        const patchSource = stagedFiltered[0] ?? unstagedFiltered[0];
        if (patchSource) {
          const isStaged = stagedFiltered.includes(patchSource);
          const patch = gitDiff(ctx.state.config.workdir, {
            staged: isStaged,
            path: patchSource.path,
          });
          if (patch?.trim()) ctx.out("\n" + renderPatch(patchSource, patch, isStaged));
        }
      }
      return {};
    }

    while (true) {
      ctx.clear?.();
      for (const line of renderDiffSections(stagedFiltered, unstagedFiltered)) ctx.out(line);
      const choice = await ctx.pick("  Diff files", diffPickerItems(stagedFiltered, unstagedFiltered));
      if (!choice) return {};
      const [scope, ...pathParts] = choice.split(":");
      const path = pathParts.join(":");
      const showStaged = scope === "staged";
      const file = (showStaged ? stagedFiltered : unstagedFiltered).find((entry) => entry.path === path);
      if (!file) {
        ctx.out(dim(`  Could not find diff metadata for ${path}.`));
        continue;
      }
      const patch = gitDiff(ctx.state.config.workdir, { staged: showStaged, path });
      if (!patch?.trim()) {
        ctx.out(dim(`  No patch available for ${path}.`));
        continue;
      }
      ctx.clear?.();
      ctx.out(renderPatch(file, patch.trimEnd(), showStaged));
      ctx.out("");
      const action = await ctx.pick("  Diff actions", [
        { label: "Back to file list", value: "back", hint: "Choose another changed file" },
        { label: "Exit /diff", value: "exit", hint: "Return to the main prompt" },
      ]);
      if (!action || action === "exit") return {};
    }
    return {};
  },
};

function inferSearchBias(query: string): SearchBias {
  const q = query.toLowerCase();
  if (/(api|sdk|docs?|typescript|javascript|python|error|stack trace|how do i|reference)/.test(q)) {
    return "technical";
  }
  if (/(latest|today|news|recent|this week|this month|202\d)/.test(q)) {
    return "recent";
  }
  return "general";
}

function printSearchResults(
  ctx: CommandContext,
  query: string,
  results: Awaited<ReturnType<typeof searchWeb>>,
): void {
  ctx.out(bold(`  Search: ${query}`));
  for (const [index, result] of results.entries()) {
    ctx.out(`  ${index + 1}. ${cyan(result.title)}`);
    ctx.out(`     ${dim(result.source)} ${symbols.dot} ${dim(result.backend)} ${symbols.dot} ${result.url}`);
    if (result.publishedAt) ctx.out(`     ${dim(result.publishedAt)}`);
    ctx.out(`     ${result.snippet}`);
  }
}

export const searchCommand: SlashCommand = {
  name: "search",
  description: "Search the web, then optionally read a selected result",
  keywords: ["web", "internet", "docs", "google", "bing"],
  priority: 125,
  async run(ctx, args) {
    const query = args.join(" ").trim();
    if (!query) {
      ctx.out(dim("  Usage: /search <query>"));
      return {};
    }
    const bias = inferSearchBias(query);
    let results;
    try {
      results = await searchWeb(query, { limit: 6, bias });
      logger.debug("search results", {
        query,
        bias,
        urls: results.map((result) => result.url),
      });
    } catch (err) {
      ctx.out(red(`  Search failed: ${(err as Error).message}`));
      return {};
    }
    if (results.length === 0) {
      ctx.out(dim("  No results found."));
      return {};
    }
    printSearchResults(ctx, query, results);
    if (!ctx.pick) return {};
    const choice = await ctx.pick(
      "  Open which result?",
      [
        ...results.map((result) => ({
          label: result.title,
          value: result.url,
          hint: `${result.source}${result.publishedAt ? ` ${symbols.dot} ${result.publishedAt}` : ""}`,
        })),
        { label: "Keep results only", value: "__skip__", hint: "Do not fetch page text" },
      ],
    );
    if (!choice || choice === "__skip__") return {};
    try {
      const page = await fetchWebPage(choice, { maxChars: 10_000 });
      logger.debug("search fetch", { url: choice });
      ctx.out("");
      ctx.out(bold(`  Page: ${choice}`));
      ctx.out(page);
    } catch (err) {
      ctx.out(red(`  Fetch failed: ${(err as Error).message}`));
    }
    return {};
  },
};

function skillItems(skills: Map<string, Skill>): Array<{
  label: string;
  value: string;
  hint?: string;
}> {
  return listSkills(skills).map((skill) => ({
    label: skill.name,
    value: skill.name,
    hint:
      `${skill.scopeLabel} ${symbols.dot} ${skill.enabled ? "enabled" : "disabled"} ` +
      `${symbols.dot} ~${skill.approxTokens} tok` +
      (skill.description ? ` ${symbols.dot} ${skill.description}` : ""),
  }));
}

function queueSkill(ctx: CommandContext, skill: Skill): void {
  const block = skillContextBlock(skill);
  if (!ctx.state.pendingContext.includes(block)) {
    ctx.state.pendingContext.push(block);
  }
  if (!ctx.state.pendingContextLabels.includes(skill.name)) {
    ctx.state.pendingContextLabels.push(skill.name);
  }
}

function removeQueuedSkill(ctx: CommandContext, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  const before = ctx.state.pendingContextLabels.length;
  ctx.state.pendingContextLabels = ctx.state.pendingContextLabels.filter(
    (label) => label.toLowerCase() !== needle,
  );
  ctx.state.pendingContext = ctx.state.pendingContext.filter(
    (block) => !block.toLowerCase().startsWith(`# skill: ${needle}\n`),
  );
  return ctx.state.pendingContextLabels.length !== before;
}

function skillPickerItems(
  enabledSkills: Map<string, Skill>,
  pending: readonly string[],
): Array<{ label: string; value: string; hint?: string; selectable?: boolean; tone?: "dim" }> {
  const items: Array<{
    label: string;
    value: string;
    hint?: string;
    selectable?: boolean;
    tone?: "dim";
  }> = [];
  if (pending.length > 0) {
    items.push({ label: "Attached skills", value: "__attached__", selectable: false, tone: "dim" });
    for (const name of pending) {
      items.push({
        label: name,
        value: `remove:${name}`,
        hint: "Remove from the next message",
      });
    }
    items.push({
      label: "Clear all attached skills",
      value: "__clear__",
      hint: "Drop every queued skill",
    });
  }
  items.push({ label: "Available skills", value: "__available__", selectable: false, tone: "dim" });
  items.push(...skillItems(enabledSkills));
  return items;
}

export const skillCommand: SlashCommand = {
  name: "skill",
  aliases: ["skills"],
  description: "Pick, attach, remove, list, enable, or disable a Skill",
  keywords: ["context", "ability", "prompt"],
  priority: 95,
  subcommands: ["clear", "list", "enable", "disable", "remove", "detach", "rm"],
  async run(ctx, args) {
    const cwd = ctx.state.config.workdir;
    const allSkills = loadSkills(cwd, { includeDisabled: true });
    if (allSkills.size === 0) {
      ctx.out(dim("  No skills found. Add files under .agents/skills/ or .agent/skills/."));
      return {};
    }

    const sub = (args[0] ?? "").trim().toLowerCase();
    if (sub === "clear") {
      ctx.state.pendingContext = [];
      ctx.state.pendingContextLabels = [];
      ctx.out(green("  Cleared attached skills."));
      return {};
    }
    if (sub === "remove" || sub === "detach" || sub === "rm") {
      const name = (args[1] ?? "").trim().toLowerCase();
      if (!name) {
        ctx.out(dim(`  Usage: /skill ${sub} <name>`));
        return {};
      }
      if (!removeQueuedSkill(ctx, name)) {
        ctx.out(dim(`  Skill "${name}" is not currently attached.`));
        return {};
      }
      ctx.out(green(`  Removed skill "${name}" from the next message.`));
      return {};
    }
    if (sub === "list") {
      ctx.out(bold("  Skills"));
      for (const s of listSkills(allSkills)) {
        const tone = s.enabled ? cyan(s.name.padEnd(18)) : dim(s.name.padEnd(18));
        ctx.out(
          `  ${tone} ${dim(
            `${s.scopeLabel} ${symbols.dot} ${s.enabled ? "enabled" : "disabled"} ` +
            `${symbols.dot} ~${s.approxTokens} tok`,
          )}`,
        );
        if (s.description) ctx.out(`  ${dim(" ".repeat(20) + s.description)}`);
      }
      return {};
    }
    if (sub === "enable" || sub === "disable") {
      const name = (args[1] ?? "").trim().toLowerCase();
      if (!name) {
        ctx.out(dim(`  Usage: /skill ${sub} <name>`));
        return {};
      }
      const skill = allSkills.get(name);
      if (!skill) {
        ctx.out(red(`  No skill "${name}". Type /skill list to inspect available skills.`));
        return {};
      }
      const config = loadRepoAgentConfig(cwd);
      const disabled = new Set(config.disabledSkills);
      if (sub === "disable") disabled.add(name);
      else disabled.delete(name);
      saveRepoAgentConfig(cwd, { ...config, disabledSkills: [...disabled] });
      ctx.state.refreshSkills();
      ctx.out(green(`  Skill "${name}" ${sub === "disable" ? "disabled" : "enabled"}.`));
      return {};
    }

    let name = sub;
    if (!name) {
      const enabledSkills = loadSkills(cwd);
      if (enabledSkills.size === 0) {
        ctx.out(dim("  All discovered skills are currently disabled. Use /skill enable <name>."));
        return {};
      }
      if (ctx.pick) {
        const picked = await ctx.pick(
          "  Manage skills for the next message",
          skillPickerItems(enabledSkills, ctx.state.pendingContextLabels),
        );
        if (!picked) {
          return {};
        }
        if (picked === "__clear__") {
          ctx.state.pendingContext = [];
          ctx.state.pendingContextLabels = [];
          ctx.out(green("  Cleared attached skills."));
          return {};
        }
        if (picked.startsWith("remove:")) {
          const target = picked.slice("remove:".length);
          removeQueuedSkill(ctx, target);
          ctx.out(green(`  Removed skill "${target}" from the next message.`));
          return {};
        }
        name = picked.toLowerCase();
      } else {
        ctx.out(bold("  Skills"));
        for (const s of listSkills(enabledSkills)) {
          ctx.out(
            `  ${cyan(s.name.padEnd(18))} ${dim(
              `${s.scopeLabel} ${symbols.dot} ~${s.approxTokens} tok` +
              (s.description ? ` ${symbols.dot} ${s.description}` : ""),
            )}`,
          );
        }
        ctx.out(dim("  Attach with /skill <name>. Use /skill clear to drop attached skills."));
        return {};
      }
    }
    const enabledSkills = loadSkills(cwd);
    const skill = enabledSkills.get(name);
    if (!skill) {
      const disabledSkill = allSkills.get(name);
      if (disabledSkill && !disabledSkill.enabled) {
        ctx.out(red(`  Skill "${name}" is disabled. Re-enable it with /skill enable ${name}.`));
      } else {
        ctx.out(red(`  No skill "${name}". Type /skill list to inspect available skills.`));
      }
      return {};
    }
    queueSkill(ctx, skill);
    logger.debug("skill queued", {
      name: skill.name,
      scope: skill.scope,
      pending: ctx.state.pendingContextLabels,
    });
    ctx.state.seedInput ??= "";
    return {};
  },
};

export const debugCommand: SlashCommand = {
  name: "debug",
  description: "Show or toggle debug logging",
  keywords: ["logs", "logging"],
  priority: 35,
  subcommands: ["on", "off"],
  async run(ctx, args) {
    const value = (args[0] ?? "").trim().toLowerCase();
    if (!value) {
      ctx.out(`  ${dim("debug")} ${isDebugEnabled() ? green("on") : dim("off")}`);
      return {};
    }
    if (value !== "on" && value !== "off") {
      ctx.out(dim("  Usage: /debug [on|off]"));
      return {};
    }
    setDebugEnabled(value === "on");
    logger.info("debug logging toggled", { enabled: value === "on" });
    ctx.out(green(`  Debug logging ${value}.`));
    return {};
  },
};
