import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/commands/builtins.js";
import type {
  CommandContext,
  SessionState,
} from "../src/commands/registry.js";
import {
  loadStore,
  saveStore,
  upsertProfile,
  type Profile,
} from "../src/profiles.js";
import { resolveConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { ModelProvider } from "../src/model/types.js";
import { newSession, saveSession } from "../src/sessions.js";

const SAVED = { ...process.env };
const realFetch = global.fetch;
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_HOME;
  delete process.env.HARNESS_PROFILE;
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function isolated(): string {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  process.env.HARNESS_HOME = home;
  return home;
}

function mockModelFetch(models: string[]): void {
  global.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: models.map((id) => ({ id })) }),
    }) as Response) as typeof fetch;
}

const fakeProvider: ModelProvider = {
  name: "fake",
  model: "fake-model",
  async *stream() {
    /* never called in these tests */
  },
};

const profileA: Profile = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  apiKey: "sk-ant-aaaaaaaa1234",
};
const profileB: Profile = {
  provider: "openai",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-deepseek-bbbb5678",
};

/** Build a session + a captured-output context backed by the current store. */
function makeCtx(answers: string[] = []): {
  ctx: CommandContext;
  state: SessionState;
  output: () => string;
  rebuildCalls: () => number;
} {
  const lines: string[] = [];
  let i = 0;
  let rebuilds = 0;

  const cfg = (resolveConfig("/work") ?? {
    provider: "anthropic",
    apiKey: "x",
    model: "m",
    workdir: "/work",
    maxTurns: 50,
    bashTimeoutMs: 1000,
  }) as Config;

  const state: SessionState = {
    config: cfg,
    provider: fakeProvider,
    profileName: loadStore().activeProfile,
    history: [],
    session: newSession(),
    mode: "default",
    usage: { input: 0, output: 0 },
    estimateContext() {
      return 0;
    },
    todos: [],
    pendingContext: [],
    rebuild() {
      rebuilds++;
      const next = resolveConfig("/work");
      if (next) this.config = next;
      this.profileName = loadStore().activeProfile;
    },
    save() {
      /* no-op in tests */
    },
    setMode(mode) {
      this.mode = mode;
    },
  };

  const ctx: CommandContext = {
    state,
    ask: async () => answers[i++] ?? "",
    out: (text) => lines.push(text),
    // Picker returns the answer queue entries by matching value, else first.
    pick: async (_prompt, items) => {
      const ans = answers[i++];
      const match = items.find((it) => it.value === ans || it.label === ans);
      return match?.value ?? ans ?? items[0]?.value ?? null;
    },
    clear: () => {},
  };

  return {
    ctx,
    state,
    output: () => lines.join("\n"),
    rebuildCalls: () => rebuilds,
  };
}

describe("dispatch parsing", () => {
  it("reports unknown commands", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/nope", ctx);
    expect(output()).toMatch(/Unknown command/);
  });

  it("returns exit for /exit and its alias /quit", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx } = makeCtx();
    expect((await reg.dispatch("/exit", ctx)).exit).toBe(true);
    expect((await reg.dispatch("/quit", ctx)).exit).toBe(true);
  });

  it("lists commands in /help", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/help", ctx);
    const out = output();
    expect(out).toMatch(/\/profile/);
    expect(out).toMatch(/\/model/);
    expect(out).toMatch(/\/help/);
  });

  it("shows the current todo list with /todo", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    state.todos = [
      { text: "Inspect files", status: "done" },
      { text: "Add tests", status: "in_progress" },
    ];
    await reg.dispatch("/todo", ctx);
    expect(output()).toContain("Session todo");
    expect(output()).toContain("[x] Inspect files");
    expect(output()).toContain("[~] Add tests");
  });

  it("shows whole-context usage separately from last-call usage", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    state.usage = { input: 734, output: 213 };
    state.estimateContext = () => 52_400;
    await reg.dispatch("/usage", ctx);
    const out = output();
    expect(out).toContain("52.4k");
    expect(out).toContain("734 in");
    expect(out).toContain("213 out");
    expect(out).toContain("last call");
  });
});

