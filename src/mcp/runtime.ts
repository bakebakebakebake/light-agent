import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  McpCallResult,
  McpRuntime,
  McpSearchOptions,
  McpServerStatus,
  McpToolCandidate,
} from "./types.js";
import { loadMcpServerDefinitions, type McpServerDefinition } from "../ext/mcp.js";

function sanitizeName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "tool";
}

function uniqueRegisteredName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  const next = `${base}_${i}`;
  used.add(next);
  return next;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      parts.push(String(block));
      continue;
    }
    const rec = block as Record<string, unknown>;
    switch (rec.type) {
      case "text":
        if (typeof rec.text === "string") parts.push(rec.text);
        break;
      case "resource":
        if (rec.resource && typeof rec.resource === "object") {
          const resource = rec.resource as Record<string, unknown>;
          if (typeof resource.text === "string") parts.push(resource.text);
          else parts.push(`[resource ${typeof resource.uri === "string" ? resource.uri : "unknown"}]`);
        } else {
          parts.push("[resource]");
        }
        break;
      case "resource_link":
        parts.push(`[resource_link ${typeof rec.uri === "string" ? rec.uri : "unknown"}]`);
        break;
      case "image":
        parts.push(`[image ${typeof rec.mimeType === "string" ? rec.mimeType : "unknown"}]`);
        break;
      default:
        parts.push(JSON.stringify(block));
        break;
    }
  }
  return parts.join("\n");
}

function scoreMatch(query: string, candidate: McpToolCandidate): number {
  if (!query.trim()) return 1;
  const q = query.toLowerCase();
  const hay = `${candidate.server} ${candidate.name} ${candidate.description}`.toLowerCase();
  if (hay.includes(q)) return 100 + Math.max(0, 30 - candidate.name.length);
  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (candidate.name.toLowerCase().includes(token)) score += 8;
    if (candidate.description.toLowerCase().includes(token)) score += 5;
    if (candidate.server.toLowerCase().includes(token)) score += 3;
  }
  return score;
}

class ServerConnection {
  private toolsCache: McpToolCandidate[] | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;

  constructor(private readonly def: McpServerDefinition, private readonly workdir: string) {}

  async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: this.def.command,
      args: this.def.args ?? [],
      cwd: this.def.cwd ? this.def.cwd : this.workdir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => typeof value === "string"),
        ),
        ...(this.def.env ?? {}),
      } as Record<string, string>,
    });
    this.transport = transport;
    this.client = new Client({ name: "light-agent", version: "0.4.0" });
    await this.client.connect(transport);
    this.connected = true;
    return this.client;
  }

  private client!: Client;

  async listTools(): Promise<McpToolCandidate[]> {
    if (this.toolsCache) return this.toolsCache;
    const client = await this.ensureClient();
    const loaded: McpToolCandidate[] = [];
    const usedNames = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools({ cursor });
      for (const tool of result.tools) {
        const registeredName = uniqueRegisteredName(
          `mcp__${sanitizeName(this.def.name)}__${sanitizeName(tool.name)}`,
          usedNames,
        );
        loaded.push({
          server: this.def.name,
          name: tool.name,
          registeredName,
          description: tool.description ?? this.def.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    this.toolsCache = loaded;
    return loaded;
  }

  async callTool(
    candidate: McpToolCandidate,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const client = await this.ensureClient();
    const result = await client.callTool({
      name: candidate.name,
      arguments: input as Record<string, unknown>,
    }, undefined, signal ? { signal } : undefined);
    const content = textFromContent(result.content);
    const details = result.structuredContent
      ? JSON.stringify(result.structuredContent, null, 2)
      : undefined;
    return {
      content: content || "(empty MCP tool response)",
      isError: Boolean((result as { isError?: boolean }).isError),
      ...(details ? { details } : {}),
    };
  }

  async close(): Promise<void> {
    try {
      if (this.client) await this.client.close();
    } catch {
      /* ignore close errors */
    }
    try {
      if (this.transport) await this.transport.close();
    } catch {
      /* ignore close errors */
    }
    this.connected = false;
  }

  status(): Pick<McpServerStatus, "connected" | "loadedTools"> {
    return {
      connected: this.connected,
      loadedTools: this.toolsCache?.length ?? 0,
    };
  }
}

/**
 * Local stdio-backed MCP runtime.
 *
 * Server configs are discovered from `.agent/mcp/*.json` (user + project
 * scopes). Tool discovery is lazy: `search()` opens a server only when needed,
 * and `mcp_search` registers only the matches it needs into the live tool pool.
 */
export class LocalMcpRuntime implements McpRuntime {
  private readonly servers = new Map<string, ServerConnection>();
  private defs = new Map<string, McpServerDefinition>();

  constructor(private readonly cwd: string) {}

  private refreshServers(): void {
    for (const def of loadMcpServerDefinitions(this.cwd)) {
      this.defs.set(def.name, def);
      if (!this.servers.has(def.name)) {
        this.servers.set(def.name, new ServerConnection(def, this.cwd));
      }
    }
  }

  status(): McpServerStatus[] {
    this.refreshServers();
    return [...this.defs.values()]
      .map((def) => {
        const runtime = this.servers.get(def.name);
        const status = runtime?.status() ?? { connected: false, loadedTools: 0 };
        return {
          name: def.name,
          scope: def.scope,
          command: def.command,
          args: def.args ?? [],
          description: def.description,
          configured: true,
          connected: status.connected,
          loadedTools: status.loadedTools,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async search(
    query: string,
    opts: McpSearchOptions = {},
  ): Promise<McpToolCandidate[]> {
    this.refreshServers();
    const matches: Array<{ candidate: McpToolCandidate; score: number }> = [];
    const wantServer = opts.server?.trim().toLowerCase();

    for (const [name, conn] of this.servers) {
      if (wantServer && name.toLowerCase() !== wantServer) continue;
      const tools = await conn.listTools();
      for (const tool of tools) {
        const score = scoreMatch(query, tool);
        if (score > 0) matches.push({ candidate: tool, score });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.candidate.registeredName.localeCompare(b.candidate.registeredName));
    const limit = opts.limit ?? 10;
    return matches.slice(0, limit).map((m) => m.candidate);
  }

  async callTool(
    candidate: McpToolCandidate,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const conn = this.servers.get(candidate.server);
    if (!conn) {
      this.refreshServers();
    }
    const found = this.servers.get(candidate.server);
    if (!found) {
      return {
        isError: true,
        content: `MCP server "${candidate.server}" is not configured.`,
      };
    }
    return found.callTool(candidate, input, signal);
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.close()));
  }
}
