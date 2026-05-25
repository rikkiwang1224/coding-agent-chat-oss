/**
 * Pricing resolution — pure function mapping (preset, modelId) → ProviderPricing.
 *
 * Kept separate from estimator so it can be reused without pulling in SDK message types.
 */
import type { ProviderPreset, ProviderPricing } from "../types/providers.js";

/**
 * Resolve the pricing for a given model id against a preset's prefix table.
 * Longest-prefix-first match; if `modelId` doesn't match a prefix and a
 * `fallbackModelId` is provided, try the fallback before defaulting to
 * `preset.pricing`.
 *
 * Why the fallback matters: in single-vendor presets (DeepSeek, Kimi, GLM) the
 * SDK's `modelUsage` map is sometimes keyed by the alias we sent on the wire
 * (e.g. `claude-sonnet-4-5-20250929`) rather than the upstream model id
 * (`deepseek-v4-pro`). Without a fallback, that turns into preset-default
 * pricing, which is the wrong tier (e.g. V4-Flash vs V4-Pro for DeepSeek).
 */
export function resolvePricing(
  preset: ProviderPreset,
  modelId: string | undefined,
  fallbackModelId?: string,
): ProviderPricing {
  const tryMatch = (id: string | undefined): ProviderPricing | undefined => {
    if (!preset.pricingByModelPrefix || !id) return undefined;
    const prefixes = Object.keys(preset.pricingByModelPrefix).sort(
      (a, b) => b.length - a.length,
    );
    for (const prefix of prefixes) {
      if (id.startsWith(prefix)) {
        return preset.pricingByModelPrefix[prefix]!;
      }
    }
    return undefined;
  };
  return tryMatch(modelId) ?? tryMatch(fallbackModelId) ?? preset.pricing;
}