describe("/config masks the key", () => {
  it("never prints the raw apiKey", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/config", ctx);
    const out = output();
    expect(out).toContain("claude");
    expect(out).not.toContain(profileA.apiKey); // masked
    expect(out).toMatch(/…/);
  });
});

describe("/model", () => {
  it("shows the current model with no args", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/model", ctx);
    expect(output()).toContain(profileA.model);
  });

  it("sets the model on the active profile and rebuilds", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, rebuildCalls } = makeCtx();
    await reg.dispatch("/model claude-opus-4", ctx);
    expect(rebuildCalls()).toBe(1);
    expect(loadStore().profiles.claude!.model).toBe("claude-opus-4");
  });

  it("sets the model for this session when no active profile is stored", async () => {
    isolated(); // empty store
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const reg = buildRegistry();
    const { ctx, state, output, rebuildCalls } = makeCtx();
    await reg.dispatch("/model x", ctx);
    expect(output()).toMatch(/session only/);
    expect(rebuildCalls()).toBe(0);
    expect(state.config.model).toBe("x");
  });

  it("lets the picker switch to a recent model", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", {
      ...profileA,
      recentModels: [profileA.model, "claude-opus-4"],
    });
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, rebuildCalls } = makeCtx(["claude-opus-4"]);
    await reg.dispatch("/model", ctx);
    expect(rebuildCalls()).toBe(1);
    expect(loadStore().profiles.claude!.model).toBe("claude-opus-4");
  });

  it("fetches models for the default endpoint and lets the picker choose one", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", profileA);
    saveStore(store);
    mockModelFetch([profileA.model, "claude-opus-4"]);
    const reg = buildRegistry();
    const { ctx, rebuildCalls } = makeCtx(["claude-opus-4"]);
    await reg.dispatch("/model", ctx);
    expect(rebuildCalls()).toBe(1);
    expect(loadStore().profiles.claude!.model).toBe("claude-opus-4");
  });
});

describe("/profile edit (replaces /baseurl and /key)", () => {
  it("sets the base URL on the active profile (keep model, keep key)", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "ds", profileB);
    saveStore(store);
    const reg = buildRegistry();
    mockModelFetch([profileB.model, "deepseek-v4-chat"]);
    const { ctx } = makeCtx(["https://new.example/v1", ""]);
    await reg.dispatch("/profile edit ds", ctx);
    expect(loadStore().profiles.ds!.baseURL).toBe("https://new.example/v1");
  });

  it("updates the key from ask input and never echoes it", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "ds", profileB);
    saveStore(store);
    const reg = buildRegistry();
    mockModelFetch([profileB.model, "deepseek-v4-chat"]);
    const { ctx, output } = makeCtx(["", "sk-brand-new-secret-9999"]);
    await reg.dispatch("/profile edit ds", ctx);
    expect(loadStore().profiles.ds!.apiKey).toBe("sk-brand-new-secret-9999");
    expect(output()).not.toContain("sk-brand-new-secret-9999"); // never echoed
  });

  it("auto-discovers models after reading the current key and endpoint", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "claude", profileA);
    saveStore(store);
    mockModelFetch([profileA.model, "claude-opus-4"]);
    const reg = buildRegistry();
    const { ctx } = makeCtx(["", "", "claude-opus-4"]);
    await reg.dispatch("/profile edit claude", ctx);
    expect(loadStore().profiles.claude!.model).toBe("claude-opus-4");
  });
});

