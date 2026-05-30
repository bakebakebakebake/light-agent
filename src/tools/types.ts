import type { ToolSpec } from "../model/types.js";

/**
 * Tool layer types — see docs/02-tool-design.md.
 *
 * A Tool is a single, orthogonal capability the agent can invoke. Each tool
 * declares its own risk level and concurrency class so the loop and the
 * permission layer can treat it correctly without special-casing.
 */

/** Risk tier, used by the permission layer (docs/04). */
export type RiskLevel = "low" | "medium" | "high";

/**
 * Whether a tool may run alongside others. Read-only tools are concurrent;
 * anything with side effects is exclusive and must run serially (docs/02).
 */
export type Concurrency = "concurrent" | "exclusive";

/** Ambient context handed to every tool execution. */
export interface ToolContext {
  /** The directory the agent is confined to. Tools must not escape it. */
  workdir: string;
  /** Abort signal so long-running tools can be interrupted (docs/08). */
  signal?: AbortSignal;
  /**
   * When true, filesystem tools may operate outside `workdir` (#9). Set only in
   * `allowAll` mode, where the user has explicitly traded the workdir sandbox
   * for full control. The default (undefined/false) keeps confinement on — the
   * safe default for every other permission mode.
   */
  allowOutsideWorkdir?: boolean;
}

/** The outcome of running a tool. */
export interface ToolResult {
  /** Text fed back to the model as the tool_result content. */
  content: string;
  /**
   * True if the tool failed. The content should still be information-rich so
   * the model can self-correct (docs/02) — an error is a feedback channel,
   * not just a failure signal.
   */
  isError: boolean;
  /**
   * Optional human-facing detail for the terminal only (#2) — e.g. a unified
   * diff after a successful edit/write. NOT sent to the model (that's `content`);
   * the renderer prints it beneath the result line.
   */
  details?: string;
}

/**
 * A human-readable preview of what a tool is about to do, shown in the
 * confirmation flow before a risky action runs (docs/04, docs/08).
 */
export interface ActionPreview {
  /** One-line description, e.g. "Edit src/app.ts" or "Run: npm test". */
  summary: string;
  /** Optional detail block, e.g. a unified diff or the full argv. */
  details?: string;
}

/**
 * A single capability. The JSON Schema in `inputSchema` is what the model
 * sees; the tool is responsible for validating the raw input it receives
 * (the model can emit malformed arguments).
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema advertised to the model. */
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  concurrency: Concurrency;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Optional: describe the pending action for the confirmation prompt. Lets
   * each tool own its own preview (e.g. Edit renders a diff) instead of the
   * permission layer special-casing tools.
   */
  describeAction?(input: unknown, ctx: ToolContext): ActionPreview;
}

/** Convenience: project a Tool down to the ToolSpec the provider needs. */
export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
