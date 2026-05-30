import type { RiskLevel, Tool } from "../tools/types.js";

/**
 * Permission policy — deny-first risk classification (docs/04).
 *
 * Two dimensions decide whether an action needs confirmation: reversibility
 * and blast radius. We collapse that into the tool's declared riskLevel, then
 * map it to an action: low runs silently, medium runs but is announced, high
 * requires explicit user confirmation before running.
 *
 * Denial tracking ("graceful degradation"): once the user has rejected enough
 * actions, the policy stops trusting medium-risk auto-runs and asks for
 * everything — the agent gets conservative when the user clearly is.
 */

export type PermissionAction =
  | "allow" // run silently
  | "notify" // run, but tell the user what happened
  | "confirm" // ask the user before running
  | "deny"; // refuse outright (e.g. a mutating tool in plan mode)

/**
 * Permission modes (feature #5), mirroring Claude Code:
 * - `default`    — risk-tier behavior: low allow / medium notify / high confirm.
 * - `plan`       — read-only: low (reads) allow, everything mutating is denied.
 * - `acceptEdits`— auto-approve file edits (medium), still confirm high-risk.
 * - `allowAll`   — auto-approve everything (use with care).
 */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "allowAll";

export interface PolicyOptions {
  /**
   * After this many denials, degrade: medium-risk actions also require
   * confirmation. Default 2.
   */
  denialThreshold?: number;
  /** Starting mode (default "default"). */
  mode?: PermissionMode;
}

export class PermissionPolicy {
  private denials = 0;
  private readonly threshold: number;
  private mode: PermissionMode;

  constructor(opts: PolicyOptions = {}) {
    this.threshold = opts.denialThreshold ?? 2;
    this.mode = opts.mode ?? "default";
  }

  /** The active permission mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** Switch mode live (the /mode command calls this — no restart). */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Record that the user rejected an action (feeds denial tracking). */
  recordDenial(): void {
    this.denials += 1;
  }

  /** True once the user has lost enough trust to trigger degradation. */
  get degraded(): boolean {
    return this.denials >= this.threshold;
  }

  /** Map a risk level to an action, accounting for mode then degradation. */
  actionFor(risk: RiskLevel): PermissionAction {
    // Mode overrides the base risk-tier mapping.
    switch (this.mode) {
      case "allowAll":
        return "allow";
      case "plan":
        // Read-only: only low-risk (reads) run; anything mutating is blocked.
        return risk === "low" ? "allow" : "deny";
      case "acceptEdits":
        // Auto-approve edits (low+medium); still confirm high-risk (e.g. bash).
        return risk === "high" ? "confirm" : "allow";
      case "default":
        break;
    }
    switch (risk) {
      case "low":
        return "allow";
      case "medium":
        // Once trust has degraded, even medium-risk asks first.
        return this.degraded ? "confirm" : "notify";
      case "high":
        return "confirm";
    }
  }

  decide(tool: Tool): PermissionAction {
    return this.actionFor(tool.riskLevel);
  }
}
