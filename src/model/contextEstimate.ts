import type { Message, ToolSpec } from "./types.js";

export interface ContextEstimateInput {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

/**
 * Estimate the live prompt footprint for the next turn.
 *
 * Providers report usage for the last call only, and gateways may vary in how
 * they count. For UI/status we want a stable local estimate of the WHOLE prompt
 * we are about to send: system prompt + current history + advertised tools.
 *
 * We approximate tokens from the UTF-8 byte size of a compact JSON payload.
 * This intentionally favors a steady whole-context magnitude over tokenizer-
 * exact parity with any one provider.
 */
export function estimateContextTokens(input: ContextEstimateInput): number {
  const payload = JSON.stringify(
    {
      system: input.system,
      messages: input.messages,
      tools: input.tools,
    },
    jsonReplacer,
  );
  return estimateStringTokens(payload);
}

function estimateStringTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
