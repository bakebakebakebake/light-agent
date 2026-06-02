import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  parseBoolFlag,
  parsePositiveInt,
} from "../src/config.js";

const emptyDir = mkdtempSync(join(tmpdir(), "harness-mem-cfg-"));
const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LIGHT_AGENT_MEMORY_ENABLED;
  delete process.env.LIGHT_AGENT_MEMORY_EXTRACT_EVERY;
  delete process.env.LIGHT_AGENT_MEMORY_INJECTION_BUDGET;
  delete process.env.HARNESS_MEMORY_ENABLED;
  delete process.env.HARNESS_MEMORY_EXTRACT_EVERY;
  delete process.env.HARNESS_MEMORY_INJECTION_BUDGET;
});

describe("memory config flags", () => {
  it("parses boolean flags with a fallback", () => {
    expect(parseBoolFlag(undefined, true)).toBe(true);
    expect(parseBoolFlag("false", true)).toBe(false);
    expect(parseBoolFlag("1", false)).toBe(true);
    expect(parseBoolFlag("wat", true)).toBe(true);
  });

  it("parses positive integers and rejects invalid values", () => {
    expect(parsePositiveInt("3")).toBe(3);
    expect(parsePositiveInt("0")).toBeUndefined();
    expect(parsePositiveInt("-1")).toBeUndefined();
    expect(parsePositiveInt("abc")).toBeUndefined();
  });

  it("applies memory defaults when no overrides are set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadConfig(emptyDir);
    expect(cfg.memoryEnabled).toBe(true);
    expect(cfg.memoryExtractEvery).toBe(3);
    expect(cfg.memoryInjectionBudget).toBe(3000);
  });

  it("accepts explicit memory overrides from env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.LIGHT_AGENT_MEMORY_ENABLED = "false";
    process.env.LIGHT_AGENT_MEMORY_EXTRACT_EVERY = "5";
    process.env.LIGHT_AGENT_MEMORY_INJECTION_BUDGET = "1200";
    const cfg = loadConfig(emptyDir);
    expect(cfg.memoryEnabled).toBe(false);
    expect(cfg.memoryExtractEvery).toBe(5);
    expect(cfg.memoryInjectionBudget).toBe(1200);
  });
});

process.on("exit", () => rmSync(emptyDir, { recursive: true, force: true }));
