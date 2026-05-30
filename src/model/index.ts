import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

/**
 * Provider registry / selection. See docs/06.
 *
 * The loop depends only on the ModelProvider interface, so provider choice is
 * pure config (docs/06):
 *  - "anthropic": native Messages API, or any Anthropic-compatible proxy via
 *    config.baseURL (a 中转站).
 *  - "openai": any OpenAI-compatible /chat/completions endpoint via baseURL
 *    (OpenRouter, DeepSeek, Kimi, Qwen, local Ollama/vLLM, …).
 *
 * Adding a new provider means registering another factory here — the loop and
 * tools are untouched.
 */
export function createProvider(config: Config): ModelProvider {
  const common = {
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  };
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(common);
    case "anthropic":
    default:
      return new AnthropicProvider(common);
  }
}

export type { ModelProvider } from "./types.js";
