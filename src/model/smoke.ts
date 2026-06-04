import type { Config } from "../config.js";
import {
  probeCompatibility,
  summarizeCompatFailure,
  type CompatFailureKind,
  type CompatProtocol,
} from "./compat.js";

export interface ModelSmokeResult {
  provider: string;
  model: string;
  baseURL?: string;
  actualProtocol?: CompatProtocol;
  corrected?: boolean;
  chatURL?: string;
  catalogOk: boolean;
  catalogError?: string;
  catalogCount?: number;
  catalogResolvedURL?: string;
  catalogFailureKind?: string;
  streamOk: boolean;
  streamError?: string;
  failureKind?: CompatFailureKind;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

export async function smokeTestModel(
  config: Config,
  opts: { model?: string } = {},
): Promise<ModelSmokeResult> {
  const model = opts.model?.trim() || config.model;
  const report = await probeCompatibility({
    preferredProtocol: config.compat?.preferredProtocol ?? config.provider,
    baseURL: config.compat?.resolvedBaseURL ?? config.baseURL,
    apiKey: config.apiKey,
    model,
  });
  const selected = report.selected;
  const activeProbe =
    report.probes.find((probe) => probe.streamOk) ?? report.probes[0];
  return {
    provider: config.provider,
    model,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(selected?.preferredProtocol ? { actualProtocol: selected.preferredProtocol } : {}),
    ...(selected?.chatURL ? { chatURL: selected.chatURL } : {}),
    corrected: report.corrected,
    catalogOk: activeProbe?.catalogOk ?? false,
    ...(activeProbe?.catalogError ? { catalogError: activeProbe.catalogError } : {}),
    catalogCount: activeProbe?.catalogCount ?? 0,
    ...(activeProbe?.catalogURL ? { catalogResolvedURL: activeProbe.catalogURL } : {}),
    ...(activeProbe?.catalogFailureKind
      ? { catalogFailureKind: activeProbe.catalogFailureKind }
      : {}),
    streamOk: activeProbe?.streamOk ?? false,
    ...(activeProbe?.streamError
      ? {
          streamError:
            activeProbe.streamError +
            (activeProbe.failureKind
              ? ` (${summarizeCompatFailure(activeProbe.failureKind)})`
              : ""),
        }
      : {}),
    ...(activeProbe?.failureKind ? { failureKind: activeProbe.failureKind } : {}),
    ...(selected ? { supportsTools: selected.supportsTools } : {}),
    ...(selected ? { supportsReasoning: selected.supportsReasoning } : {}),
    ...(selected ? { supportsVision: selected.supportsVision } : {}),
  };
}
