/**
 * Model discovery (docs/06, feature #9).
 *
 * Both Anthropic and OpenAI-compatible services expose a GET models endpoint
 * that returns `{ data: [{ id }] }`. When the user has entered a working
 * key + base URL we fetch that list so they can pick from real model ids
 * instead of typing one by hand — falling back to manual entry only when the
 * fetch fails or returns nothing.
 *
 * This is a plain `fetch` (no SDK) with a short timeout so a slow/unreachable
 * endpoint never hangs onboarding. Network errors are swallowed into a result
 * with an `error` string; the caller treats any failure as "fall back to
 * manual entry". The API key is sent only to the user-provided endpoint and is
 * never logged.
 */

export interface ModelListResult {
  /** Model ids the endpoint advertised (may be empty). */
  models: string[];
  /** Present when the lookup failed; the caller falls back to manual entry. */
  error?: string;
}

/** How a provider's model list is fetched. Injectable so onboarding is testable. */
export type FetchModels = (opts: {
  provider: "anthropic" | "openai";
  apiKey: string;
  baseURL?: string;
}) => Promise<ModelListResult>;

const TIMEOUT_MS = 8000;

/** Strip trailing slashes so we can append a path cleanly. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export const fetchModels: FetchModels = async (opts) => {
  try {
    const { url, headers } =
      opts.provider === "openai"
        ? openAIEndpoint(opts.apiKey, opts.baseURL)
        : anthropicEndpoint(opts.apiKey, opts.baseURL);

    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { models: [], error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const models = (json.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : ""))
      .filter((id): id is string => id.length > 0);
    return { models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], error: message };
  }
};

function openAIEndpoint(
  apiKey: string,
  baseURL?: string,
): { url: string; headers: Record<string, string> } {
  const base = trimSlashes(baseURL ?? "https://api.openai.com/v1");
  return {
    url: `${base}/models`,
    headers: { authorization: `Bearer ${apiKey}` },
  };
}

function anthropicEndpoint(
  apiKey: string,
  baseURL?: string,
): { url: string; headers: Record<string, string> } {
  // baseURL (if any) is the SDK-style base WITHOUT /v1; mirror the SDK by
  // appending the versioned path ourselves.
  const base = trimSlashes(baseURL ?? "https://api.anthropic.com");
  return {
    url: `${base}/v1/models`,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  };
}
