import { modelSupportsVision } from "../util/images.js";
import { AnthropicProvider } from "./anthropic.js";
import { isReasoningModel, OpenAIProvider } from "./openai.js";
import type { ThinkingDepth } from "./types.js";

export type CompatProtocol = "anthropic" | "openai";

export type CompatFailureKind =
  | "invalid_key"
  | "insufficient_permission"
  | "unauthorized_client"
  | "provider_mismatch"
  | "model_not_found"
  | "catalog_unsupported"
  | "stream_unsupported"
  | "empty_stream"
  | "html_instead_of_api"
  | "unsupported_parameter"
  | "network_timeout"
  | "upstream_server_error"
  | "path_mismatch"
  | "unknown";

export interface CompatibilitySnapshot {
  preferredProtocol: CompatProtocol;
  resolvedBaseURL?: string;
  catalogURL?: string;
  chatURL?: string;
  supportsCatalog?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  lastVerifiedAt?: string;
  lastVerifiedModel?: string;
}

export interface ProtocolProbeResult extends CompatibilitySnapshot {
  protocol: CompatProtocol;
  corrected: boolean;
  catalogOk: boolean;
  catalogCount: number;
  catalogError?: string;
  catalogFailureKind?: CompatFailureKind;
  streamOk: boolean;
  streamError?: string;
  failureKind?: CompatFailureKind;
}

export interface CompatibilityReport {
  originalProtocol: CompatProtocol;
  originalBaseURL?: string;
  selected?: CompatibilitySnapshot;
  selectedProtocol?: CompatProtocol;
  corrected: boolean;
  probes: ProtocolProbeResult[];
  failureKind?: CompatFailureKind;
  failureMessage?: string;
}

interface CandidateEndpoint {
  protocol: CompatProtocol;
  resolvedBaseURL?: string;
  chatURL: string;
  catalogURL: string;
}

const STREAM_TEST_TEXT = "Reply with exactly OK";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const TIMEOUT_MS = 12_000;

export function classifyCompatFailure(
  message: string,
  status?: number,
): CompatFailureKind {
  const text = message.toLowerCase();
  if (/unauthorized client|unauthorized_client/.test(text)) {
    return "unauthorized_client";
  }
  if (/model_not_found|no available channel|无可用渠道|unknown model|does not exist/.test(text)) {
    return "model_not_found";
  }
  if (/unsupported parameter|unknown parameter|extra inputs|reasoning_effort|thinking/.test(text)) {
    return "unsupported_parameter";
  }
  if (/request ended without sending any chunks|empty streaming body|empty response body|no chunks/.test(text)) {
    return "empty_stream";
  }
  if (/text\/html|website page|<!doctype html>|<html[\s>]/.test(text)) {
    return "html_instead_of_api";
  }
  if (/timed out|timeout|fetch failed|econn|socket hang up|network/.test(text)) {
    return "network_timeout";
  }
  if (/path|404|405/.test(text) && /messages|chat\/completions|models/.test(text)) {
    return "path_mismatch";
  }
  if (/provider|anthropic|openai/.test(text) && /expected|compatible/.test(text)) {
    return "provider_mismatch";
  }
  if (/401|invalid api key|bad api key|invalid x-api-key|authentication|unauthenticated/.test(text)) {
    return "invalid_key";
  }
  if (/403|forbidden|insufficient|quota|billing|permission/.test(text)) {
    return "insufficient_permission";
  }
  if (status !== undefined && status >= 500) return "upstream_server_error";
  if (/stream/.test(text) && /unsupported/.test(text)) return "stream_unsupported";
  return "unknown";
}

export function isCompatibilityFailureKind(kind: CompatFailureKind): boolean {
  return [
    "provider_mismatch",
    "empty_stream",
    "html_instead_of_api",
    "unsupported_parameter",
    "catalog_unsupported",
    "path_mismatch",
    "stream_unsupported",
  ].includes(kind);
}

