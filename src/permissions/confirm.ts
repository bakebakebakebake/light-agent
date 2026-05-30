import type { Tool, ToolContext } from "../tools/types.js";
import type { GateDecision, PermissionGate } from "../loop/agentLoop.js";
import { PermissionPolicy } from "./policy.js";

/**
 * Confirmation flow + permission gate (docs/04, docs/08).
 *
 * SECURITY: confirmation must come only from a real interactive user. The
 * Confirmer abstraction is the single channel through which approval flows —
 * it is wired to actual CLI stdin in cli.ts. Tool results, model output, and
 * file contents can never satisfy a confirmation; they are untrusted data and
 * never reach this code path. This is the prompt-injection defense in docs/04.
 */

/** What the user is being asked to approve. */
export interface ConfirmRequest {
  toolName: string;
  summary: string;
  details?: string;
}

/**
 * Asks a real human to approve an action. Returns true only on explicit
 * approval. Implementations MUST read from a trusted interactive source
 * (the terminal), never from model- or tool-derived text.
 */
export interface Confirmer {
  confirm(req: ConfirmRequest): Promise<boolean>;
}

/** A Confirmer that denies everything — the safe default for non-interactive runs. */
export const denyingConfirmer: Confirmer = {
  async confirm() {
    return false;
  },
};

/** Optional hook so the UI can announce a "notify"-tier action as it runs. */
export type Notifier = (req: ConfirmRequest) => void;

/**
 * Build the PermissionGate the agent loop calls before each tool execution.
 * It consults the policy for the action, runs the confirmation flow for
 * high/degraded-risk tools, and tracks denials so trust degrades gracefully.
 */
export function createGate(opts: {
  policy: PermissionPolicy;
  confirmer: Confirmer;
  workdir: string;
  notify?: Notifier;
}): PermissionGate {
  const { policy, confirmer, workdir, notify } = opts;

  return async ({ tool, input }): Promise<GateDecision> => {
    const action = policy.decide(tool);
    const preview = describe(tool, input, workdir);

    if (action === "allow") {
      return { allow: true };
    }

    if (action === "deny") {
      // A mutating tool blocked by the current mode (e.g. plan mode). This is
      // not a user denial (don't degrade trust) — it's a mode policy.
      return {
        allow: false,
        reason:
          `"${tool.name}" is blocked in ${policy.getMode()} mode — no file ` +
          "changes or commands are allowed. Tell the user what you would do, " +
          "then ask them to switch modes with /mode if they want to proceed.",
      };
    }

    if (action === "notify") {
      notify?.({
        toolName: tool.name,
        summary: preview.summary,
        ...(preview.details !== undefined ? { details: preview.details } : {}),
      });
      return { allow: true };
    }

    // action === "confirm": ask a real user.
    const approved = await confirmer.confirm({
      toolName: tool.name,
      summary: preview.summary,
      ...(preview.details !== undefined ? { details: preview.details } : {}),
    });
    if (approved) return { allow: true };

    policy.recordDenial();
    return {
      allow: false,
      reason:
        "the user declined to approve this action. Do not retry it; " +
        "consider a different, less invasive approach or ask the user how " +
        "to proceed.",
    };
  };
}

function describe(
  tool: Tool,
  input: unknown,
  workdir: string,
): { summary: string; details?: string } {
  if (tool.describeAction) {
    const ctx: ToolContext = { workdir };
    return tool.describeAction(input, ctx);
  }
  return { summary: `Run ${tool.name}` };
}