describe("/profile picker and alias", () => {
  it("uses the picker home screen to switch profiles", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    upsertProfile(store, "b", profileB);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, state, rebuildCalls } = makeCtx(["use:b"]);
    await reg.dispatch("/profile", ctx);
    expect(loadStore().activeProfile).toBe("b");
    expect(state.profileName).toBe("b");
    expect(rebuildCalls()).toBe(1);
  });

  it("groups profiles and actions, and marks the active row green", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    upsertProfile(store, "b", profileB);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx } = makeCtx();
    let prompt = "";
    let seen: Array<{
      label: string;
      value: string;
      hint?: string;
      selectable?: boolean;
      tone?: "green" | "dim";
    }> = [];
    ctx.pick = async (pickedPrompt, items) => {
      prompt = pickedPrompt;
      seen = items;
      return null;
    };
    await reg.dispatch("/profile", ctx);
    expect(prompt).toContain("Choose a profile");
    expect(seen[0]).toMatchObject({
      label: "Profiles",
      selectable: false,
      tone: "dim",
    });
    expect(seen.find((item) => item.value === "use:a")).toMatchObject({
      label: "a (active)",
      tone: "green",
    });
    expect(seen.find((item) => item.value === "__actions__")).toMatchObject({
      label: "Actions",
      selectable: false,
      tone: "dim",
    });
    expect(seen.find((item) => item.value === "edit")?.hint).toBe("a");
    expect(seen.find((item) => item.value === "rm")?.hint).toBe("a");
  });

  it("shows grouped fallback output and omits edit/remove without an active profile", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    ctx.pick = undefined;
    await reg.dispatch("/profile", ctx);
    const out = output();
    expect(out).toContain("Profiles");
    expect(out).toContain("Actions");
    expect(out).toContain("New profile");
    expect(out).not.toContain("Edit active profile");
    expect(out).not.toContain("Remove active profile");
  });

  it("keeps /profiles as an alias of /profile", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/profiles list", ctx);
    expect(output()).toContain("a");
  });
});

describe("/profile use | rm", () => {
  it("switches the active profile and rebuilds", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    upsertProfile(store, "b", profileB);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, state, rebuildCalls } = makeCtx();
    await reg.dispatch("/profile use b", ctx);
    expect(loadStore().activeProfile).toBe("b");
    expect(rebuildCalls()).toBe(1);
    expect(state.profileName).toBe("b");
  });

  it("errors on /profile use with an unknown name", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/profile use ghost", ctx);
    expect(output()).toMatch(/No profile/);
  });

  it("removes a non-active profile without confirmation", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    upsertProfile(store, "b", profileB);
    saveStore(store); // active = a
    const reg = buildRegistry();
    const { ctx } = makeCtx();
    await reg.dispatch("/profile rm b", ctx);
    expect(loadStore().profiles.b).toBeUndefined();
    expect(loadStore().activeProfile).toBe("a");
  });

  it("confirms before removing the active profile", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    upsertProfile(store, "b", profileB);
    saveStore(store); // active = a
    const reg = buildRegistry();
    // answer "n" → cancel
    const { ctx } = makeCtx(["n"]);
    await reg.dispatch("/profile rm a", ctx);
    expect(loadStore().profiles.a).toBeDefined();
  });
});

