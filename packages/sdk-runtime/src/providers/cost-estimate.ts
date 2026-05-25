import type { LlmProvider, ProviderPricing } from "../types/providers.js";
import { PROVIDER_PRESETS } from "./presets.js";

export interface TokenCostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function resolvePricingForModel(
  provider: LlmProvider,
  modelId?: string,
): ProviderPricing | undefined {
  if (provider === "bedrock" || provider === "vertex") {
    return PROVIDER_PRESETS.anthropic.pricing;
  }
  if (provider === "custom") {
    return PROVIDER_PRESETS.deepseek.pricing;
  }

  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return undefined;

  const normalized = (modelId ?? "").trim().toLowerCase();
  if (!normalized || !preset.pricingByModelPrefix) {
    return preset.pricing;
  }

  const prefixes = Object.keys(preset.pricingByModelPrefix).sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix.toLowerCase())) {
      return preset.pricingByModelPrefix[prefix];
    }
  }

  return preset.pricing;
}

export function estimateTokenCostUsd(pricing: ProviderPricing, usage: TokenCostInput): number {
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const billableInput = Math.max(0, input - cacheRead - cacheWrite);

  const cost =
    (billableInput / 1_000_000) * pricing.inputPerMTokens +
    (output / 1_000_000) * pricing.outputPerMTokens +
    (cacheRead / 1_000_000) * (pricing.cacheReadPerMTokens ?? pricing.inputPerMTokens) +
    (cacheWrite / 1_000_000) * (pricing.cacheWritePerMTokens ?? pricing.inputPerMTokens);

  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function estimateRunCostUsd(options: {
  provider: LlmProvider;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): number | undefined {
  const pricing = resolvePricingForModel(options.provider, options.model);
  if (!pricing) return undefined;

  return estimateTokenCostUsd(pricing, {
    inputTokens: options.inputTokens ?? 0,
    outputTokens: options.outputTokens ?? 0,
    cacheReadInputTokens: options.cacheReadInputTokens,
    cacheCreationInputTokens: options.cacheCreationInputTokens,
  });
}

export function formatCostUsd(costUsd: number | undefined): string {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return "—";
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}