export function supportsReasoningHeuristic(
  protocol: CompatProtocol,
  model: string,
): boolean {
  const value = model.toLowerCase();
  if (protocol === "anthropic") {
    return /claude|sonnet|haiku|opus/.test(value);
  }
  return isReasoningModel(model) || /(^|\/)deepseek-v\d/i.test(value);
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function stripTrailingV1(url: string): string {
  return trimSlashes(url).replace(/\/v1$/i, "");
}

function openAICandidates(baseURL?: string): CandidateEndpoint[] {
  const raw = trimSlashes(baseURL ?? DEFAULT_OPENAI_BASE);
  const bases = new Set<string>();
  if (!baseURL) {
    bases.add(raw);
  } else if (/\/v1$/i.test(raw)) {
    bases.add(raw);
  } else {
    bases.add(raw);
    bases.add(`${raw}/v1`);
  }
  return [...bases].map((base) => ({
    protocol: "openai",
    resolvedBaseURL: base,
    chatURL: `${base}/chat/completions`,
    catalogURL: `${base}/models`,
  }));
}

function anthropicCandidates(baseURL?: string): CandidateEndpoint[] {
  const raw = trimSlashes(baseURL ?? DEFAULT_ANTHROPIC_BASE);
  const out: CandidateEndpoint[] = [];
  const seen = new Set<string>();
  const push = (candidate: CandidateEndpoint) => {
    if (seen.has(candidate.chatURL)) return;
    seen.add(candidate.chatURL);
    out.push(candidate);
  };

  const root = stripTrailingV1(raw);
  push({
    protocol: "anthropic",
    resolvedBaseURL: root,
    chatURL: `${root}/v1/messages`,
    catalogURL: `${root}/v1/models`,
  });
  if (/\/v1$/i.test(raw)) {
    push({
      protocol: "anthropic",
      resolvedBaseURL: root,
      chatURL: `${raw}/messages`,
      catalogURL: `${raw}/models`,
    });
  } else if (baseURL) {
    push({
      protocol: "anthropic",
      resolvedBaseURL: raw,
      chatURL: `${raw}/messages`,
      catalogURL: `${raw}/models`,
    });
  }
  return out;
}

export function catalogCandidates(
  protocol: CompatProtocol,
  baseURL?: string,
): CandidateEndpoint[] {
  return protocol === "anthropic"
    ? anthropicCandidates(baseURL)
    : openAICandidates(baseURL);
}

async function responseText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

async function fetchCatalogURL(
  protocol: CompatProtocol,
  url: string,
  apiKey: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { authorization: `Bearer ${apiKey}` };

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await responseText(resp);
    if (!resp.ok) {
      return { ok: false, count: 0, error: `HTTP ${resp.status}${raw ? ` ${raw.trim().slice(0, 160)}` : ""}` };
    }
    try {
      const json = JSON.parse(raw) as { data?: Array<{ id?: unknown }> };
      const count = (json.data ?? []).filter((item) => typeof item.id === "string").length;
      return { ok: true, count };
    } catch {
      return {
        ok: false,
        count: 0,
        error: `Invalid model-list JSON: ${raw.trim().slice(0, 160) || "(empty body)"}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeStreamURL(
  candidate: CandidateEndpoint,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; error?: string; kind?: CompatFailureKind }> {
  const provider =
    candidate.protocol === "anthropic"
      ? new AnthropicProvider({
          apiKey,
          model,
          baseURL: candidate.resolvedBaseURL,
          chatURL: candidate.chatURL,
        })
      : new OpenAIProvider({
          apiKey,
          model,
          baseURL: candidate.resolvedBaseURL,
          chatURL: candidate.chatURL,
        });

  let output = "";
  let error: string | undefined;
  let kind: CompatFailureKind | undefined;
  try {
    for await (const event of provider.stream({
      system: "You are a connectivity smoke test. Reply with exactly OK.",
      messages: [{ role: "user", content: [{ type: "text", text: STREAM_TEST_TEXT }] }],
      tools: [],
      signal: AbortSignal.timeout(20_000),
    })) {
      if (event.type === "text_delta") output += event.text;
      if (event.type === "error") {
        error = event.error.message;
        kind = event.error.kind ?? classifyCompatFailure(event.error.message, event.error.status);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    kind = classifyCompatFailure(error);
  }
  if (!error && output.trim()) return { ok: true };
  return {
    ok: false,
    error: error ?? "request ended without a usable response",
    kind: kind ?? classifyCompatFailure(error ?? ""),
  };
}

function protocolOrder(
  preferred: CompatProtocol,
): CompatProtocol[] {
  return preferred === "anthropic" ? ["anthropic", "openai"] : ["openai", "anthropic"];
}

export async function probeProtocolCompatibility(opts: {
  protocol: CompatProtocol;
  baseURL?: string;
  apiKey: string;
  model: string;
}): Promise<ProtocolProbeResult> {
  const candidates = catalogCandidates(opts.protocol, opts.baseURL);
  let best: ProtocolProbeResult | null = null;
  let bestStream: ProtocolProbeResult | null = null;
  let bestCatalog: ProtocolProbeResult | null = null;

  for (const candidate of candidates) {
    const catalog = await fetchCatalogURL(
      opts.protocol,
      candidate.catalogURL,
      opts.apiKey,
    );
    const stream = await probeStreamURL(candidate, opts.apiKey, opts.model);
    const result: ProtocolProbeResult = {
      protocol: opts.protocol,
      preferredProtocol: opts.protocol,
      resolvedBaseURL: candidate.resolvedBaseURL,
      chatURL: candidate.chatURL,
      catalogURL: candidate.catalogURL,
      supportsCatalog: catalog.ok,
      supportsStreaming: stream.ok,
      supportsTools: stream.ok,
      supportsVision: modelSupportsVision(opts.protocol, opts.model),
      supportsReasoning: supportsReasoningHeuristic(opts.protocol, opts.model),
      lastVerifiedAt: new Date().toISOString(),
      lastVerifiedModel: opts.model,
      corrected: trimSlashes(opts.baseURL ?? "") !== trimSlashes(candidate.resolvedBaseURL ?? ""),
      catalogOk: catalog.ok,
      catalogCount: catalog.count,
      ...(catalog.ok ? {} : { catalogError: catalog.error ?? "catalog probe failed" }),
      ...(catalog.ok
        ? {}
        : {
            catalogFailureKind: classifyCompatFailure(
              catalog.error ?? "catalog probe failed",
            ),
          }),
      streamOk: stream.ok,
      ...(stream.ok ? {} : { streamError: stream.error ?? "stream probe failed" }),
      ...(stream.ok ? {} : { failureKind: stream.kind ?? "unknown" }),
    };
    if (result.catalogOk && !bestCatalog) bestCatalog = result;
    if (result.streamOk && !bestStream) bestStream = result;
    if (result.streamOk && result.catalogOk) {
      if (bestStream && bestStream.chatURL !== result.chatURL) {
        return {
          ...bestStream,
          catalogOk: true,
          catalogCount: result.catalogCount,
          catalogURL: result.catalogURL,
          catalogError: undefined,
          catalogFailureKind: undefined,
          supportsCatalog: true,
        };
      }
      return result;
    }
    if (!best) best = result;
    else if (!best.catalogOk && result.catalogOk) best = result;
  }

  if (bestStream) {
    if (!bestStream.catalogOk && bestCatalog) {
      return {
        ...bestStream,
        catalogOk: true,
        catalogCount: bestCatalog.catalogCount,
        catalogURL: bestCatalog.catalogURL,
        catalogError: undefined,
        catalogFailureKind: undefined,
        supportsCatalog: true,
      };
    }
    return {
      ...bestStream,
      ...(bestStream.catalogFailureKind
        ? { catalogFailureKind: bestStream.catalogFailureKind }
        : { catalogFailureKind: "catalog_unsupported" as const }),
    };
  }

  return (
    best ?? {
      protocol: opts.protocol,
      preferredProtocol: opts.protocol,
      corrected: false,
      catalogOk: false,
      catalogCount: 0,
      catalogError: "No candidate endpoints to probe.",
      catalogFailureKind: "catalog_unsupported",
      streamOk: false,
      streamError: "No candidate endpoints to probe.",
      failureKind: "unknown",
      supportsCatalog: false,
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: modelSupportsVision(opts.protocol, opts.model),
      supportsReasoning: supportsReasoningHeuristic(opts.protocol, opts.model),
      lastVerifiedAt: new Date().toISOString(),
      lastVerifiedModel: opts.model,
    }
  );
}

export async function probeCompatibility(opts: {
  preferredProtocol: CompatProtocol;
  baseURL?: string;
  apiKey: string;
  model: string;
}): Promise<CompatibilityReport> {
  const probes: ProtocolProbeResult[] = [];
  for (const protocol of protocolOrder(opts.preferredProtocol)) {
    probes.push(
      await probeProtocolCompatibility({
        protocol,
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        model: opts.model,
      }),
    );
  }

  const selectedProbe = probes.find((probe) => probe.streamOk);
  const corrected =
    !!selectedProbe &&
    (selectedProbe.protocol !== opts.preferredProtocol || selectedProbe.corrected);

  if (selectedProbe) {
    return {
      originalProtocol: opts.preferredProtocol,
      ...(opts.baseURL ? { originalBaseURL: opts.baseURL } : {}),
      selectedProtocol: selectedProbe.protocol,
      selected: {
        preferredProtocol: selectedProbe.protocol,
        resolvedBaseURL: selectedProbe.resolvedBaseURL,
        catalogURL: selectedProbe.catalogURL,
        chatURL: selectedProbe.chatURL,
        supportsCatalog: selectedProbe.catalogOk,
        supportsStreaming: selectedProbe.streamOk,
        supportsTools: selectedProbe.supportsTools,
        supportsVision: selectedProbe.supportsVision,
        supportsReasoning: selectedProbe.supportsReasoning,
        lastVerifiedAt: selectedProbe.lastVerifiedAt,
        lastVerifiedModel: selectedProbe.lastVerifiedModel,
      },
      corrected,
      probes,
    };
  }

  const failure = probes[0] ?? probes[1];
  return {
    originalProtocol: opts.preferredProtocol,
    ...(opts.baseURL ? { originalBaseURL: opts.baseURL } : {}),
    corrected: false,
    probes,
    failureKind: failure?.failureKind ?? "unknown",
    failureMessage:
      failure?.streamError ??
      failure?.catalogError ??
      "No compatible protocol probe succeeded.",
  };
}

export function summarizeCompatFailure(kind: CompatFailureKind): string {
  switch (kind) {
    case "invalid_key":
      return "API key is invalid or rejected by the upstream service.";
    case "insufficient_permission":
      return "The upstream service accepted the request but denied permission or quota.";
    case "unauthorized_client":
      return "The upstream service rejected this client type. Light-Agent will not spoof another product.";
    case "provider_mismatch":
      return "This endpoint looks like the other protocol (Anthropic vs OpenAI-compatible).";
    case "model_not_found":
      return "The model is not available on this upstream service or routing group.";
    case "catalog_unsupported":
      return "The endpoint can chat but does not expose a model catalog.";
    case "stream_unsupported":
      return "The endpoint answered, but it does not look like a supported streaming API.";
    case "empty_stream":
      return "The endpoint ended the stream without sending any content chunks.";
    case "html_instead_of_api":
      return "The URL points at a website page rather than a real API endpoint.";
    case "unsupported_parameter":
      return "The endpoint rejected optional request parameters such as reasoning or tool metadata.";
    case "network_timeout":
      return "The request timed out or the upstream connection was unstable.";
    case "upstream_server_error":
      return "The upstream service returned a server-side error.";
    case "path_mismatch":
      return "The endpoint path layout does not match the selected protocol.";
    default:
      return "Compatibility probe failed for an unknown reason.";
  }
}

export function minimalThinking(): ThinkingDepth {
  return "off";
}
