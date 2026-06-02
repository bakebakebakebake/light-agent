import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storeDir } from "./profiles.js";
import type { Message } from "./model/types.js";
import type { TodoItem } from "./todos.js";

/**
 * Session persistence (docs/08, feature #6).
 *
 * Each conversation is saved as JSON under ~/.light-agent/sessions/<id>.json
 * so it can be resumed later, renamed, and listed with timestamps — mirroring
 * Claude Code's resume/rename. Saved next to the profile store (NOT in any
 * repo), and locked 0600 since transcripts can contain sensitive content.
 *
 * The REPL auto-saves after each turn; /resume loads a session's messages back
 * into history; /rename changes its title.
 */

/** A persisted conversation. */
export interface Session {
  id: string;
  title: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  /** Provider/model context at save time, for display in /resume. */
  provider?: string;
  model?: string;
  /** Session-scoped todo list, if any. */
  todos?: TodoItem[];
  messages: Message[];
}

/** Lightweight listing entry (no messages) for /resume. */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  messageCount: number;
}

/** Directory holding session files (under the same root as the profile store). */
export function sessionsDir(): string {
  return join(storeDir(), "sessions");
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/** Mint a new, empty session with a generated id and timestamps. */
export function newSession(opts?: {
  title?: string;
  provider?: string;
  model?: string;
}): Session {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: opts?.title ?? "Untitled",
    createdAt: now,
    updatedAt: now,
    ...(opts?.provider ? { provider: opts.provider } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    todos: [],
    messages: [],
  };
}

/**
 * Persist a session, refreshing updatedAt. Creates the sessions dir if needed
 * and locks the file 0600 (transcripts may contain sensitive content). Returns
 * the path written.
 */
export function saveSession(session: Session): string {
  mkdirSync(sessionsDir(), { recursive: true });
  session.updatedAt = new Date().toISOString();
  const path = sessionPath(session.id);
  writeFileSync(path, JSON.stringify(session, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore (e.g. Windows) */
  }
  return path;
}

/** Load a session by id, or null if it's missing/corrupt. */
export function loadSession(id: string): Session | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.id || !Array.isArray(parsed.messages)) return null;
    return {
      id: parsed.id,
      title: parsed.title ?? "Untitled",
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(Array.isArray(parsed.todos) ? { todos: parsed.todos as TodoItem[] } : {}),
      messages: parsed.messages as Message[],
    };
  } catch {
    return null;
  }
}

/**
 * List saved sessions, newest-updated first. Skips unreadable files so a single
 * corrupt session never breaks /resume.
 */
export function listSessions(): SessionSummary[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const summaries: SessionSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const session = loadSession(file.slice(0, -5));
    if (!session) continue;
    summaries.push({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.provider ? { provider: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      messageCount: session.messages.length,
    });
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** Rename a session (persists immediately). Returns false if it doesn't exist. */
export function renameSession(id: string, title: string): boolean {
  const session = loadSession(id);
  if (!session) return false;
  session.title = title;
  saveSession(session);
  return true;
}

/**
 * Derive a short title from the first user message — the leading text, trimmed
 * to a single line and capped. Falls back to "Untitled" when there's no text.
 */
export function deriveTitle(messages: Message[], max = 50): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const block of m.content) {
      if (block.type === "text" && block.text.trim()) {
        const line = block.text.trim().split("\n", 1)[0] ?? "";
        return line.length > max ? line.slice(0, max) + "…" : line;
      }
    }
  }
  return "Untitled";
}
