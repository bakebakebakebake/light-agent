/**
 * Per-model context-window sizes (docs/08, feature #7/#11).
 *
 * Used to show "used / total ctx" in the status footer and to decide when to
 * auto-compact (#1). There's no portable cross-provider API for this, so we keep
 * a prefix-matched table with a documented source per row, plus a conservative
 * default. It's a UI/heuristic hint, not a hard limit — and when a model isn't
 * covered (or a provider serves a custom window), the per-profile
 * `contextWindow` override is the escape hatch (see contextWindowFor).
 */

/**
 * A model-id prefix → context window (in tokens). First match wins, so list
 * more specific prefixes before broader ones. Sources noted so the numbers are
 * auditable rather than guessed.
 */
const TABLE: Array<[RegExp, number]> = [
  // Anthropic: Claude 3/3.5/4 are 200k. (1M is a beta opt-in, not default.)
  [/^claude/i, 200_000],
  // OpenAI o-series reasoning models: 200k context.
  [/^o[1345](-|$|\.)/i, 200_000],
  // GPT-4.1 family: 1M context.
  [/^gpt-4\.1/i, 1_000_000],
  // GPT-5 family: 400k context (reasoning tiers).
  [/^gpt-5/i, 400_000],
  // GPT-4o / 4o-mini / gpt-4-turbo: 128k.
  [/^gpt-4o/i, 128_000],
  [/^gpt-4/i, 128_000],
  // Legacy 3.5-turbo: 16k.
  [/^gpt-3\.5/i, 16_385],
  // DeepSeek: V3/chat and R1/reasoner are 64k (older). Split out in case newer
  // ids ship a larger window — keep conservative, override covers the rest.
  [/^deepseek-reasoner/i, 64_000],
  [/^deepseek/i, 64_000],
  // Moonshot / Kimi: up to 128k for the long-context tiers.
  [/^moonshot|^kimi/i, 128_000],
  // Qwen: varies wildly (32k–1M). Conservative default; override per profile.
  [/^qwen/i, 32_768],
  // Zhipu GLM-4: 128k.
  [/^glm/i, 128_000],
  // Google Gemini 1.5/2: 1M (2.x Pro can be 2M, but 1M is the safe floor).
  [/^gemini/i, 1_000_000],
  // Meta Llama 3.x: 128k.
  [/^llama/i, 128_000],
  // Mistral large/medium: 128k.
  [/^mistral|^mixtral/i, 32_768],
];

/** Conservative fallback when the model id matches nothing in the table. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Best-effort context window for a model id.
 *
 * An explicit `override` (from the active profile's `contextWindow`, or
 * HARNESS_CONTEXT_WINDOW) always wins — that's how a user corrects a wrong or
 * missing table entry (#11). Otherwise the table is consulted, then DEFAULT.
 */
export function contextWindowFor(model: string, override?: number): number {
  if (override && override > 0) return override;
  for (const [re, size] of TABLE) {
    if (re.test(model)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
