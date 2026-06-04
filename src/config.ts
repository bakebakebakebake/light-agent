import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  loadStore,
  getActiveProfile,
  profileToConfig,
  storeDir,
} from "./profiles.js";
import type { CompatibilitySnapshot } from "./model/compat.js";
import type { ThinkingDepth } from "./model/types.js";
import type { VisionMode } from "./util/images.js";

/** Parse a thinking-depth string (env or stored) into a valid ThinkingDepth. */
export function parseThinkingDepth(value: string | undefined): ThinkingDepth {
  switch ((value ?? "").trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
    case "med":
      return "medium";
    case "high":
    case "max":
      return "high";
    default:
      return "off";
  }
}

export function parseVisionMode(value: string | undefined): VisionMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "on":
      return "on";
    case "off":
      return "off";
    default:
      return "auto";
  }
}

/**
 * Parse a context-window override (#11) from env/string. Accepts a plain token
 * count ("128000") or a "k" suffix ("128k", "200K"). Returns undefined for
 * missing/invalid input so callers fall back to the model table.
 */
export function parseContextWindow(value: string | undefined): number | undefined {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(raw);
  if (!m) return undefined;
  const n = parseFloat(m[1]!) * (m[2] ? 1000 : 1);
  const tokens = Math.round(n);
  return tokens > 0 ? tokens : undefined;
}

export function parseBoolFlag(
  value: string | undefined,
  fallback: boolean,
): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function parsePositiveInt(
  value: string | undefined,
): number | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function globalEnvPath(): string {
  return resolve(storeDir(), "env");
}

/**
 * Minimal .env loader — keeps us dependency-free.
 * Shell env stays highest priority. Global user env loads first, then the
 * project-local `.env` can override values that only came from that global
 * file.
 */
function applyDotEnvFile(
  envPath: string,
  protectedKeys: Set<string>,
  allowOverrideLoaded: boolean,
): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || protectedKeys.has(key)) continue;
    if (!allowOverrideLoaded && key in process.env) continue;
    process.env[key] = value;
  }
}

export function loadRuntimeEnv(cwd: string): void {
  const protectedKeys = new Set(Object.keys(process.env));
  applyDotEnvFile(globalEnvPath(), protectedKeys, false);
  applyDotEnvFile(resolve(cwd, ".env"), protectedKeys, true);
}

function envValue(name: string): string | undefined {
  const light = `LIGHT_AGENT_${name}`;
  const legacy = `HARNESS_${name}`;
  return process.env[light] ?? process.env[legacy];
}