describe("/clear and /resume todo state", () => {
  it("clears todos when starting a fresh conversation", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    state.todos = [{ text: "Keep me?", status: "pending" }];
    await reg.dispatch("/clear", ctx);
    expect(state.todos).toEqual([]);
    expect(state.session.todos).toEqual([]);
  });

  it("restores todos from a resumed session", async () => {
    isolated();
    const reg = buildRegistry();
    const saved = newSession({ title: "todo session" });
    saved.messages.push({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    saved.todos = [{ text: "Resume me", status: "in_progress" }];
    saveSession(saved);

    const { ctx, state } = makeCtx([saved.id]);
    await reg.dispatch(`/resume ${saved.id}`, ctx);
    expect(state.session.id).toBe(saved.id);
    expect(state.todos).toEqual(saved.todos);
  });
});

describe("/mcp", () => {
  it("lists configured MCP servers from .agents/mcp", async () => {
    isolated();
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    mkdirSync(join(root, ".agents", "mcp"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "mcp", "docs.json"),
      JSON.stringify({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        description: "Docs server",
      }),
    );
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    state.config.workdir = root;
    await reg.dispatch("/mcp", ctx);
    const out = output();
    expect(out).toContain("MCP servers");
    expect(out).toContain("docs");
    expect(out).toContain("Docs server");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("/skill", () => {
  it("lists loaded skill names and descriptions", async () => {
    isolated();
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: code review helper\n---\nReview carefully.",
    );
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    state.config.workdir = root;
    await reg.dispatch("/skill", ctx);
    const out = output();
    expect(out).toContain("review");
    expect(out).toContain("code review helper");
    expect(out).toContain("Load with /skill <name>.");
    rmSync(root, { recursive: true, force: true });
  });

  it("injects only the selected skill body into pendingContext", async () => {
    isolated();
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: code review helper\n---\nReview carefully.",
    );
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    state.config.workdir = root;
    await reg.dispatch("/skill review", ctx);
    expect(state.pendingContext).toEqual(["# Skill: review\n\nReview carefully."]);
    expect(output()).toContain("only your next message will include its content");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("/clear", () => {
  it("empties history", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "a", profileA);
    saveStore(store);
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    state.history.push({ role: "user", content: [{ type: "text", text: "hi" }] });
    await reg.dispatch("/clear", ctx);
    expect(state.history).toHaveLength(0);
  });
});

describe("/mode", () => {
  it("shows the current mode with no args", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, output } = makeCtx();
    await reg.dispatch("/mode", ctx);
    expect(output()).toContain("default");
  });

  it("sets a recognized mode and updates state", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    await reg.dispatch("/mode plan", ctx);
    expect(state.mode).toBe("plan");
  });

  it("uses the picker when no argument is given", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx(["plan"]);
    await reg.dispatch("/mode", ctx);
    expect(state.mode).toBe("plan");
  });

  it("accepts the accept-edits alias", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    await reg.dispatch("/mode accept-edits", ctx);
    expect(state.mode).toBe("acceptEdits");
  });

  it("rejects an unknown mode", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    await reg.dispatch("/mode bogus", ctx);
    expect(state.mode).toBe("default");
    expect(output()).toMatch(/Unknown mode/);
  });
});

describe("/rewind", () => {
  function seedTurns(state: SessionState): void {
    // turn 1
    state.history.push({ role: "user", content: [{ type: "text", text: "first" }] });
    state.history.push({ role: "assistant", content: [{ type: "text", text: "a1" }] });
    // turn 2
    state.history.push({ role: "user", content: [{ type: "text", text: "second" }] });
    state.history.push({ role: "assistant", content: [{ type: "text", text: "a2" }] });
  }

  it("lists user turns with no args (no picker)", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state, output } = makeCtx();
    ctx.pick = undefined; // non-TTY fallback lists turns instead of prompting
    seedTurns(state);
    await reg.dispatch("/rewind", ctx);
    expect(output()).toContain("first");
    expect(output()).toContain("second");
  });

  it("truncates to the chosen turn (numeric arg)", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    seedTurns(state);
    expect(state.history).toHaveLength(4);
    await reg.dispatch("/rewind 1", ctx);
    // Rewinding to turn 1 drops turn 1 onward, leaving an empty history.
    expect(state.history).toHaveLength(0);
  });

  it("keeps earlier turns when rewinding to a later one", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx();
    seedTurns(state);
    await reg.dispatch("/rewind 2", ctx);
    // Turn 2 starts at index 2; truncating there keeps turn 1 (indices 0,1).
    expect(state.history).toHaveLength(2);
    expect(state.history[0]!.content).toEqual([{ type: "text", text: "first" }]);
    expect(state.seedInput).toBe("second");
  });

  it("cancels when the picker is dismissed", async () => {
    isolated();
    const reg = buildRegistry();
    // A picker that returns null (cancel) leaves history untouched.
    const { ctx, state, output } = makeCtx();
    ctx.pick = async () => null;
    seedTurns(state);
    await reg.dispatch("/rewind", ctx);
    expect(state.history).toHaveLength(4);
    expect(output()).toMatch(/cancelled/i);
  });

  it("seeds the rewound user message after a picker selection", async () => {
    isolated();
    const reg = buildRegistry();
    const { ctx, state } = makeCtx(["2"]);
    seedTurns(state);
    await reg.dispatch("/rewind", ctx);
    expect(state.history).toHaveLength(2);
    expect(state.seedInput).toBe("second");
  });
});

// silence unused import warning if vi is not otherwise used
void vi;
