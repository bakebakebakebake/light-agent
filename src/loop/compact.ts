import type {
  Message,
  ModelProvider,
  ModelRequest,
} from "../model/types.js";

/**
 * Conversation compaction (#1, docs/03).
 *
 * As history grows it crowds the context window and slows/expensives every
 * request. Compaction replaces the OLDER prefix of the conversation with a
 * single model-written summary message, while keeping the most recent exchanges
 * verbatim so the immediate working context is untouched.
 *
 * Invariant we must never break: a `tool_use` block (in an assistant message)
 * must be followed by its `tool_result` (in the next user message), or the
 * provider rejects the next request. So we only ever cut at a "user turn
 * boundary" — a user message that carries real text (the start of a fresh
 * exchange) — never between an assistant tool call and its result.
 */

export interface CompactOptions {
  /** How many recent user-turn exchanges to keep verbatim. Default 4. */
  keepRecent?: number;
  /** Abort signal forwarded to the summarization call. */
  signal?: AbortSignal;
}

export interface CompactResult {
  /** The new, shorter history (summary message + kept tail). */
  messages: Message[];
  /** The summary text the model produced (for display). */
  summary: string;
  /** How many messages were collapsed into the summary. */
  collapsed: number;
}

/** Indices of user messages that carry text — the only safe split points. */
function userTurnBoundaries(messages: Message[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const hasText = m.content.some(
      (b) => b.type === "text" && b.text.trim() !== "",
    );
    if (hasText) out.push(i);
  }
  return out;
}

/** Flatten a message's blocks into plain text for the summarization prompt. */
function messageToText(m: Message): string {
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_use")
      parts.push(`[called ${b.name}(${JSON.stringify(b.input)})]`);
    else if (b.type === "tool_result")
      parts.push(`[tool result${b.isError ? " ERROR" : ""}: ${b.content.slice(0, 500)}]`);
  }
  return parts.join("\n");
}

const SUMMARY_INSTRUCTION =
  "You are compacting a coding-assistant conversation to save context. " +
  "Summarize the conversation below into a dense brief that a fresh assistant " +
  "could read to continue seamlessly. Preserve: the user's goals and explicit " +
  "instructions, key decisions and their rationale, files/functions touched, " +
  "current state, and any unresolved TODOs. Drop pleasantries and redundant " +
  "detail. Use terse bullet points. Do not invent facts.";

/** Drain a provider stream into the concatenated assistant text it produced. */
async function summarizeViaModel(
  provider: ModelProvider,
  conversationText: string,
  signal?: AbortSignal,
): Promise<string> {
  const req: ModelRequest = {
    system: SUMMARY_INSTRUCTION,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Conversation to summarize:\n\n" + conversationText },
        ],
      },
    ],
    tools: [],
    ...(signal ? { signal } : {}),
  };
  let text = "";
  for await (const ev of provider.stream(req)) {
    if (ev.type === "text_delta") text += ev.text;
    else if (ev.type === "error") throw new Error(ev.error.message);
  }
  return text.trim();
}

/**
 * Compact `messages`: summarize everything before the last `keepRecent` user
 * turns into one assistant note, then keep the recent tail verbatim. Returns
 * the original messages unchanged (collapsed: 0) when there isn't enough
 * history to be worth compacting.
 */
export async function compactHistory(
  provider: ModelProvider,
  messages: Message[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const keepRecent = opts.keepRecent ?? 4;
  const boundaries = userTurnBoundaries(messages);

  // Need more turns than we intend to keep, or there's nothing to compact.
  if (boundaries.length <= keepRecent) {
    return { messages, summary: "", collapsed: 0 };
  }

  // Cut at the boundary that begins the kept tail. Everything before it (a whole
  // number of complete exchanges) is summarized; the tail stays verbatim.
  const cut = boundaries[boundaries.length - keepRecent]!;
  const olderPrefix = messages.slice(0, cut);
  const tail = messages.slice(cut);
  if (olderPrefix.length === 0) {
    return { messages, summary: "", collapsed: 0 };
  }

  const conversationText = olderPrefix.map(messageToText).join("\n\n");
  const summary = await summarizeViaModel(provider, conversationText, opts.signal);
  if (!summary) {
    // Summarization produced nothing usable — leave history intact rather than
    // destroying context.
    return { messages, summary: "", collapsed: 0 };
  }

  // One assistant message stands in for the collapsed prefix. Assistant role
  // keeps the alternation valid: the kept tail begins with a user text turn.
  const summaryMessage: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "[Summary of earlier conversation]\n" + summary,
      },
    ],
  };

  return {
    messages: [summaryMessage, ...tail],
    summary,
    collapsed: olderPrefix.length,
  };
}
