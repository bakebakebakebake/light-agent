import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
import { newSession } from "../src/sessions.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
  delete process.env.HARNESS_HOME;
  delete process.env.HARNESS_PROFILE;
});

function isolated(): string {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  process.env.HARNESS_HOME = home;
  return home;
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

  it("refuses to set a model with no active profile (env fallback)", async () => {
    isolated(); // empty store
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const reg = buildRegistry();
    const { ctx, output, rebuildCalls } = makeCtx();
    await reg.dispatch("/model x", ctx);
    expect(output()).toMatch(/No active profile/);
    expect(rebuildCalls()).toBe(0);
  });
});

describe("/profile edit (replaces /baseurl and /key)", () => {
  it("sets the base URL on the active profile (keep model, keep key)", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "ds", profileB);
    saveStore(store);
    const reg = buildRegistry();
    // profileEdit asks: Model, Base URL, API key — blank keeps the current.
    const { ctx } = makeCtx(["", "https://new.example/v1", ""]);
    await reg.dispatch("/profile edit ds", ctx);
    expect(loadStore().profiles.ds!.baseURL).toBe("https://new.example/v1");
  });

  it("updates the key from ask input and never echoes it", async () => {
    isolated();
    const store = loadStore();
    upsertProfile(store, "ds", profileB);
    saveStore(store);
    const reg = buildRegistry();
    // Keep model + base URL, change only the (secret) key.
    const { ctx, output } = makeCtx(["", "", "sk-brand-new-secret-9999"]);
    await reg.dispatch("/profile edit ds", ctx);
    expect(loadStore().profiles.ds!.apiKey).toBe("sk-brand-new-secret-9999");
    expect(output()).not.toContain("sk-brand-new-secret-9999"); // never echoed
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
});

// silence unused import warning if vi is not otherwise used
void vi;