export interface Config {
  /** Which adapter to use. "anthropic" = native Messages API (or an
   * Anthropic-compatible proxy); "openai" = any OpenAI-compatible endpoint. */
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  /** Optional override for the API base URL (proxies, aggregators, local). */
  baseURL?: string;
  /** Reasoning depth (A1). Defaults to "off". */
  thinkingDepth?: ThinkingDepth;
  /**
   * Optional context-window override in tokens (#11). Wins over the built-in
   * model→window table when set (profile field or LIGHT_AGENT_CONTEXT_WINDOW).
   */
  contextWindow?: number;
  /** Working directory the agent is allowed to operate within. */
  workdir: string;
  /** Hard cap on agent loop turns (stop condition — see docs/01). */
  maxTurns: number;
  /** Per-command timeout for the Bash tool in ms (see docs/10). */
  bashTimeoutMs: number;
  /** Enable the native memory subsystem. */
  memoryEnabled: boolean;
  /** Turn cadence for automatic durable-memory extraction. */
  memoryExtractEvery: number;
  /** Prompt budget reserved for injected memory context. */
  memoryInjectionBudget: number;
  /** Whether image attachments are allowed for the active profile/model. */
  visionMode?: VisionMode;
  /** Cached compatibility probe/correction results for this profile. */
  compat?: CompatibilitySnapshot;
  /** Profile name when the config came from the profile store. */
  profileName?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

/** Re-export the default so the onboarding wizard can show/seed it. */
export const DEFAULT_ANTHROPIC_MODEL = DEFAULT_MODEL;

/**
 * Load .env into process.env, then report whether enough credentials exist to
 * build a Config without throwing. Used by the CLI to decide whether to run the
 * first-run onboarding wizard. We don't validate the key, only its presence —
 * the first live request is the real test.
 *
 * A configured profile store counts as configured (the primary path); the
 * env/.env check is the fallback for power users and CI.
 */
export function isConfigured(cwd: string = process.cwd()): boolean {
  if (resolveActiveProfileName()) return true;

  loadRuntimeEnv(cwd);
  const provider =
    (envValue("PROVIDER") ?? "anthropic").toLowerCase() === "openai"
      ? "openai"
      : "anthropic";
  if (provider === "openai") {
    return Boolean(process.env.OPENAI_API_KEY && envValue("MODEL"));
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Which profile name should be active this run: LIGHT_AGENT_PROFILE wins (with
 * HARNESS_PROFILE kept as a fallback) for a one-off override that does not
 * mutate the persisted activeProfile. Otherwise the store's activeProfile
 * wins. Returns null if neither resolves to an existing profile.
 */
function resolveActiveProfileName(): string | null {
  const store = loadStore();
  const override = envValue("PROFILE");
  if (override && override in store.profiles) return override;
  if (store.activeProfile && store.activeProfile in store.profiles) {
    return store.activeProfile;
  }
  return null;
}

/**
 * Resolve the runtime Config (docs/06). Precedence:
 *  1. The active profile in the global store (primary path;
 *     LIGHT_AGENT_PROFILE can override which profile for one run).
 *  2. Otherwise the env/.env path (loadConfig) — kept for power users and CI.
 *  3. If neither yields credentials, returns null so the caller can onboard.
 *
 * Unlike loadConfig this never throws on missing credentials — it returns null,
 * which the CLI turns into the onboarding flow.
 */
export function resolveConfig(cwd: string = process.cwd()): Config | null {
  loadRuntimeEnv(cwd);
  const name = resolveActiveProfileName();
  if (name) {
    const store = loadStore();
    const profile = getActiveProfile({
      activeProfile: name,
      profiles: store.profiles,
    });
    if (profile) {
      return {
        ...profileToConfig(profile, cwd),
        profileName: name,
      };
    }
  }

  try {
    return loadConfig(cwd);
  } catch {
    return null;
  }
}

/**
 * Merge key/value entries into the project's .env file (creating it if needed),
 * preserving any existing lines and comments. Existing keys are updated in
 * place; new keys are appended. Returns the path written.
 *
 * Security: the caller (onboarding wizard) collects the API key from real user
 * input on stdin. We never log the value here, and .env is gitignored.
 */
export function writeEnvEntries(
  cwd: string,
  entries: Record<string, string>,
): string {
  return writeEnvEntriesToPath(resolve(cwd, ".env"), entries);
}

export function writeGlobalEnvEntries(entries: Record<string, string>): string {
  return writeEnvEntriesToPath(globalEnvPath(), entries);
}

function writeEnvEntriesToPath(
  envPath: string,
  entries: Record<string, string>,
): string {
  mkdirSync(dirname(envPath), { recursive: true });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  const remaining = { ...entries };

  // Update keys already present (skip comments / blank lines).
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in remaining) {
      lines[i] = `${key}=${remaining[key]}`;
      delete remaining[key];
    }
  }

  // Drop a single trailing empty line so we append cleanly.
  while (lines.length && (lines[lines.length - 1] ?? "").trim() === "") {
    lines.pop();
  }

  // Append any keys that weren't already present.
  for (const [key, value] of Object.entries(remaining)) {
    lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
  return envPath;
}

/**
 * Build the runtime config from environment + .env.
 *
 * Provider selection (docs/06): the loop only talks to the ModelProvider
 * interface, so swapping providers is purely config.
 *  - LIGHT_AGENT_PROVIDER=anthropic (default) reads ANTHROPIC_API_KEY and the
 *    optional ANTHROPIC_BASE_URL (set this to point at an Anthropic-compatible
 *    proxy / 中转站).
 *  - LIGHT_AGENT_PROVIDER=openai reads OPENAI_API_KEY and OPENAI_BASE_URL, for
 *    any OpenAI-compatible endpoint (OpenRouter, DeepSeek, Kimi, Qwen, local
 *    Ollama/vLLM, …). LIGHT_AGENT_MODEL is required here since there is no
 *    sensible default model across those services.
 *
 * Legacy HARNESS_* env vars still work as fallbacks.
 *
 * Throws a clear error if the needed key is missing.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  loadRuntimeEnv(cwd);

  const provider =
    (envValue("PROVIDER") ?? "anthropic").toLowerCase() === "openai"
      ? "openai"
      : "anthropic";

  const common = {
    provider,
    workdir: cwd,
    maxTurns: 50,
    bashTimeoutMs: 120_000,
    memoryEnabled: parseBoolFlag(envValue("MEMORY_ENABLED"), true),
    memoryExtractEvery: parsePositiveInt(envValue("MEMORY_EXTRACT_EVERY")) ?? 3,
    memoryInjectionBudget:
      parsePositiveInt(envValue("MEMORY_INJECTION_BUDGET")) ?? 3000,
    visionMode: parseVisionMode(envValue("VISION_MODE")),
    ...(envValue("THINKING")
      ? { thinkingDepth: parseThinkingDepth(envValue("THINKING")) }
      : {}),
    ...(parseContextWindow(envValue("CONTEXT_WINDOW"))
      ? { contextWindow: parseContextWindow(envValue("CONTEXT_WINDOW")) }
      : {}),
  } as const;

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LIGHT_AGENT_PROVIDER=openai but OPENAI_API_KEY is not set. Add it to " +
          ".env (and OPENAI_BASE_URL if your provider needs one).",
      );
    }
    const model = envValue("MODEL");
    if (!model) {
      throw new Error(
        "LIGHT_AGENT_PROVIDER=openai requires LIGHT_AGENT_MODEL (there is no default " +
          "model across OpenAI-compatible providers), " +
          'e.g. LIGHT_AGENT_MODEL="deepseek-chat" or "moonshot-v1-8k".',
      );
    }
    const baseURL = process.env.OPENAI_BASE_URL;
    return { ...common, apiKey, model, ...(baseURL ? { baseURL } : {}) };
  }

  // provider === "anthropic"
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your key, " +
        "or export ANTHROPIC_API_KEY in your shell.",
    );
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return {
    ...common,
    apiKey,
    model: envValue("MODEL") ?? DEFAULT_MODEL,
    ...(baseURL ? { baseURL } : {}),
  };
}
