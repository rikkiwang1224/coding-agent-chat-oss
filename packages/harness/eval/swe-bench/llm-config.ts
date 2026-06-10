import {
  DEFAULT_LLM_PROVIDER,
  getProviderOption,
  type LlmProvider,
} from "@lattice-code/sdk-runtime";
import { applyThinkingMode, resolveThinkingModeFromEnv } from "../../src/thinking-mode.js";
import type { LlmConfig } from "../../src/types.js";

function resolveTemperature(): number | undefined {
  const raw = process.env.LATTICE_CODE_TEMPERATURE?.trim();
  if (!raw) return undefined;
  const t = Number.parseFloat(raw);
  if (!Number.isFinite(t)) return undefined;
  return Math.min(2, Math.max(0, t));
}

/** Resolve LLM config from env (Docker batch / in-container agent). */
export function resolveLlmConfigFromEnv(): LlmConfig {
  const provider = (process.env.LATTICE_CODE_PROVIDER?.trim() ||
    DEFAULT_LLM_PROVIDER) as LlmProvider;
  const providerDefaults = getProviderOption(provider);
  const apiKey =
    process.env.LATTICE_CODE_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    "";

  const model =
    process.env.LATTICE_CODE_MODEL?.trim() ||
    process.env.MODEL_NAME?.trim() ||
    providerDefaults.defaultPrimaryModel;

  const baseUrl =
    process.env.LATTICE_CODE_BASE_URL?.trim() ||
    providerDefaults.baseUrl ||
    getProviderOption(DEFAULT_LLM_PROVIDER).baseUrl;

  const temperature = resolveTemperature();
  // SWE-bench eval default: Think Max (override with THINKING_MODE=off|high).
  const thinkingMode = resolveThinkingModeFromEnv("max");

  return applyThinkingMode(
    {
      apiKey,
      baseUrl,
      model,
      provider,
      ...(temperature !== undefined ? { temperature } : {}),
    },
    thinkingMode,
  );
}
