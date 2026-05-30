import { DEFAULT_ANTHROPIC_MODEL } from "./config.js";
import {
  loadStore,
  saveStore,
  upsertProfile,
  setActive,
  type Profile,
} from "./profiles.js";
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
export type Ask = (
  prompt: string,
  opts?: { secret?: boolean },
) => Promise<string>;

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

/**
 * Resolve a model id: try fetching the provider's list and let the user pick a
 * number (or type a name); fall back to `manual()` when the list can't be
 * fetched or is empty. `recent` model ids float to the top of the list so
 * frequently-used models are one keystroke away (feature #8).
 */
async function pickModel(
  ask: Ask,
  fetch: FetchModels,
  opts: {
    provider: "anthropic" | "openai";
    apiKey: string;
    baseURL?: string;
    recent?: string[];
  },
  manual: () => Promise<string>,
): Promise<string> {
  let result;
  try {
    result = await fetch({
      provider: opts.provider,
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  } catch {
    result = { models: [] as string[] };
  }
  const models = orderModels(result.models, opts.recent ?? []);
  if (models.length === 0) {
    // No list (offline, bad key, or unsupported endpoint) → type it in.
    return manual();
  }

  const shown = models.slice(0, 30);
  const list = shown.map((m, i) => `  ${i + 1}) ${m}`).join("\n");
  const answer = (
    await ask(
      `Available models:\n${list}\n` +
        `Select a number [1], or type a model name: `,
    )
  ).trim();

  if (!answer) return shown[0] ?? (await manual());
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= shown.length) {
    return shown[n - 1] ?? (await manual());
  }
  // Anything else is treated as a literal model id the user typed.
  return answer;
}

/** Put `recent` ids first (in recent order), then the rest, de-duplicated. */
function orderModels(models: string[], recent: string[]): string[] {
  const set = new Set(models);
  const head = recent.filter((m) => set.has(m));
  const seen = new Set(head);
  const tail = models.filter((m) => !seen.has(m));
  return [...head, ...tail];
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
  const model = await pickModel(
    ask,
    fetch,
    { provider: "anthropic", apiKey, ...(baseURL ? { baseURL } : {}) },
    async () =>
      (await ask(`Model [${DEFAULT_ANTHROPIC_MODEL}]: `)).trim() ||
      DEFAULT_ANTHROPIC_MODEL,
  );

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
  // Model is required for OpenAI-compatible providers: there is no default, so
  // the manual fallback re-prompts until a non-empty value is given.
  const model = await pickModel(
    ask,
    fetch,
    { provider: "openai", apiKey, ...(baseURL ? { baseURL } : {}) },
    async () => {
      let m = "";
      while (!m) {
        m = (await ask('Model (required, e.g. "deepseek-chat"): ')).trim();
      }
      return m;
    },
  );

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
