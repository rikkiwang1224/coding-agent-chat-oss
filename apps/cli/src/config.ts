import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_PRESETS, type LlmProvider } from "@lattice-code/sdk-runtime";
import { applyThinkingMode, parseThinkingMode } from "@lattice-code/harness";
import { resolveAgentHome } from "@lattice-code/storage-core";
import type { CliArgs } from "./argv.js";

const CONFIG_FILENAME = "config.json";

export interface CliConfig {
  provider: LlmProvider;
  primaryModel: string;
  apiKey: string;
  baseUrl: string;
  /** DeepSeek thinking: off | high | max (see THINKING_MODE env) */
  thinkingMode?: string;
}

const DEFAULT_CONFIG: CliConfig = {
  provider: "deepseek",
  primaryModel: "deepseek-v4-pro",
  apiKey: "",
  baseUrl: "",
};

const VALID_PROVIDERS: ReadonlySet<LlmProvider> = new Set([
  "anthropic",
  "deepseek",
  "kimi",
  "glm",
  "bedrock",
  "vertex",
  "custom",
]);

export function getConfigFilePath(): string {
  return path.join(resolveAgentHome(), CONFIG_FILENAME);
}

export async function loadCliConfigFile(): Promise<CliConfig> {
  try {
    const raw = await readFile(getConfigFilePath(), "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<CliConfig>);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  const filePath = getConfigFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(normalizeConfig(config), null, 2), "utf8");
}

function normalizeConfig(saved: Partial<CliConfig>): CliConfig {
  const rawProvider = typeof saved.provider === "string" ? saved.provider.trim().toLowerCase() : "";
  const provider = VALID_PROVIDERS.has(rawProvider as LlmProvider)
    ? (rawProvider as LlmProvider)
    : DEFAULT_CONFIG.provider;
  return {
    provider,
    primaryModel:
      typeof saved.primaryModel === "string" && saved.primaryModel.trim()
        ? saved.primaryModel.trim()
        : DEFAULT_CONFIG.primaryModel,
    apiKey: typeof saved.apiKey === "string" ? saved.apiKey : DEFAULT_CONFIG.apiKey,
    baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : DEFAULT_CONFIG.baseUrl,
    thinkingMode:
      typeof saved.thinkingMode === "string" && saved.thinkingMode.trim()
        ? saved.thinkingMode.trim()
        : undefined,
  };
}

export interface ResolvedLlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Sampling temperature. Undefined → harness default (0, deterministic).
   * Set via LATTICE_CODE_TEMPERATURE — used by Best-of-N sampling so the N runs
   * diverge instead of all returning the same greedy patch.
   */
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
}

/** Parse + clamp LATTICE_CODE_TEMPERATURE; returns undefined when unset/invalid. */
function resolveTemperature(): number | undefined {
  const raw = process.env.LATTICE_CODE_TEMPERATURE?.trim();
  if (!raw) return undefined;
  const t = Number.parseFloat(raw);
  if (!Number.isFinite(t)) return undefined;
  return Math.min(2, Math.max(0, t));
}

/** Merge CLI flags, env vars, and ~/.lattice-code/config.json (flags win). */
export async function resolveLlmConfig(args: CliArgs): Promise<ResolvedLlmConfig> {
  const fileConfig = await loadCliConfigFile();

  const provider = (args.provider ||
    process.env.LATTICE_CODE_PROVIDER ||
    fileConfig.provider ||
    "deepseek") as LlmProvider;

  const apiKey =
    args.apiKey?.trim() ||
    process.env.LATTICE_CODE_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    fileConfig.apiKey.trim();

  const model =
    args.model?.trim() ||
    process.env.LATTICE_CODE_MODEL?.trim() ||
    fileConfig.primaryModel.trim() ||
    "deepseek-v4-pro";

  const preset =
    provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
      : provider === "deepseek"
        ? { baseUrl: "https://api.deepseek.com", defaultPrimaryModel: "deepseek-v4-pro" }
        : undefined;

  const baseUrl =
    args.baseUrl?.trim() ||
    process.env.LATTICE_CODE_BASE_URL?.trim() ||
    fileConfig.baseUrl.trim() ||
    preset?.baseUrl ||
    "https://api.deepseek.com";

  const thinkingRaw =
    process.env.THINKING_MODE?.trim() || fileConfig.thinkingMode?.trim() || undefined;
  const thinkingMode = parseThinkingMode(thinkingRaw);

  return applyThinkingMode(
    { provider, apiKey, baseUrl, model, temperature: resolveTemperature() },
    thinkingMode,
  );
}
