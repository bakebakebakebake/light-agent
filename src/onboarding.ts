import { DEFAULT_ANTHROPIC_MODEL } from "./config.js";
import {
  loadStore,
  saveStore,
  upsertProfile,
  setActive,
  type Profile,
} from "./profiles.js";
import {
  selectModel,
  type Ask as ModelAsk,
} from "./model/selection.js";
import { fetchModels as defaultFetchModels, type FetchModels } from "./model/models.js";

/**
 * First-run onboarding (docs/08).
 *
 * When the CLI starts with no credentials configured, we walk the user through
 * a short setup instead of erroring out: pick a provider, paste an API key, and
 * (for OpenAI-compatible endpoints) name a base URL + model. The answers become
 * a named profile in the global store (~/.harness-agent/config.json) and are
 * set active, so the same session can continue straight into the REPL.
 *
 * Security (docs/04): the API key is typed by the real user on stdin — we never
 * fabricate one — and we never echo the value back. The store file is 0600.
 */

/** A prompt function (cli.ts passes one backed by readline). The optional
 * `secret` flag asks the caller to mask echo for sensitive input (API keys). */
export type Ask = ModelAsk;

/** The env vars the wizard resolved, ready to apply + persist. */
export interface OnboardingResult {
  entries: Record<string, string>;
  provider: "anthropic" | "openai";
  model: string;
  baseURL?: string;
}

/**
 * Run the interactive questions and return the resolved env entries. Pure with
 * respect to the filesystem — it only asks questions; persisting is a separate
 * step (so it is easy to unit-test with a scripted `ask`).
 *
 * `fetch` is injectable so tests stay offline; in production it queries the
 * provider's models endpoint so the user can pick a real model id (feature #9).
 */
export async function collectOnboarding(
  ask: Ask,
  fetch: FetchModels = defaultFetchModels,
): Promise<OnboardingResult> {
  const choice = (
    await ask(
      "Choose a provider:\n" +
        "  1) Anthropic API (official, or an Anthropic-compatible proxy)\n" +
        "  2) OpenAI-compatible (OpenRouter, DeepSeek, Kimi, Qwen, Ollama, …)\n" +
        "Enter 1 or 2 [1]: ",
    )
  ).trim();

  if (choice === "2") {
    return collectOpenAI(ask, fetch);
  }
  return collectAnthropic(ask, fetch);
}

async function collectAnthropic(
  ask: Ask,
  fetch: FetchModels,
): Promise<OnboardingResult> {
  const apiKey = (
    await ask("Anthropic API key (sk-ant-…): ", { secret: true })
  ).trim();
  const baseURL = (
    await ask(
      "Base URL (optional — leave blank for the official endpoint): ",
    )
  ).trim();
  const model = (
    await selectModel({
      ask,
      fetch,
      provider: "anthropic",
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      discover: true,
      manualPrompt: `Model [${DEFAULT_ANTHROPIC_MODEL}]: `,
      choosePrompt: "Available models",
    })
  ).model;

  const entries: Record<string, string> = {
    HARNESS_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: apiKey,
    HARNESS_MODEL: model,
  };
  if (baseURL) entries.ANTHROPIC_BASE_URL = baseURL;

  return { entries, provider: "anthropic", model, baseURL: baseURL || undefined };
}

async function collectOpenAI(
  ask: Ask,
  fetch: FetchModels,
): Promise<OnboardingResult> {
  const apiKey = (await ask("API key: ", { secret: true })).trim();
  const baseURL = (
    await ask(
      "Base URL (e.g. https://api.deepseek.com/v1 — blank for OpenAI): ",
    )
  ).trim();
  const model = (
    await selectModel({
      ask,
      fetch,
      provider: "openai",
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      discover: true,
      manualPrompt: 'Model (required, e.g. "deepseek-chat"): ',
      manualRequired: true,
      choosePrompt: "Available models",
    })
  ).model;

  const entries: Record<string, string> = {
    HARNESS_PROVIDER: "openai",
    OPENAI_API_KEY: apiKey,
    HARNESS_MODEL: model,
  };
  if (baseURL) entries.OPENAI_BASE_URL = baseURL;

  return { entries, provider: "openai", model, baseURL: baseURL || undefined };
}

/** Turn a collected result into a Profile (provider + creds). */
export function resultToProfile(result: OnboardingResult): Profile {
  const apiKey =
    result.entries.ANTHROPIC_API_KEY ?? result.entries.OPENAI_API_KEY ?? "";
  return {
    provider: result.provider,
    model: result.model,
    apiKey,
    // Seed recent-model history with the chosen model (feature #8).
    ...(result.model ? { recentModels: [result.model] } : {}),
    ...(result.baseURL ? { baseURL: result.baseURL } : {}),
  };
}

/**
 * Persist the collected result as a named profile in the global store and make
 * it active, so loadStore()/resolveConfig() pick it up immediately in the same
 * process. Prompts for a profile name (default "default"). Returns the store
 * path and the chosen profile name.
 */
export async function applyOnboarding(
  ask: Ask,
  result: OnboardingResult,
): Promise<{ path: string; profileName: string }> {
  const store = loadStore();
  const name =
    (await ask("Name this profile [default]: ")).trim() || "default";
  upsertProfile(store, name, resultToProfile(result));
  setActive(store, name);
  const path = saveStore(store);
  return { path, profileName: name };
}
