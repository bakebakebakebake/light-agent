import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  memoryHome,
  memoryIndexPath,
  projectMemoryDir,
  transcriptDir,
  transcriptPath,
  userMemoryDir,
} from "../src/memory/paths.js";

const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_HOME;
});

describe("memory paths", () => {
  it("resolves user memory roots under HARNESS_HOME when set", () => {
    const home = mkdtempSync(join(tmpdir(), "ha-mem-home-"));
    process.env.HARNESS_HOME = home;
    expect(memoryHome()).toBe(join(home, "memory"));
    expect(userMemoryDir()).toBe(join(home, "memory", "user"));
    expect(memoryIndexPath()).toBe(join(home, "memory", "index.sqlite"));
    expect(transcriptDir()).toBe(join(home, "memory", "transcripts"));
    expect(transcriptPath("sess-1")).toBe(
      join(home, "memory", "transcripts", "sess-1.jsonl"),
    );
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps project cards separate from user memory and transcripts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ha-mem-workdir-"));
    const projectDir = projectMemoryDir(cwd);
    expect(projectDir).toBe(join(cwd, ".agents", "memory", "project"));
    expect(projectDir.startsWith(join(cwd, ".agents"))).toBe(true);
    expect(projectDir.includes(`${homedir()}/.light-agent`)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});
