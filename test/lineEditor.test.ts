import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildRenderView,
  runEditor,
  shouldFullRedraw,
  type EditorResult,
} from "../src/ui/lineEditor.js";
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
  raw(str: string | undefined, key: Partial<Key> = {}): void {
    this.handler?.(str, {
      name: key.name,
      sequence: key.sequence ?? str ?? "",
      ctrl: key.ctrl ?? false,
      meta: key.meta ?? false,
      shift: key.shift ?? false,
    });
  }
  /** Send one key event to the editor. */
  send(name: string, opts: Partial<Key> = {}): void {
    this.raw(opts.sequence, { ...opts, name });
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

class TtyKeys extends FakeKeys {
  override isTTY = true;
}

function run(keys: FakeKeys, extra: Record<string, unknown> = {}): Promise<EditorResult> {
  return runEditor({ keys: keys as never, prompt: "> ", ...extra });
}

let writeSpy = vi.spyOn(process.stdout, "write");

afterEach(() => {
  writeSpy.mockReset();
  writeSpy.mockImplementation(() => true);
});

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

describe("lineEditor attached-skill backspace removal", () => {
  it("drops one attached skill at a time when the draft is empty", async () => {
    const keys = new FakeKeys();
    const detached: string[] = [];
    const pending = ["skill-a", "skill-b"];
    const p = run(keys, {
      detachLastSkill: () => {
        const last = pending.pop();
        if (!last) return false;
        detached.push(last);
        return true;
      },
    });
    keys.send("backspace");
    keys.send("backspace");
    keys.type("done");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "done" });
    expect(detached).toEqual(["skill-b", "skill-a"]);
  });
});

describe("lineEditor double Esc rewind", () => {
  it("submits /rewind after two Esc presses on an empty prompt", async () => {
    const keys = new FakeKeys();
    const p = run(keys);
    keys.send("escape");
    await Promise.resolve();
    let settled = false;
    p.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    keys.send("escape");
    expect(await p).toEqual({ kind: "submit", value: "/rewind" });
  });

  it("does not trigger rewind when the buffer is non-empty", async () => {
    const keys = new FakeKeys();
    const p = run(keys);
    keys.type("hello");
    keys.send("escape");
    keys.send("escape");
    await Promise.resolve();
    let settled = false;
    p.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "hello" });
  });

  it("still triggers rewind if an empty unnamed key event appears between Esc presses", async () => {
    const keys = new FakeKeys();
    const p = run(keys);
    keys.send("escape");
    // Some terminals can surface a follow-up event around Esc parsing.
    keys.raw(undefined, {});
    keys.send("escape");
    expect(await p).toEqual({ kind: "submit", value: "/rewind" });
  });
});

describe("lineEditor grouped pickers", () => {
  it("starts on the first selectable row and skips group headings", async () => {
    const keys = new FakeKeys();
    const p = run(keys, {
      pick: [
        { label: "Profiles", value: "__profiles__", selectable: false, tone: "dim" },
        { label: "work", value: "use:work", tone: "green" },
        { label: "Actions", value: "__actions__", selectable: false, tone: "dim" },
        { label: "New profile", value: "new" },
      ],
    });
    keys.send("down");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "new" });
  });

  it("filters picker items as you type and submits the filtered match", async () => {
    const keys = new FakeKeys();
    const p = run(keys, {
      pick: [
        { label: "Profiles", value: "__profiles__", selectable: false, tone: "dim" },
        { label: "deepseek-official", value: "use:deepseek" },
        { label: "packycode-aws-q", value: "use:packy", hint: "openai · qwen" },
      ],
    });
    keys.type("aws");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "use:packy" });
  });
});

