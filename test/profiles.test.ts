import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  loadStore,
  saveStore,
  storePath,
  setActive,
  upsertProfile,
  removeProfile,
  listProfiles,
  getActiveProfile,
  profileToConfig,
  rememberModel,
  maskKey,
  type Profile,
} from "../src/profiles.js";
import { resolveConfig } from "../src/config.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_HOME;
  delete process.env.HARNESS_PROFILE;
  delete process.env.HARNESS_PROVIDER;
  delete process.env.HARNESS_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

function isolated(): string {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  process.env.HARNESS_HOME = home;
  return home;
}

const anthropic: Profile = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  apiKey: "sk-ant-aaaaaaaa1234",
};
const deepseek: Profile = {
  provider: "openai",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-deepseekbbbb5678",
};

describe("store load/save", () => {
  it("returns an empty store when nothing is saved", () => {
    isolated();
    const store = loadStore();
    expect(store.activeProfile).toBeNull();
    expect(listProfiles(store)).toEqual([]);
  });

  it("persists and reloads profiles", () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", anthropic);
    upsertProfile(store, "deepseek", deepseek);
    saveStore(store);

    const reloaded = loadStore();
    expect(listProfiles(reloaded)).toEqual(["claude", "deepseek"]);
    expect(reloaded.activeProfile).toBe("claude"); // first upsert won
  });

  it("writes the store file 0600 (POSIX only)", () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", anthropic);
    const path = saveStore(store);
    expect(existsSync(path)).toBe(true);
    if (platform() !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("tolerates a corrupt store file", () => {
    const home = isolated();
    // saveStore creates the dir; write garbage where the store would be
    saveStore(loadStore());
    writeFileSync(join(home, "config.json"), "{ not json", "utf8");
    const store = loadStore();
    expect(store.activeProfile).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("CRUD", () => {
  it("setActive throws on unknown name", () => {
    const store = { activeProfile: null, profiles: {} };
    expect(() => setActive(store, "nope")).toThrow(/No profile/);
  });

  it("removeProfile moves active to a remaining profile", () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", anthropic);
    upsertProfile(store, "b", deepseek);
    setActive(store, "a");
    removeProfile(store, "a");
    expect(store.activeProfile).toBe("b");
  });

  it("removeProfile clears active when store becomes empty", () => {
    const store = { activeProfile: "a", profiles: { a: anthropic } };
    removeProfile(store, "a");
    expect(store.activeProfile).toBeNull();
    expect(listProfiles(store)).toEqual([]);
  });

  it("getActiveProfile returns null when active points nowhere", () => {
    expect(getActiveProfile({ activeProfile: "x", profiles: {} })).toBeNull();
  });
});

describe("profileToConfig + maskKey", () => {
  it("maps a profile into a runtime Config", () => {
    const cfg = profileToConfig(deepseek, "/work/dir");
    expect(cfg).toMatchObject({
      provider: "openai",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseekbbbb5678",
      workdir: "/work/dir",
    });
    expect(cfg.maxTurns).toBeGreaterThan(0);
  });

  it("omits baseURL when the profile has none", () => {
    const cfg = profileToConfig(anthropic, "/x");
    expect(cfg.baseURL).toBeUndefined();
  });

  it("masks a key without revealing the middle", () => {
    const masked = maskKey("sk-ant-abcdefghijklmnop1234");
    expect(masked).toContain("1234");
    expect(masked).toContain("…");
    expect(masked).not.toContain("ghijkl");
  });

  it("fully hides very short keys", () => {
    expect(maskKey("short")).toBe("•••••");
    expect(maskKey("")).toBe("(none)");
  });
});

describe("resolveConfig precedence", () => {
  it("prefers the active store profile over env", () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", anthropic);
    saveStore(store);
    // even with conflicting env, the store wins
    process.env.HARNESS_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.HARNESS_MODEL = "env-model";
    const cfg = resolveConfig("/tmp/x");
    expect(cfg?.provider).toBe("anthropic");
    expect(cfg?.apiKey).toBe(anthropic.apiKey);
  });

  it("HARNESS_PROFILE overrides the persisted active profile", () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", anthropic);
    upsertProfile(store, "deepseek", deepseek);
    setActive(store, "claude");
    saveStore(store);
    process.env.HARNESS_PROFILE = "deepseek";
    const cfg = resolveConfig("/tmp/x");
    expect(cfg?.model).toBe("deepseek-chat");
  });

  it("falls back to env when the store is empty", () => {
    isolated();
    process.env.ANTHROPIC_API_KEY = "sk-env-fallback";
    delete process.env.HARNESS_PROVIDER;
    const cfg = resolveConfig("/tmp/x");
    expect(cfg?.provider).toBe("anthropic");
    expect(cfg?.apiKey).toBe("sk-env-fallback");
  });

  it("returns null when neither store nor env is configured", () => {
    isolated();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const cfg = resolveConfig("/tmp/empty-no-env");
    expect(cfg).toBeNull();
  });
});

// keep storePath stable under HARNESS_HOME
describe("storePath", () => {
  it("lives under HARNESS_HOME when set", () => {
    const home = isolated();
    expect(storePath()).toBe(join(home, "config.json"));
  });
});

describe("rememberModel", () => {
  it("inserts the model at the front, newest first", () => {
    const p = rememberModel(anthropic, "model-a");
    expect(p.recentModels).toEqual(["model-a"]);
    const p2 = rememberModel(p, "model-b");
    expect(p2.recentModels).toEqual(["model-b", "model-a"]);
  });

  it("moves an existing model to the front without duplicating", () => {
    let p = rememberModel(anthropic, "a");
    p = rememberModel(p, "b");
    p = rememberModel(p, "a");
    expect(p.recentModels).toEqual(["a", "b"]);
  });

  it("caps the history length", () => {
    let p: Profile = anthropic;
    for (let i = 0; i < 20; i++) p = rememberModel(p, `m${i}`);
    expect(p.recentModels!.length).toBeLessThanOrEqual(8);
    expect(p.recentModels![0]).toBe("m19"); // newest
  });

  it("does not mutate the input profile", () => {
    const p = rememberModel(anthropic, "x");
    expect(anthropic.recentModels).toBeUndefined();
    expect(p).not.toBe(anthropic);
  });

  it("ignores an empty model id", () => {
    expect(rememberModel(anthropic, "")).toBe(anthropic);
  });
});
