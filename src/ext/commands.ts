import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extRoots, type ExtScope } from "./paths.js";
import { parseFrontMatter } from "./skills.js";
import type { SlashCommand } from "../commands/registry.js";

/**
 * Custom slash commands (B2, docs/09).
 *
 * A custom command is `commands/<name>.md` under an extension root. Its body is
 * a prompt template; the literal `{{args}}` is replaced with whatever the user
 * typed after the command. Running the command queues that rendered prompt as
 * the next turn's input (mirrors how project commands work in similar tools).
 *
 * These are PROMPTS, not code — there is no arbitrary execution, so they add no
 * security surface beyond what the user could type themselves. The model's
 * subsequent tool calls are still gated normally (docs/04).
 */

export interface CustomCommandDef {
  name: string;
  description: string;
  template: string;
  scope: ExtScope;
}

/** Render a template, substituting {{args}} with the user-supplied argument string. */
export function renderTemplate(template: string, args: string): string {
  return template.replace(/\{\{\s*args\s*\}\}/g, args);
}

/** Load custom command definitions across the active extension roots. */
export function loadCustomCommandDefs(cwd: string): CustomCommandDef[] {
  const byName = new Map<string, CustomCommandDef>();
  for (const root of extRoots(cwd)) {
    const dir = join(root.dir, "commands");
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.replace(/\.md$/, "").toLowerCase();
      let text: string;
      try {
        text = readFileSync(join(dir, entry), "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontMatter(text);
      if (!body) continue;
      // Project scope overrides user scope on a name clash.
      byName.set(name, {
        name: data.name?.toLowerCase() ?? name,
        description: data.description ?? "(custom command)",
        template: body,
        scope: root.scope,
      });
    }
  }
  return [...byName.values()];
}

/**
 * Turn custom command definitions into synthetic SlashCommands. Running one
 * queues the rendered template on the session state; cli.ts drains
 * `state.queuedInput` after dispatch and feeds it to the agent loop.
 */
export function buildCustomCommands(defs: CustomCommandDef[]): SlashCommand[] {
  return defs.map((def): SlashCommand => ({
    name: def.name,
    description: `${def.description} ${def.scope === "project" ? "(project)" : "(user)"}`,
    async run(ctx, args) {
      ctx.state.queuedInput = renderTemplate(def.template, args.join(" "));
      return {};
    },
  }));
}
