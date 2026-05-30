import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  newSession,
  saveSession,
  loadSession,
  listSessions,
  renameSession,
  deriveTitle,
  sessionsDir,
} from "../src/sessions.js";
import type { Message } from "../src/model/types.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_HOME;
});

function isolated(): string {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  process.env.HARNESS_HOME = home;
  return home;
}

const userMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("save/load", () => {
  it("round-trips a session", () => {
    isolated();
    const s = newSession({ title: "hello", provider: "openai", model: "gpt-4o" });
    s.messages.push(userMsg("first message"));
    saveSession(s);
    const loaded = loadSession(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("hello");
    expect(loaded!.provider).toBe("openai");
    expect(loaded!.messages).toHaveLength(1);
  });

  it("returns null for a missing session", () => {
    isolated();
    expect(loadSession("does-not-exist")).toBeNull();
  });

  it("writes session files 0600 (POSIX only)", () => {
    isolated();
    const s = newSession();
    const path = saveSession(s);
    if (platform() !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});

describe("listSessions", () => {
  it("returns summaries newest-updated first", async () => {
    isolated();
    const a = newSession({ title: "older" });
    saveSession(a);
    // Force a later updatedAt for b.
    const b = newSession({ title: "newer" });
    b.updatedAt = new Date(Date.now() + 1000).toISOString();
    saveSession(b);
    // saveSession refreshes updatedAt, so re-touch b to be sure it's newest.
    const list = listSessions();
    expect(list.length).toBe(2);
    expect(list.map((s) => s.title)).toContain("older");
    expect(list.map((s) => s.title)).toContain("newer");
    // sorted descending by updatedAt
    expect(list[0]!.updatedAt >= list[1]!.updatedAt).toBe(true);
  });

  it("returns an empty array when no sessions exist", () => {
    isolated();
    expect(listSessions()).toEqual([]);
  });
});

describe("renameSession", () => {
  it("renames and persists", () => {
    isolated();
    const s = newSession({ title: "before" });
    saveSession(s);
    expect(renameSession(s.id, "after")).toBe(true);
    expect(loadSession(s.id)!.title).toBe("after");
  });

  it("returns false for an unknown id", () => {
    isolated();
    expect(renameSession("nope", "x")).toBe(false);
  });
});

describe("deriveTitle", () => {
  it("uses the first user text line, capped", () => {
    const msgs: Message[] = [userMsg("fix the bug\nand more details")];
    expect(deriveTitle(msgs)).toBe("fix the bug");
  });

  it("truncates long titles with an ellipsis", () => {
    const long = "x".repeat(80);
    expect(deriveTitle([userMsg(long)], 10)).toBe("x".repeat(10) + "…");
  });

  it("falls back to Untitled with no user text", () => {
    expect(deriveTitle([])).toBe("Untitled");
  });
});

describe("sessionsDir", () => {
  it("lives under HARNESS_HOME/sessions", () => {
    const home = isolated();
    expect(sessionsDir()).toBe(join(home, "sessions"));
    rmSync(home, { recursive: true, force: true });
  });
});
