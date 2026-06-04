import type { Config } from "../config.js";
import { loadStore, saveStore, upsertProfile } from "../profiles.js";
import { AnthropicProvider } from "./anthropic.js";
import {
  isCompatibilityFailureKind,
  probeCompatibility,
  summarizeCompatFailure,
  type CompatProtocol,
  type CompatibilityReport,
  type CompatibilitySnapshot,
} from "./compat.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderError } from "./types.js";

/**
 * Provider registry / selection. See docs/06.
 *
 * The loop depends only on the ModelProvider interface. A compatibility wrapper
 * now sits in front of the raw Anthropic/OpenAI implementations so the runtime
 * can auto-correct protocol/baseURL mismatches, retry minimal requests, and
 * persist compatibility findings back into the active profile.
 */
export function createProvider(config: Config): ModelProvider {
  return new CompatibilityProvider(config);
}

class CompatibilityProvider implements ModelProvider {
  readonly name = "compat";
  readonly model: string;
  private readonly config: Config;

  constructor(config: Config) {
    this.model = config.model;
    this.config = config;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    const attempts = this.buildAttempts(req);
    let lastError: ProviderError | undefined;

    for (const attempt of attempts) {
      const provider = baseProviderFor(this.config, attempt.protocol, attempt.compat);
      const result = provider.stream(attempt.request);
      let started = false;
      const buffered: ModelEvent[] = [];
      let earlyError: ProviderError | undefined;

      for await (const event of result) {
        if (!started) {
          if (event.type === "error") {
            earlyError = event.error;
            break;
          }
          buffered.push(event);
          if (isSubstantive(event)) {
            started = true;
            for (const item of buffered) yield item;
          }
          continue;
        }
        yield event;
      }

      if (started && !earlyError) {
        return;
      }
      if (started && earlyError) {
        yield { type: "error", error: earlyError };
        return;
      }
      if (!earlyError) {
        return;
      }

      lastError = earlyError;
      if (!isCompatibilityFailureKind(earlyError.kind ?? "unknown")) {
        yield { type: "error", error: earlyError };
        return;
      }
    }

    const report = await probeCompatibility({
      preferredProtocol: this.config.compat?.preferredProtocol ?? this.config.provider,
      baseURL: this.config.compat?.resolvedBaseURL ?? this.config.baseURL,
      apiKey: this.config.apiKey,
      model: this.config.model,
    });

    if (report.selected) {
      this.persistCompatibility(report);
      const provider = baseProviderFor(
        {
          ...this.config,
          provider: report.selected.preferredProtocol,
          baseURL: report.selected.resolvedBaseURL,
          compat: report.selected,
        },
        report.selected.preferredProtocol,
        report.selected,
      );
      const retryReq = applyCapabilities(req, report.selected);
      for await (const event of provider.stream(retryReq)) yield event;
      return;
    }

    yield {
      type: "error",
      error: {
        message:
          `${summarizeCompatFailure(report.failureKind ?? "unknown")} ` +
          (report.failureMessage ?? lastError?.message ?? "No compatible protocol succeeded."),
        retryable: false,
        kind: report.failureKind ?? lastError?.kind ?? "unknown",
      },
    };
  }

  private buildAttempts(req: ModelRequest): Array<{
    protocol: CompatProtocol;
    request: ModelRequest;
    compat?: CompatibilitySnapshot;
  }> {
    const protocol = this.config.compat?.preferredProtocol ?? this.config.provider;
    const attempts: Array<{
      protocol: CompatProtocol;
      request: ModelRequest;
      compat?: CompatibilitySnapshot;
    }> = [
      { protocol, request: applyCapabilities(req, this.config.compat), compat: this.config.compat },
    ];
    if (shouldTryMinimal(req)) {
      attempts.push({
        protocol,
        request: minimalizeRequest(req, this.config.compat),
        compat: {
          ...(this.config.compat ?? {}),
          preferredProtocol: protocol,
          ...(this.config.compat?.supportsReasoning === false ? {} : { supportsReasoning: false }),
          ...(this.config.compat?.supportsTools === false ? {} : { supportsTools: false }),
        },
      });
    }
    return attempts;
  }

  private persistCompatibility(report: CompatibilityReport): void {
    if (!this.config.profileName || !report.selected) return;
    const store = loadStore();
    const current = store.profiles[this.config.profileName];
    if (!current) return;
    upsertProfile(store, this.config.profileName, {
      ...current,
      provider: report.selected.preferredProtocol,
      ...(report.selected.resolvedBaseURL ? { baseURL: report.selected.resolvedBaseURL } : {}),
      compat: report.selected,
    });
    saveStore(store);
  }
}

function baseProviderFor(
  config: Config,
  protocol: CompatProtocol,
  compat?: CompatibilitySnapshot,
): ModelProvider {
  const common = {
    apiKey: config.apiKey,
    model: config.model,
    ...(compat?.resolvedBaseURL || config.baseURL
      ? { baseURL: compat?.resolvedBaseURL ?? config.baseURL }
      : {}),
    ...(compat?.chatURL ? { chatURL: compat.chatURL } : {}),
    ...(compat ? { compat } : {}),
  };
  return protocol === "openai"
    ? new OpenAIProvider(common)
    : new AnthropicProvider(common);
}

function shouldTryMinimal(req: ModelRequest): boolean {
  return req.tools.length > 0 || (req.thinking !== undefined && req.thinking !== "off");
}

function minimalizeRequest(
  req: ModelRequest,
  compat?: CompatibilitySnapshot,
): ModelRequest {
  return {
    ...req,
    tools: [],
    thinking: "off",
    messages: compat?.supportsVision === false ? stripImages(req.messages) : req.messages,
  };
}

function applyCapabilities(
  req: ModelRequest,
  compat?: CompatibilitySnapshot,
): ModelRequest {
  return {
    ...req,
    tools: compat?.supportsTools === false ? [] : req.tools,
    thinking: compat?.supportsReasoning === false ? "off" : req.thinking,
    messages: compat?.supportsVision === false ? stripImages(req.messages) : req.messages,
  };
}

function stripImages(messages: ModelRequest["messages"]): ModelRequest["messages"] {
  return messages.map((message) => ({
    ...message,
    content: message.content.filter((block) => block.type !== "image"),
  }));
}

function isSubstantive(event: ModelEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "reasoning_delta" ||
    event.type === "tool_use_start" ||
    event.type === "message_stop"
  );
}

export type { ModelProvider } from "./types.js";
