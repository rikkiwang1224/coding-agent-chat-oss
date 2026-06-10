import type { LlmProvider } from "../types/providers.js";
import { PROVIDER_PRESETS } from "./presets.js";

/** Default LLM vendor for Lattice Code (CLI, desktop, eval). */
export const DEFAULT_LLM_PROVIDER = "deepseek" satisfies LlmProvider;

/** Settings dropdown entry — registry presets plus gateway-only providers. */
export interface ProviderOption {
  id: LlmProvider;
  label: string;
  baseUrl: string;
  defaultPrimaryModel: string;
  defaultLightModel: string;
  description: string;
}

type RegistryProvider = keyof typeof PROVIDER_PRESETS;

const REGISTRY_PROVIDER_ORDER: RegistryProvider[] = [
  "deepseek",
  "anthropic",
  "kimi",
  "glm",
];

function presetToOption(id: RegistryProvider): ProviderOption {
  const preset = PROVIDER_PRESETS[id];
  return {
    id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    defaultPrimaryModel: preset.defaultPrimaryModel,
    defaultLightModel: preset.defaultLightModel,
    description: preset.description,
  };
}

const GATEWAY_PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    baseUrl: "",
    defaultPrimaryModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    defaultLightModel: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    description: "Optional. Use Claude through AWS Bedrock credentials in your environment.",
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    baseUrl: "",
    defaultPrimaryModel: "claude-sonnet-4-5@20250929",
    defaultLightModel: "claude-3-5-haiku@20241022",
    description: "Optional. Use Claude through Google Vertex AI credentials in your environment.",
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    defaultPrimaryModel: "",
    defaultLightModel: "",
    description: "Optional. Any Anthropic-compatible gateway or local proxy.",
  },
];

/** Ordered provider list for Settings UI and default resolution. */
export const PROVIDER_OPTIONS: ProviderOption[] = [
  ...REGISTRY_PROVIDER_ORDER.map(presetToOption),
  ...GATEWAY_PROVIDER_OPTIONS,
];

export function getProviderOption(id: LlmProvider): ProviderOption {
  return (
    PROVIDER_OPTIONS.find((option) => option.id === id) ??
    getProviderOption(DEFAULT_LLM_PROVIDER)
  );
}

export function buildDefaultLlmGeneralSettings(): {
  provider: LlmProvider;
  primaryModel: string;
  lightModel: string;
  baseUrl: string;
} {
  const preset = getProviderOption(DEFAULT_LLM_PROVIDER);
  return {
    provider: DEFAULT_LLM_PROVIDER,
    primaryModel: preset.defaultPrimaryModel,
    lightModel: preset.defaultLightModel,
    baseUrl: preset.baseUrl,
  };
}

export function hasDistinctLightModel(option: ProviderOption): boolean {
  return Boolean(
    option.defaultLightModel && option.defaultLightModel !== option.defaultPrimaryModel,
  );
}
