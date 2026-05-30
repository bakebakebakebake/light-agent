import { describe, it, expect, vi } from "vitest";
import { runEditor, type EditorResult } from "../src/ui/lineEditor.js";
import type { Key, KeyHandler } from "../src/ui/keys.js";

/**
 * A fake KeySource that captures the editor's key handler so a test can feed
 * keystrokes. isTTY is false so the editor's draw()/collapse routines no-op
 * (they only write escape codes) — we're testing logic, not rendering.
 */
class FakeKeys {
  isTTY = false;
  pasting = false;
  private handler: KeyHandler | null = null;
  onKey(h: KeyHandler | null): void {
    this.handler = h;
  }
  /** Send one key event to the editor. */
  send(name: string, opts: Partial<Key> = {}): void {
    const key: Key = {
      name,
      sequence: opts.sequence ?? "",
      ctrl: opts.ctrl ?? false,
      meta: opts.meta ?? false,
      shift: opts.shift ?? false,
    };
    this.handler?.(opts.sequence, key);
  }
  /** Type a literal printable string as one event. */
  type(str: string): void {
    this.handler?.(str, {
      name: str,
      sequence: str,
      ctrl: false,
      meta: false,
      shift: false,
    });
  }
  ctrlC(): void {
    this.send("c", { ctrl: true });
  }
}

function run(keys: FakeKeys, extra: Record<string, unknown> = {}): Promise<EditorResult> {
  return runEditor({ keys: keys as never, prompt: "> ", ...extra });
}

describe("lineEditor double Ctrl-C exit (#7)", () => {
  it("exits when Ctrl-C is pressed twice on an empty prompt", async () => {
    const keys = new FakeKeys();
    const p = run(keys);
    keys.ctrlC();
    keys.ctrlC();
    expect(await p).toEqual({ kind: "exit" });
  });

  it("does NOT exit on a single Ctrl-C — it only hints", async () => {
    const keys = new FakeKeys();
    let settled = false;
    const p = run(keys).then((r) => {
      settled = true;
      return r;
    });
    keys.ctrlC();
    await Promise.resolve();
    expect(settled).toBe(false);
    // A subsequent submit still works (the editor is alive).
    keys.type("hello");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "hello" });
  });

  it("first Ctrl-C clears a non-empty line instead of counting toward exit", async () => {
    const keys = new FakeKeys();
    const p = run(keys);
    keys.type("draft text");
    keys.ctrlC(); // clears the line (does not start the exit timer)
    keys.ctrlC(); // first empty-buffer press → hint only
    keys.type("real");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "real" });
  });

  it("resets the exit timer after a long gap between presses", async () => {
    vi.useFakeTimers();
    try {
      const keys = new FakeKeys();
      const p = run(keys);
      keys.ctrlC();
      vi.advanceTimersByTime(1500); // longer than the 1s window
      keys.ctrlC(); // counts as a fresh first press, not the second
      keys.type("x");
      keys.send("return");
      expect(await p).toEqual({ kind: "submit", value: "x" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lineEditor seed (#7)", () => {
  it("pre-fills the buffer with the seed text, editable and submittable", async () => {
    const keys = new FakeKeys();
    const p = run(keys, { seed: "interrupted question" });
    // Submit immediately: the seed should be the value.
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "interrupted question" });
  });

  it("places the cursor at the end of the seed so typing appends", async () => {
    const keys = new FakeKeys();
    const p = run(keys, { seed: "abc" });
    keys.type("d");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "abcd" });
  });
});
