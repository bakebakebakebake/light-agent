import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfigured, writeEnvEntries } from "../src/config.js";
import {
  collectOnboarding,
  applyOnboarding,
  type Ask,
} from "../src/onboarding.js";
import { loadStore } from "../src/profiles.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_PROVIDER;
  delete process.env.HARNESS_MODEL;
  delete process.env.HARNESS_PROFILE;
  delete process.env.HARNESS_HOME;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

/** Point the profile store at a fresh empty temp dir so the real one (under
 * ~/.harness-agent) never interferes with env-fallback assertions. */
function isolatedStore(): string {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  process.env.HARNESS_HOME = home;
  return home;
}

/** A scripted prompt: returns queued answers in order. */
function scriptedAsk(answers: string[]): Ask {
  let i = 0;
  return async () => answers[i++] ?? "";
}

const noModels = async () => ({ models: [] as string[] });

describe("isConfigured", () => {
  it("returns false with no store and no env creds", () => {
    isolatedStore();
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    delete process.env.HARNESS_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    expect(isConfigured(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a key from an existing .env (fallback path)", () => {
    isolatedStore();
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-x\n");
    delete process.env.ANTHROPIC_API_KEY;
    expect(isConfigured(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires both key and model for openai (fallback path)", () => {
    isolatedStore();
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    writeFileSync(
      join(dir, ".env"),
      "HARNESS_PROVIDER=openai\nOPENAI_API_KEY=sk-x\n",
    );
    delete process.env.HARNESS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.HARNESS_MODEL;
    expect(isConfigured(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns true when the store has an active profile", async () => {
    isolatedStore();
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    delete process.env.ANTHROPIC_API_KEY;
    await applyOnboarding(scriptedAsk([""]), {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      entries: { ANTHROPIC_API_KEY: "sk-ant-stored" },
    });
    expect(isConfigured(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeEnvEntries", () => {
  it("creates .env with appended entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    const path = writeEnvEntries(dir, {
      ANTHROPIC_API_KEY: "sk-ant-x",
      HARNESS_MODEL: "claude-sonnet-4-5-20250929",
    });
    const body = readFileSync(path, "utf8");
    expect(body).toContain("ANTHROPIC_API_KEY=sk-ant-x");
    expect(body).toContain("HARNESS_MODEL=claude-sonnet-4-5-20250929");
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates an existing key in place and preserves comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "onb-"));
    writeFileSync(
      join(dir, ".env"),
      "# my config\nANTHROPIC_API_KEY=old\nOTHER=keep\n",
    );
    writeEnvEntries(dir, { ANTHROPIC_API_KEY: "new" });
    const body = readFileSync(join(dir, ".env"), "utf8");
    expect(body).toContain("# my config");
    expect(body).toContain("ANTHROPIC_API_KEY=new");
    expect(body).not.toContain("ANTHROPIC_API_KEY=old");
    expect(body).toContain("OTHER=keep");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("collectOnboarding", () => {
  it("collects an anthropic setup with defaults", async () => {
    // choice=1, key, blank baseURL, blank model (use default)
    const result = await collectOnboarding(
      scriptedAsk(["1", "sk-ant-test", "", ""]),
      noModels,
    );
    expect(result.provider).toBe("anthropic");
    expect(result.entries.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(result.entries.HARNESS_MODEL).toContain("claude");
    expect(result.entries.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("collects an anthropic proxy with a base URL", async () => {
    const result = await collectOnboarding(
      scriptedAsk(["1", "sk-ant-test", "https://proxy.example.com", ""]),
      noModels,
    );
    expect(result.entries.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
  });

  it("collects an openai-compatible setup", async () => {
    // choice=2, key, baseURL, model
    const result = await collectOnboarding(
      scriptedAsk([
        "2",
        "sk-test",
        "https://api.deepseek.com/v1",
        "deepseek-chat",
      ]),
      noModels,
    );
    expect(result.provider).toBe("openai");
    expect(result.entries.OPENAI_API_KEY).toBe("sk-test");
    expect(result.entries.OPENAI_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(result.entries.HARNESS_MODEL).toBe("deepseek-chat");
  });

  it("re-prompts until a model is given for openai", async () => {
    // model required: two blanks then a value
    const result = await collectOnboarding(
      scriptedAsk(["2", "sk-test", "", "", "", "moonshot-v1-8k"]),
      noModels,
    );
    expect(result.entries.HARNESS_MODEL).toBe("moonshot-v1-8k");
  });
});

describe("collectOnboarding model fetching (#9)", () => {
  it("offers a fetched list and accepts a numeric pick", async () => {
    // choice=1, key, blank baseURL, then "2" to select the 2nd fetched model.
    const fetch = async () => ({ models: ["model-one", "model-two"] });
    const result = await collectOnboarding(
      scriptedAsk(["1", "sk-ant-test", "", "2"]),
      fetch,
    );
    expect(result.model).toBe("model-two");
    expect(result.entries.HARNESS_MODEL).toBe("model-two");
  });

  it("accepts a typed model name even when a list is offered", async () => {
    const fetch = async () => ({ models: ["a", "b"] });
    const result = await collectOnboarding(
      scriptedAsk(["1", "sk-ant-test", "", "custom-model"]),
      fetch,
    );
    expect(result.model).toBe("custom-model");
  });

  it("falls back to manual entry when the fetch returns nothing", async () => {
    // empty list → falls through to the Anthropic manual prompt (blank = default)
    const fetch = async () => ({ models: [] as string[] });
    const result = await collectOnboarding(
      scriptedAsk(["1", "sk-ant-test", "", ""]),
      fetch,
    );
    expect(result.model).toContain("claude");
  });

  it("falls back to manual entry when the fetch errors", async () => {
    const fetch = async () => ({ models: [] as string[], error: "boom" });
    const result = await collectOnboarding(
      scriptedAsk(["2", "sk-test", "https://x/v1", "deepseek-chat"]),
      fetch,
    );
    expect(result.model).toBe("deepseek-chat");
  });
});

describe("applyOnboarding", () => {
  it("writes a profile to the store and sets it active", async () => {
    isolatedStore();
    const { profileName } = await applyOnboarding(scriptedAsk(["work"]), {
      provider: "openai",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      entries: { OPENAI_API_KEY: "sk-applied" },
    });
    expect(profileName).toBe("work");
    const store = loadStore();
    expect(store.activeProfile).toBe("work");
    expect(store.profiles.work).toMatchObject({
      provider: "openai",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-applied",
    });
  });

  it("defaults the profile name to 'default' when blank", async () => {
    isolatedStore();
    const { profileName } = await applyOnboarding(scriptedAsk([""]), {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      entries: { ANTHROPIC_API_KEY: "sk-ant-x" },
    });
    expect(profileName).toBe("default");
    expect(loadStore().activeProfile).toBe("default");
  });
});
