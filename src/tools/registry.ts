import type { Tool } from "./types.js";
import { toToolSpec } from "./types.js";
import type { ToolSpec } from "../model/types.js";
import { readTool } from "./read.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { createBashTool } from "./bash.js";

/**
 * Tool registry — assembles the active tool pool (docs/02).
 *
 * For the MVP this is a static set, but the shape mirrors the "enumerate →
 * filter → dedup" assembly described in the docs: tools are registered by
 * name, deduped, and projected to the ToolSpec the provider advertises.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Project the pool to the specs the model sees. */
  specs(): ToolSpec[] {
    return this.list().map(toToolSpec);
  }
}

/**
 * Build the default tool pool. Read-only tools (read, ls, grep) are low-risk
 * and concurrent; write/edit are medium-risk exclusive; bash is high-risk.
 */
export function defaultRegistry(opts: { bashTimeoutMs: number }): ToolRegistry {
  return new ToolRegistry([
    readTool,
    lsTool,
    grepTool,
    editTool,
    writeTool,
    createBashTool({ defaultTimeoutMs: opts.bashTimeoutMs }),
  ]);
}
