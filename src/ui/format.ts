/**
 * Small formatting helpers shared by the live renderer (render.ts) and the
 * transcript re-renderer (transcript.ts) so tool calls/results look identical
 * whether they're streaming live or being reprinted after a rewind/resume.
 */

/** Compact a tool's input object into a one-line `k: v, k: v` summary. */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    let val: string;
    if (typeof v === "string") {
      val = v.length > 40 ? JSON.stringify(v.slice(0, 40) + "…") : JSON.stringify(v);
    } else if (Array.isArray(v)) {
      val = `[${v.length}]`;
    } else {
      val = JSON.stringify(v);
    }
    parts.push(`${k}: ${val}`);
  }
  return parts.join(", ");
}

/** First line of a string, truncated to `max` visible characters. */
export function firstLine(s: string, max: number): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}
