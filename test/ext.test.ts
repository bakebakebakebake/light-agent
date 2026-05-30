import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, parseFrontMatter } from "../src/ext/skills.js";
import {
  loadCustomCommandDefs,
  renderTemplate,
  buildCustomCommands,
} from "../src/ext/commands.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  delete process.env.HARNESS_HOME;
});

/** Make an isolated workdir with a `.agent` tree; also points HARNESS_HOME away. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ext-"));
  dirs.push(root);
  // Point user-scope somewhere empty so only project-scope is exercised.
  const home = mkdtempSync(join(tmpdir(), "home-"));
  dirs.push(home);
  process.env.HARNESS_HOME = home;
  return root;
}

describe("parseFrontMatter", () => {
  it("splits --- front matter from the body", () => {
    const { data, body } = parseFrontMatter(
      "---\nname: Foo\ndescription: does foo\n---\nThe body.",
    );
    expect(data.name).toBe("Foo");
    expect(data.description).toBe("does foo");
    expect(body).toBe("The body.");
  });

  it("treats a document with no front matter as all body", () => {
    const { data, body } = parseFrontMatter("just text");
    expect(data).toEqual({});
    expect(body).toBe("just text");
  });
});

describe("loadSkills", () => {
  it("loads a SKILL.md directory form with front matter", () => {
    const root = scratch();
    const dir = join(root, ".agent", "skills", "review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: review\ndescription: code review helper\n---\nReview carefully.",
    );
    const skills = loadSkills(root);
    expect(skills.has("review")).toBe(true);
    expect(skills.get("review")!.body).toBe("Review carefully.");
    expect(skills.get("review")!.scope).toBe("project");
  });

  it("loads a flat <name>.md skill, deriving the name from the file", () => {
    const root = scratch();
    const dir = join(root, ".agent", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tldr.md"), "Summarize in one line.");
    const skills = loadSkills(root);
    expect(skills.has("tldr")).toBe(true);
    expect(skills.get("tldr")!.body).toBe("Summarize in one line.");
  });

  it("returns an empty map when there is no .agent dir", () => {
    const root = scratch();
    expect(loadSkills(root).size).toBe(0);
  });
});

describe("renderTemplate", () => {
  it("substitutes {{args}} with the supplied string", () => {
    expect(renderTemplate("Fix: {{args}}", "the bug")).toBe("Fix: the bug");
  });

  it("replaces every occurrence", () => {
    expect(renderTemplate("{{args}} and {{ args }}", "x")).toBe("x and x");
  });
});

describe("loadCustomCommandDefs + buildCustomCommands", () => {
  it("loads command templates and runs them by queuing input", async () => {
    const root = scratch();
    const dir = join(root, ".agent", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pr.md"),
      "---\ndescription: open a PR\n---\nDraft a PR for {{args}}.",
    );
    const defs = loadCustomCommandDefs(root);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("pr");

    const [cmd] = buildCustomCommands(defs);
    const state: { queuedInput?: string } = {};
    // Minimal context: the command only touches state.queuedInput.
    await cmd!.run({ state } as never, ["the login flow"]);
    expect(state.queuedInput).toBe("Draft a PR for the login flow.");
  });
});

