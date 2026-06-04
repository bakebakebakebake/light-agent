import {
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { CompatibilitySnapshot } from "./model/compat.js";
import type { ThinkingDepth } from "./model/types.js";
import type { VisionMode } from "./util/images.js";

/**
 * Global profile store (docs/06).
 *
 * Credentials and per-provider settings live in a single JSON file under the
 * user's home — NOT inside any repo — so multiple named "profiles" (e.g. an
 * Anthropic one and a DeepSeek one) coexist and are shared across projects.
 * The active profile drives the runtime Config; slash commands manage the set.
 *
 * Security (docs/04): the file holds API keys, so it is written 0600 (owner
 * read/write only) and never committed. Keys are only ever displayed masked
 * (see maskKey) — the raw value is never printed or logged.
 */

/** One named configuration: a provider + model + credentials. */
export interface Profile {
  provider: "anthropic" | "openai";
  model: string;
  /** Optional API base URL (proxies, OpenAI-compatible aggregators, local). */
  baseURL?: string;
  apiKey: string;
  /** Reasoning depth (A1). Persisted per profile; defaults to "off". */
  thinkingDepth?: ThinkingDepth;
  /**
   * Optional context-window override in tokens (#11). When set, it wins over the
   * built-in model→window table — the escape hatch for models the table doesn't
   * cover or gets wrong for a given provider/deployment.
   */
  contextWindow?: number;
  /** Recently-selected model ids, newest first (feature #8). Bounded length. */
  recentModels?: string[];
  /** Image-input policy for the profile. */
  visionMode?: VisionMode;
  /** Cached compatibility probe results for this endpoint/profile. */
  compat?: CompatibilitySnapshot;
}

/** How many recent model ids to retain per profile. */
const MAX_RECENT_MODELS = 8;

/**
 * Record `model` as the most-recently-used for a profile: move/insert it at the
 * front of recentModels, de-duplicated, capped at MAX_RECENT_MODELS. Returns a
 * new Profile (does not mutate the input).
 */
export function rememberModel(profile: Profile, model: string): Profile {
  if (!model) return profile;
  const prev = profile.recentModels ?? [];
  const recentModels = [model, ...prev.filter((m) => m !== model)].slice(
    0,
    MAX_RECENT_MODELS,
  );
  return { ...profile, recentModels };
}

/** The on-disk shape: a set of profiles plus which one is active. */
export interface ProfileStore {
  activeProfile: string | null;
  profiles: Record<string, Profile>;
}

const STORE_FILE = "config.json";
const STORE_DIR_NAME = ".light-agent";
const LEGACY_STORE_DIR_NAME = ".harness-agent";

/**
 * Directory that holds the store. Prefers ~/.light-agent for fresh installs,
 * but keeps using ~/.harness-agent when that legacy directory already exists.
 * Both LIGHT_AGENT_HOME and the legacy HARNESS_HOME override the default.
 */
export function storeDir(): string {
  const explicit = process.env.LIGHT_AGENT_HOME ?? process.env.HARNESS_HOME;
  if (explicit) return explicit;
  const preferred = join(homedir(), STORE_DIR_NAME);
  const legacy = join(homedir(), LEGACY_STORE_DIR_NAME);
  if (existsSync(preferred)) return preferred;
  if (existsSync(legacy)) {
    try {
      renameSync(legacy, preferred);
      return preferred;
    } catch {
      try {
        cpSync(legacy, preferred, { recursive: true });
        rmSync(legacy, { recursive: true, force: true });
        return preferred;
      } catch {
        return legacy;
      }
    }
  }
  return preferred;
}

/** Absolute path to the store file. */
export function storePath(): string {
  return join(storeDir(), STORE_FILE);
}

/** An empty store — used when nothing has been configured yet. */
function emptyStore(): ProfileStore {
  return { activeProfile: null, profiles: {} };
}

/**
 * Read the store from disk. Returns an empty store if the file is missing or
 * unreadable/corrupt (so a bad file never crashes startup — the CLI will just
 * fall back to onboarding).
 */
export function loadStore(): ProfileStore {
  const path = storePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileStore>;
    return {
      activeProfile: parsed.activeProfile ?? null,
      profiles: parsed.profiles ?? {},
    };
  } catch {
    return emptyStore();
  }
}

/**
 * Persist the store, creating the directory if needed and locking the file to
 * owner-only permissions (0600) since it contains secrets.
 */
export function saveStore(store: ProfileStore): string {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  const path = storePath();
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  // Lock down: keys live here. Best-effort on platforms without POSIX modes.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore (e.g. Windows) */
  }
  return path;
}

/** The active profile, or null if none is set / it no longer exists. */
export function getActiveProfile(store: ProfileStore): Profile | null {
  if (!store.activeProfile) return null;
  return store.profiles[store.activeProfile] ?? null;
}

/** Names of all profiles, sorted for stable display. */
export function listProfiles(store: ProfileStore): string[] {
  return Object.keys(store.profiles).sort();
}

/** Set the active profile. Throws if the name doesn't exist. */
export function setActive(store: ProfileStore, name: string): void {
  if (!(name in store.profiles)) {
    throw new Error(`No profile named "${name}".`);
  }
  store.activeProfile = name;
}

/**
 * Create or replace a profile. If it's the first profile, it also becomes
 * active (so a fresh store is immediately usable).
 */
export function upsertProfile(
  store: ProfileStore,
  name: string,
  profile: Profile,
): void {
  store.profiles[name] = profile;
  if (!store.activeProfile) store.activeProfile = name;
}

/**
 * Remove a profile. If it was the active one, the active pointer moves to any
 * remaining profile (or null when the store is now empty).
 */
export function removeProfile(store: ProfileStore, name: string): void {
  if (!(name in store.profiles)) {
    throw new Error(`No profile named "${name}".`);
  }
  delete store.profiles[name];
  if (store.activeProfile === name) {
    const remaining = listProfiles(store);
    store.activeProfile = remaining[0] ?? null;
  }
}

/** Build a runtime Config from a profile + working directory. */
export function profileToConfig(profile: Profile, cwd: string): Config {
  return {
    provider: profile.provider,
    apiKey: profile.apiKey,
    model: profile.model,
    ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
    ...(profile.thinkingDepth ? { thinkingDepth: profile.thinkingDepth } : {}),
    ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
    ...(profile.visionMode ? { visionMode: profile.visionMode } : {}),
    ...(profile.compat ? { compat: profile.compat } : {}),
    workdir: cwd,
    maxTurns: 50,
    bashTimeoutMs: 120_000,
    memoryEnabled: true,
    memoryExtractEvery: 3,
    memoryInjectionBudget: 3000,
  };
}

/**
 * Mask an API key for display: keep a short prefix and the last 4 chars, hide
 * the middle. Never reveals enough to be useful if shoulder-surfed or logged.
 */
export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "•".repeat(key.length);
  const tail = key.slice(-4);
  const head = key.slice(0, Math.min(6, key.length - 4));
  return `${head}…${tail}`;
}
