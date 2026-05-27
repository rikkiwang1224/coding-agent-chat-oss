import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_PRESETS, type LlmProvider } from "@forgelet/sdk-runtime";
import { resolveAgentHome } from "@forgelet/storage-core";
import type { CliArgs } from "./argv.js";

const CONFIG_FILENAME = "config.json";

export interface CliConfig {
  provider: LlmProvider;
  primaryModel: string;
  apiKey: string;
  baseUrl: string;
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
  };
}

export interface ResolvedLlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Merge CLI flags, env vars, and ~/.forgelet/config.json (flags win). */
export async function resolveLlmConfig(args: CliArgs): Promise<ResolvedLlmConfig> {
  const fileConfig = await loadCliConfigFile();

  const provider = (args.provider ||
    process.env.FORGELET_PROVIDER ||
    fileConfig.provider ||
    "deepseek") as LlmProvider;

  const apiKey =
    args.apiKey?.trim() ||
    process.env.FORGELET_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    fileConfig.apiKey.trim();

  const model =
    args.model?.trim() ||
    process.env.FORGELET_MODEL?.trim() ||
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
    process.env.FORGELET_BASE_URL?.trim() ||
    fileConfig.baseUrl.trim() ||
    preset?.baseUrl ||
    "https://api.deepseek.com";

  return { provider, apiKey, baseUrl, model };
}