describe("lineEditor slash menu enter", () => {
  it("submits the selected slash command directly on Enter", async () => {
    const keys = new FakeKeys();
    const p = run(keys, {
      menu: (buffer: string) =>
        buffer.startsWith("/pro")
          ? [
              { label: "/profile", value: "/profile", hint: "manage profiles" },
              { label: "/prompt", value: "/prompt", hint: "something else" },
            ]
          : null,
    });
    keys.type("/pro");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "/profile" });
  });
});

describe("lineEditor file menu sync", () => {
  it("closes a token menu after the cursor moves before the @ token", async () => {
    const keys = new FakeKeys();
    const p = run(keys, {
      fileMenu: (query: string) =>
        query
          ? [{ label: "src/app.ts", value: "src/app.ts", hint: "app entry" }]
          : null,
    });
    keys.type("say @abc");
    keys.send("left");
    keys.send("left");
    keys.send("left");
    keys.send("left");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "say @abc" });
  });

  it("opens the token menu after a bracketed paste inserts an @ token", async () => {
    const chunks: string[] = [];
    writeSpy.mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const keys = new TtyKeys();
    const p = run(keys, {
      fileMenu: (query: string) =>
        query
          ? [{ label: "src/app.ts", value: "src/app.ts", hint: "app entry" }]
          : null,
    });

    chunks.length = 0;
    keys.pasting = true;
    keys.type("@abc");
    keys.pasting = false;
    expect(chunks.join("")).toContain("src/app.ts");

    keys.send("return");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "src/app.ts " });
  });
});

describe("lineEditor inline skill badges", () => {
  it("refreshes badges immediately after attaching a # skill", async () => {
    const chunks: string[] = [];
    writeSpy.mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const keys = new TtyKeys();
    const badges: string[] = [];
    const p = run(keys, {
      skillMenu: (query: string) =>
        query.startsWith("rev")
          ? [{ label: "review", value: "review", hint: "project skill" }]
          : null,
      attachSkill: (name: string) => {
        badges.push(`skills: ${name}`);
      },
      badges: () => badges,
    });

    chunks.length = 0;
    keys.type("#rev");
    keys.send("return");
    expect(chunks.join("")).toContain("skills: review");

    keys.type("hello");
    keys.send("return");
    expect(await p).toEqual({ kind: "submit", value: "hello" });
  });

  it("drops attached skills one by one when backspacing an empty draft", async () => {
    const keys = new FakeKeys();
    const badges = ["skills: review", "skills: docs"];
    const p = run(keys, {
      badges: () => badges,
      detachLastSkill: () => {
        if (badges.length === 0) return false;
        badges.pop();
        return true;
      },
    });
    keys.send("backspace");
    keys.send("backspace");
    keys.type("hello");
    keys.send("return");
    expect(badges).toEqual([]);
    expect(await p).toEqual({ kind: "submit", value: "hello" });
  });

  it("lets arrow navigation focus attached skills and MCP items before history recall", async () => {
    const keys = new FakeKeys();
    const removed: string[] = [];
    const attachments = {
      skills: ["review", "docs"],
      mcps: ["github"],
    };
    const p = run(keys, {
      attachments: () => attachments,
      detachAttachment: (kind: "skill" | "mcp", label: string) => {
        const list = kind === "skill" ? attachments.skills : attachments.mcps;
        const idx = list.indexOf(label);
        if (idx === -1) return false;
        list.splice(idx, 1);
        removed.push(`${kind}:${label}`);
        return true;
      },
      history: ["older question"],
    });
    keys.send("up");
    keys.send("left");
    keys.send("backspace");
    keys.send("up");
    keys.send("backspace");
    keys.send("up");
    keys.send("return");
    expect(removed).toEqual(["skill:review", "mcp:github"]);
    expect(await p).toEqual({ kind: "submit", value: "older question" });
  });
});

