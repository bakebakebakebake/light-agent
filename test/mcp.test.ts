import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mcpSearchTool } from "../src/tools/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadMcpServerDefinitions } from "../src/ext/mcp.js";
import { LocalMcpRuntime } from "../src/mcp/runtime.js";
import type { McpRuntime, McpToolCandidate } from "../src/mcp/types.js";

let dir: string;
const SAVED_ENV = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-"));
  process.env.LIGHT_AGENT_HOME = dir;
  delete process.env.HARNESS_HOME;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP config discovery", () => {
  it("loads project server definitions from .agent/mcp", () => {
    const mcpDir = join(dir, ".agent", "mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "mock.json"),
      JSON.stringify(
        {
          name: "mock",
          command: "node",
          args: ["server.mjs"],
          description: "mock server",
        },
        null,
        2,
      ),
    );
    const defs = loadMcpServerDefinitions(dir);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("mock");
    expect(defs[0]!.command).toBe("node");
  });
});

describe("mcp_search tool", () => {
  it("loads matching tools into the live registry and proxies execution", async () => {
    const registry = new ToolRegistry();
    const calls: unknown[] = [];
    const fakeRuntime: McpRuntime = {
      async search(_query: string) {
        return [
          {
            server: "mock",
            name: "echo_words",
            registeredName: "mcp__mock__echo_words",
            description: "echo words",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ];
      },
      async callTool(candidate: McpToolCandidate, input: unknown) {
        calls.push({ candidate, input });
        return { content: `echo:${(input as { text?: string }).text ?? ""}`, isError: false };
      },
      status() {
        return [];
      },
    };
    const r = await mcpSearchTool.execute(
      { query: "echo" },
      {
        workdir: dir,
        registry,
        mcp: fakeRuntime,
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Loaded 1 MCP tool");
    const proxy = registry.get("mcp__mock__echo_words");
    expect(proxy).toBeDefined();
    const run = await proxy!.execute(
      { text: "hello" },
      { workdir: dir, registry, mcp: fakeRuntime },
    );
    expect(run.isError).toBe(false);
    expect(run.content).toContain("echo:hello");
    expect(calls).toHaveLength(1);
  });
});

describe("LocalMcpRuntime", () => {
  it("connects to a stdio server, lists tools, and calls them", async () => {
    const script = join(dir, "mock-server.mjs");
    const mcpServerUrl = pathToFileURL(
      join(
        process.cwd(),
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "server",
        "mcp.js",
      ),
    ).href;
    const stdioServerUrl = pathToFileURL(
      join(
        process.cwd(),
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "server",
        "stdio.js",
      ),
    ).href;
    const zodUrl = pathToFileURL(
      join(process.cwd(), "node_modules", "zod", "lib", "index.mjs"),
    ).href;
    writeFileSync(
      script,
      [
        `import { McpServer } from ${JSON.stringify(mcpServerUrl)};`,
        `import { StdioServerTransport } from ${JSON.stringify(stdioServerUrl)};`,
        `import { z } from ${JSON.stringify(zodUrl)};`,
        "const server = new McpServer({ name: 'mock', version: '1.0.0' });",
        "server.registerTool('echo_words', {",
        "  description: 'Echo input text',",
        "  inputSchema: { text: z.string() },",
        "}, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
    );
    const mcpDir = join(dir, ".agent", "mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "mock.json"),
      JSON.stringify({ name: "mock", command: "node", args: [script] }, null, 2),
    );

    const runtime = new LocalMcpRuntime(dir);
    try {
      const hits = await runtime.search("echo");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.registeredName).toBe("mcp__mock__echo_words");

      const result = await runtime.callTool(hits[0]!, { text: "hello world" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("echo:hello world");
    } finally {
      await runtime.close();
    }
  });
});
