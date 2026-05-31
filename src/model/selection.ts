import type { FetchModels, ModelListResult } from "./models.js";
import { fetchModels as defaultFetchModels } from "./models.js";
import { contextWindowFor } from "./contextWindow.js";
import { humanTokens } from "../ui/status.js";

export type Ask = (prompt: string, opts?: { secret?: boolean }) => Promise<string>;
export interface PickItem {
  label: string;
  value: string;
  hint?: string;
}

export type Pick = (prompt: string, items: PickItem[]) => Promise<string | null>;

export interface ModelSource {
  provider: "anthropic" | "openai";
  apiKey: string;
  baseURL?: string;
}

export interface SelectModelOptions extends ModelSource {
  ask: Ask;
  pick?: Pick;
  currentModel?: string;
  defaultModel?: string;
  recentModels?: string[];
  fetch?: FetchModels;
  /**
   * Force remote discovery even when the source has no explicit base URL.
   * Used by onboarding, where we want to try the provider's default endpoint.
   */
  discover?: boolean;
  /** Prompt shown when we fall back to free-form manual entry. */
  manualPrompt?: string;
  /** Require a non-empty manual entry instead of accepting Enter as keep-current. */
  manualRequired?: boolean;
  /** Prompt shown when we need the user to choose from a discovered catalog. */
  choosePrompt?: string;
}

export interface SelectModelResult {
  model: string;
  discovered: string[];
  error?: string;
}

/** Fetch a model catalog when discovery is enabled for the given source. */
export async function discoverModels(
  source: ModelSource,
  fetch: FetchModels = defaultFetchModels,
  discover = false,
): Promise<ModelListResult> {
  if (!discover && !source.baseURL) return { models: [] };
  return fetch(source);
}

/** A short human hint for a model id, based on the built-in window table. */
export function modelHint(model: string): string {
  return `${humanTokens(contextWindowFor(model))} ctx`;
}

/** Merge current, recent, and remote ids into a stable de-duplicated order. */
export function orderedModelIds(
  currentModel: string | undefined,
  recentModels: string[] = [],
  remoteModels: string[] = [],
): string[] {
  const ordered = [currentModel ?? "", ...recentModels, ...remoteModels].filter(Boolean);
  return [...new Set(ordered)];
}

/**
 * Select a model interactively, preferring a discovered catalog when one is
 * available. Falls back to a manual prompt when discovery fails or returns
 * nothing useful.
 */
export async function selectModel(options: SelectModelOptions): Promise<SelectModelResult> {
  const result = await discoverModels(options, options.fetch, options.discover);
  const remote = result.models;
  const candidates = orderedModelIds(options.currentModel, options.recentModels, remote);
  const current = options.currentModel ?? options.defaultModel ?? candidates[0] ?? "";

  if (options.pick && candidates.length > 0) {
    const items = candidates.map((model) => ({
      label: model === options.currentModel ? `${model} (current)` : model,
      value: model,
      hint: modelHint(model),
    }));
    items.push({
      label: "Enter custom model",
      value: "__manual__",
      hint: "Type a model id by hand",
    });

    const choice = await options.pick(
      options.choosePrompt ?? "Select a model",
      items,
    );
    if (!choice || choice === options.currentModel) {
      return { model: options.currentModel ?? current, discovered: remote, error: result.error };
    }
    if (choice === "__manual__") {
      return {
        model: await promptManualModel(
          options.ask,
          options.manualPrompt,
          current,
          options.manualRequired,
        ),
        discovered: remote,
        error: result.error,
      };
    }
    return { model: choice, discovered: remote, error: result.error };
  }

  if (remote.length > 0) {
    const shown = candidates.slice(0, 30);
    const list = shown
      .map((model, i) => `  ${i + 1}) ${model} ${humanTokens(contextWindowFor(model))} ctx`)
      .join("\n");
    const answer = (
      await options.ask(
        `${options.choosePrompt ?? "Available models"}:\n${list}\n` +
          "Select a number [1], or type a model name: ",
      )
    ).trim();
    if (!answer) {
      return { model: shown[0] ?? current, discovered: remote, error: result.error };
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) {
      return {
        model: shown[n - 1] ?? current,
        discovered: remote,
        error: result.error,
      };
    }
    return { model: answer, discovered: remote, error: result.error };
  }

  return {
    model: await promptManualModel(
      options.ask,
      options.manualPrompt,
      current,
      options.manualRequired,
    ),
    discovered: remote,
    error: result.error,
  };
}

async function promptManualModel(
  ask: Ask,
  manualPrompt: string | undefined,
  current: string,
  required = false,
): Promise<string> {
  const prompt = manualPrompt ?? `Model${current ? ` [${current}]` : ""}: `;
  if (!required) {
    const answer = (await ask(prompt)).trim();
    return answer || current;
  }
  let answer = "";
  while (!answer) {
    answer = (await ask(prompt)).trim();
  }
  return answer;
}