describe("lineEditor render views", () => {
  it("builds a frame view with menu rows and footer rows", () => {
    const view = buildRenderView({
      prompt: "> ",
      lines: ["/pro"],
      row: 0,
      col: 4,
      mode: "menu",
      cols: 80,
      badges: ["skill:review"],
      menuItems: [
        { label: "Profiles", value: "__profiles__", selectable: false, tone: "dim" },
        { label: "/profile", value: "/profile", hint: "manage profiles", tone: "green" },
        { label: "/prompt", value: "/prompt", hint: "change the prompt" },
      ],
      menuSel: 1,
      footer: "workdir / main",
    });
    expect(view.kind).toBe("frame");
    expect(view.rows.join("\n")).toContain("Profiles");
    expect(view.rows.join("\n")).toContain("workdir / main");
    expect(view.cursorRowInRegion).toBeGreaterThan(0);
    expect(view.targetCol).toBeGreaterThan(0);
  });

  it("renders pending context badges inside the frame", () => {
    const view = buildRenderView({
      prompt: "> ",
      lines: ["hello"],
      row: 0,
      col: 5,
      mode: "edit",
      cols: 80,
      badges: ["skills: review, docs"],
    });
    expect(view.rows.join("\n")).toContain("skills: review, docs");
  });

  it("builds a picker view with an inline query and no footer", () => {
    const view = buildRenderView({
      prompt: "Choose",
      lines: [""],
      row: 0,
      col: 0,
      mode: "pick",
      cols: 80,
      menuItems: [{ label: "alpha", value: "a" }],
      pickQuery: "alp",
    });
    expect(view.kind).toBe("pick");
    expect(view.rows[1]).toContain("Search: alp");
    expect(view.rows.join("\n")).not.toContain("workdir");
  });

  it("treats menu/footer changes as structural redraws but cursor moves as partial updates", () => {
    const frame = buildRenderView({
      prompt: "> ",
      lines: ["hello"],
      row: 0,
      col: 1,
      mode: "edit",
      cols: 80,
      footer: "workdir / main",
    });
    const movedCursor = buildRenderView({
      prompt: "> ",
      lines: ["hello"],
      row: 0,
      col: 2,
      mode: "edit",
      cols: 80,
      footer: "workdir / main",
    });
    const withMenu = buildRenderView({
      prompt: "> ",
      lines: ["hello"],
      row: 0,
      col: 2,
      mode: "menu",
      cols: 80,
      menuItems: [{ label: "/profile", value: "/profile" }],
      menuSel: 0,
      footer: "workdir / main",
    });
    expect(shouldFullRedraw(frame, movedCursor)).toBe(false);
    expect(shouldFullRedraw(frame, withMenu)).toBe(true);
  });
});

describe("lineEditor TTY redraws", () => {
  it("anchors redraws with save/restore cursor sequences", async () => {
    const chunks: string[] = [];
    writeSpy.mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const keys = new TtyKeys();
    const p = run(keys);

    expect(chunks.join("")).toContain("\x1b7");
    chunks.length = 0;
    keys.type("a");
    expect(chunks.join("")).toContain("\x1b8");

    keys.send("return");
    await p;
  });

  it("full redraws on menu open but not on menu navigation", async () => {
    const chunks: string[] = [];
    writeSpy.mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const keys = new TtyKeys();
    const p = run(keys, {
      menu: (buffer: string) =>
        buffer.startsWith("/")
          ? [
              { label: "Profiles", value: "__profiles__", selectable: false, tone: "dim" },
              { label: "/profile", value: "/profile", hint: "manage profiles" },
              { label: "/prompt", value: "/prompt", hint: "change the prompt" },
            ]
          : null,
    });

    chunks.length = 0;
    keys.type("/");
    expect(chunks.join("")).toContain("\x1b[J");

    chunks.length = 0;
    keys.send("down");
    expect(chunks.join("")).not.toContain("\x1b[J");

    chunks.length = 0;
    keys.send("return");
    const submit = chunks.join("");
    expect(submit).toContain("> /prompt");
    expect(await p).toEqual({ kind: "submit", value: "/prompt" });
  });
});
