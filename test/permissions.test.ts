import { describe, it, expect } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createGate, type Confirmer } from "../src/permissions/confirm.js";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types.js";
import type { RiskLevel } from "../src/tools/types.js";

function toolOf(name: string, risk: RiskLevel): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskLevel: risk,
    concurrency: risk === "low" ? "concurrent" : "exclusive",
    async execute(): Promise<ToolResult> {
      return { content: "ran", isError: false };
    },
  };
}

const yesConfirmer: Confirmer = { async confirm() { return true; } };
const noConfirmer: Confirmer = { async confirm() { return false; } };

describe("PermissionPolicy — risk tiers", () => {
  it("maps low→allow, medium→notify, high→confirm by default", () => {
    const p = new PermissionPolicy();
    expect(p.actionFor("low")).toBe("allow");
    expect(p.actionFor("medium")).toBe("notify");
    expect(p.actionFor("high")).toBe("confirm");
  });

  it("degrades medium→confirm after enough denials (graceful degradation)", () => {
    const p = new PermissionPolicy({ denialThreshold: 2 });
    expect(p.degraded).toBe(false);
    p.recordDenial();
    expect(p.actionFor("medium")).toBe("notify");
    p.recordDenial();
    expect(p.degraded).toBe(true);
    expect(p.actionFor("medium")).toBe("confirm");
  });
});

describe("createGate — confirmation flow", () => {
  const workdir = process.cwd();

  it("allows low-risk tools without asking", async () => {
    const gate = createGate({
      policy: new PermissionPolicy(),
      confirmer: noConfirmer, // would deny if asked — proves it isn't asked
      workdir,
    });
    const d = await gate({ tool: toolOf("read", "low"), input: {} });
    expect(d.allow).toBe(true);
  });

  it("runs medium-risk tools but notifies", async () => {
    const seen: string[] = [];
    const gate = createGate({
      policy: new PermissionPolicy(),
      confirmer: noConfirmer,
      workdir,
      notify: (r) => seen.push(r.toolName),
    });
    const d = await gate({ tool: toolOf("edit", "medium"), input: {} });
    expect(d.allow).toBe(true);
    expect(seen).toContain("edit");
  });

  it("blocks a high-risk tool when the user declines", async () => {
    const policy = new PermissionPolicy();
    const gate = createGate({ policy, confirmer: noConfirmer, workdir });
    const d = await gate({ tool: toolOf("bash", "high"), input: {} });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("declined");
  });

  it("runs a high-risk tool when the user approves", async () => {
    const gate = createGate({
      policy: new PermissionPolicy(),
      confirmer: yesConfirmer,
      workdir,
    });
    const d = await gate({ tool: toolOf("bash", "high"), input: {} });
    expect(d.allow).toBe(true);
  });

  it("counts denials toward degradation", async () => {
    const policy = new PermissionPolicy({ denialThreshold: 2 });
    const gate = createGate({ policy, confirmer: noConfirmer, workdir });
    await gate({ tool: toolOf("bash", "high"), input: {} });
    await gate({ tool: toolOf("bash", "high"), input: {} });
    expect(policy.degraded).toBe(true);
    // now even medium-risk requires confirmation, and noConfirmer denies it
    const d = await gate({ tool: toolOf("edit", "medium"), input: {} });
    expect(d.allow).toBe(false);
  });
});

describe("PermissionPolicy — modes (#5)", () => {
  it("plan mode allows reads but denies edits and bash", () => {
    const p = new PermissionPolicy({ mode: "plan" });
    expect(p.actionFor("low")).toBe("allow");
    expect(p.actionFor("medium")).toBe("deny");
    expect(p.actionFor("high")).toBe("deny");
  });

  it("acceptEdits auto-allows edits but still confirms bash", () => {
    const p = new PermissionPolicy({ mode: "acceptEdits" });
    expect(p.actionFor("low")).toBe("allow");
    expect(p.actionFor("medium")).toBe("allow");
    expect(p.actionFor("high")).toBe("confirm");
  });

  it("allowAll allows every tier", () => {
    const p = new PermissionPolicy({ mode: "allowAll" });
    expect(p.actionFor("low")).toBe("allow");
    expect(p.actionFor("medium")).toBe("allow");
    expect(p.actionFor("high")).toBe("allow");
  });

  it("setMode switches behavior live", () => {
    const p = new PermissionPolicy();
    expect(p.actionFor("high")).toBe("confirm");
    p.setMode("allowAll");
    expect(p.actionFor("high")).toBe("allow");
    expect(p.getMode()).toBe("allowAll");
    p.setMode("plan");
    expect(p.actionFor("medium")).toBe("deny");
  });
});

describe("createGate — modes (#5)", () => {
  const workdir = process.cwd();

  it("plan mode denies a mutating tool without asking the confirmer", async () => {
    let asked = false;
    const confirmer: Confirmer = {
      async confirm() {
        asked = true;
        return true;
      },
    };
    const gate = createGate({
      policy: new PermissionPolicy({ mode: "plan" }),
      confirmer,
      workdir,
    });
    const d = await gate({ tool: toolOf("edit", "medium"), input: {} });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("plan");
    expect(asked).toBe(false); // a denied-by-mode action never prompts
  });

  it("plan-mode denials do NOT degrade trust (not user denials)", async () => {
    const policy = new PermissionPolicy({ mode: "plan", denialThreshold: 2 });
    const gate = createGate({ policy, confirmer: noConfirmer, workdir });
    await gate({ tool: toolOf("bash", "high"), input: {} });
    await gate({ tool: toolOf("bash", "high"), input: {} });
    expect(policy.degraded).toBe(false);
  });

  it("allowAll runs a high-risk tool without calling the confirmer", async () => {
    let asked = false;
    const confirmer: Confirmer = {
      async confirm() {
        asked = true;
        return false;
      },
    };
    const gate = createGate({
      policy: new PermissionPolicy({ mode: "allowAll" }),
      confirmer,
      workdir,
    });
    const d = await gate({ tool: toolOf("bash", "high"), input: {} });
    expect(d.allow).toBe(true);
    expect(asked).toBe(false);
  });

  it("acceptEdits auto-runs an edit without notifying or asking", async () => {
    let notified = false;
    const gate = createGate({
      policy: new PermissionPolicy({ mode: "acceptEdits" }),
      confirmer: noConfirmer,
      workdir,
      notify: () => {
        notified = true;
      },
    });
    const d = await gate({ tool: toolOf("edit", "medium"), input: {} });
    expect(d.allow).toBe(true);
    expect(notified).toBe(false);
  });
});
