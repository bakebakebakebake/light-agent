import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "../profiles.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

let debugEnabled = /^(1|true|yes|on)$/i.test(
  process.env.LIGHT_AGENT_DEBUG ?? process.env.HARNESS_DEBUG ?? "",
);

function logPath(): string {
  return join(storeDir(), "logs", "light-agent.log");
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (level === "debug" && !debugEnabled) return;
  try {
    const file = logPath();
    mkdirSync(join(storeDir(), "logs"), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...(meta ? { meta } : {}),
      }) + "\n",
      "utf8",
    );
  } catch {
    /* logging must never crash the CLI */
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    write("debug", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    write("error", message, meta);
  },
};
