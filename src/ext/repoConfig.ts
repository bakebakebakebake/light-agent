import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RepoAgentConfig {
  disabledSkills: string[];
  blockedCommands: string[];
  protectedPaths: string[];
}

const DEFAULT_CONFIG: RepoAgentConfig = {
  disabledSkills: [],
  blockedCommands: [],
  protectedPaths: [],
};

function normalizeList(values: unknown, lower = false): string[] {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (lower ? value.toLowerCase() : value));
  return [...new Set(out)];
}

function parseConfig(raw: unknown): RepoAgentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const rec = raw as Record<string, unknown>;
  return {
    disabledSkills: normalizeList(rec.disabledSkills, true),
    blockedCommands: normalizeList(rec.blockedCommands, true),
    protectedPaths: normalizeList(rec.protectedPaths),
  };
}

function readJson(path: string): RepoAgentConfig | null {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function repoConfigPaths(cwd: string): {
  primary: string;
  legacy: string[];
} {
  return {
    primary: join(cwd, ".agents", "light-agent.json"),
    legacy: [
      join(cwd, ".agents", "harness-agent.json"),
      join(cwd, ".agent", "light-agent.json"),
      join(cwd, ".agent", "harness-agent.json"),
    ],
  };
}

export function loadRepoAgentConfig(cwd: string): RepoAgentConfig {
  const { primary, legacy } = repoConfigPaths(cwd);
  const primaryConfig = existsSync(primary) ? readJson(primary) : null;
  if (primaryConfig) return primaryConfig;
  for (const path of legacy) {
    const legacyConfig = existsSync(path) ? readJson(path) : null;
    if (legacyConfig) return legacyConfig;
  }
  return { ...DEFAULT_CONFIG };
}

export function saveRepoAgentConfig(cwd: string, config: RepoAgentConfig): string {
  const { primary } = repoConfigPaths(cwd);
  mkdirSync(dirname(primary), { recursive: true });
  writeFileSync(
    primary,
    JSON.stringify(
      {
        disabledSkills: normalizeList(config.disabledSkills, true),
        blockedCommands: normalizeList(config.blockedCommands, true),
        protectedPaths: normalizeList(config.protectedPaths),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return primary;
}
