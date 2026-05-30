import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// loadConfig reads process.env (and a .env in cwd). We point it at an empty
// temp dir so no stray .env interferes, and manage env vars per-test.
const emptyDir = mkdtempSync(join(tmpdir(), "harness-cfg-"));

const SAVED = { ...process.env };
afterEach(() => {
  // restore env to a clean baseline between tests
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_PROVIDER;
  delete process.env.HARNESS_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

function reset() {
  delete process.env.HARNESS_PROVIDER;
  delete process.env.HARNESS_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}

describe("loadConfig — provider selection", () => {
  it("defaults to anthropic and applies the default model", () => {
    reset();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadConfig(emptyDir);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toContain("claude");
    expect(cfg.baseURL).toBeUndefined();
  });

  it("passes ANTHROPIC_BASE_URL through for compatible proxies", () => {
    reset();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const cfg = loadConfig(emptyDir);
    expect(cfg.baseURL).toBe("https://proxy.example.com");
  });

  it("throws a clear error when the anthropic key is missing", () => {
    reset();
    expect(() => loadConfig(emptyDir)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("selects openai and requires a model", () => {
    reset();
    process.env.HARNESS_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(() => loadConfig(emptyDir)).toThrow(/HARNESS_MODEL/);
  });

  it("builds an openai config with base URL and model", () => {
    reset();
    process.env.HARNESS_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    process.env.HARNESS_MODEL = "deepseek-chat";
    const cfg = loadConfig(emptyDir);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.baseURL).toBe("https://api.deepseek.com/v1");
  });

  it("throws when openai is selected without a key", () => {
    reset();
    process.env.HARNESS_PROVIDER = "openai";
    process.env.HARNESS_MODEL = "deepseek-chat";
    expect(() => loadConfig(emptyDir)).toThrow(/OPENAI_API_KEY/);
  });
});

// cleanup temp dir at process exit
process.on("exit", () => rmSync(emptyDir, { recursive: true, force: true }));
