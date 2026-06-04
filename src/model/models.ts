import type { CompatibilitySnapshot } from "./compat.js";
import { catalogCandidates } from "./compat.js";

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
  /** Final URL that succeeded, useful when we auto-recover to /v1. */
  resolvedURL?: string;
}

/** How a provider's model list is fetched. Injectable so onboarding is testable. */
export type FetchModels = (opts: {
  provider: "anthropic" | "openai";
  apiKey: string;
  baseURL?: string;
  compat?: CompatibilitySnapshot;
}) => Promise<ModelListResult>;

const TIMEOUT_MS = 8000;

/** Strip trailing slashes so we can append a path cleanly. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export const fetchModels: FetchModels = async (opts) => {
  try {
    const protocol = opts.compat?.preferredProtocol ?? opts.provider;
    const directURL = opts.compat?.catalogURL;
    const urls =
      directURL
        ? [{ url: directURL, baseURL: opts.compat?.resolvedBaseURL }]
        : catalogCandidates(protocol, opts.compat?.resolvedBaseURL ?? opts.baseURL).map((entry) => ({
            url: entry.catalogURL,
            baseURL: entry.resolvedBaseURL,
          }));
    const headers: Record<string, string> =
      protocol === "openai"
        ? { authorization: `Bearer ${opts.apiKey}` }
        : {
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          };
    let lastError: string | undefined;
    let lastResolvedURL: string | undefined;
    for (const entry of urls) {
      const { resp, resolvedURL, raw, parseError } = await fetchModelsWithFallback(
        entry.url,
        headers,
        protocol === "openai" ? entry.baseURL : undefined,
      );
      lastResolvedURL = resolvedURL;
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      if (parseError) {
        lastError = parseError;
        continue;
      }
      const json = raw as { data?: Array<{ id?: unknown }> };
      const models = (json.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter((id): id is string => id.length > 0);
      return { models, ...(resolvedURL ? { resolvedURL } : {}) };
    }
    return {
      models: [],
      ...(lastError ? { error: lastError } : {}),
      ...(lastResolvedURL ? { resolvedURL: lastResolvedURL } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], error: message };
  }
};

async function fetchModelsWithFallback(
  url: string,
  headers: Record<string, string>,
  openAIBaseURL?: string,
): Promise<{
  resp: Response;
  resolvedURL: string;
  raw?: { data?: Array<{ id?: unknown }> };
  parseError?: string;
}> {
  let currentURL = url;
  let resp = await fetch(currentURL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let rawText = await responseText(resp);

  if (shouldRetryOpenAIModelsWithV1(openAIBaseURL, resp, rawText)) {
    currentURL = withV1ModelsURL(openAIBaseURL!);
    resp = await fetch(currentURL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    rawText = await responseText(resp);
  }

  try {
    return {
      resp,
      resolvedURL: currentURL,
      raw: JSON.parse(rawText) as { data?: Array<{ id?: unknown }> },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      resp,
      resolvedURL: currentURL,
      parseError: `Invalid model-list JSON: ${rawText.trim().slice(0, 120) || message}`,
    };
  }
}

function shouldRetryOpenAIModelsWithV1(
  baseURL: string | undefined,
  resp: Response,
  body: string,
): boolean {
  if (!baseURL || baseURLHasExplicitPath(baseURL)) return false;
  if (resp.status === 404 || resp.status === 405) return true;
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) return true;
  return /<!doctype html>|<html[\s>]/i.test(body.trim());
}

function withV1ModelsURL(baseURL: string): string {
  return `${trimSlashes(baseURL)}/v1/models`;
}

function baseURLHasExplicitPath(baseURL: string): boolean {
  try {
    const parsed = new URL(baseURL);
    return parsed.pathname !== "/" && parsed.pathname !== "";
  } catch {
    return true;
  }
}

async function responseText(resp: Response): Promise<string> {
  if (typeof resp.text === "function") return await resp.text();
  if (typeof resp.json === "function") {
    const json = await resp.json();
    return JSON.stringify(json);
  }
  return "";
}
