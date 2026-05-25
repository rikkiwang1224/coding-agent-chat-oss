/**
 * Provider preset registry — the single source of truth for baseUrl, default
 * model ids, and pricing for each supported LLM vendor.
 *
 * Pricing snapshot is as of 2026-05. To track a vendor's price change, edit the
 * `*_PRICING` constants once; downstream cost estimation picks it up everywhere.
 */
import type { LlmProvider, ProviderPreset, ProviderPricing } from "../types/providers.js";

// Shared pricing constants — reuse across providers where rates align.
const ANTHROPIC_PRICING: ProviderPricing = {
  inputPerMTokens: 3,
  outputPerMTokens: 15,
  cacheReadPerMTokens: 0.3,
  cacheWritePerMTokens: 3.75,
};
// DeepSeek official pricing — https://api-docs.deepseek.com/quick_start/pricing.
// As of 2026-05 the lineup is V4-Flash (default for `deepseek-chat` alias),
// V4-Pro (currently 75% off through 2026-05-31), and legacy V3.
// We list each model class separately under `pricingByModelPrefix` below so
// estimator picks the right price for whatever id was actually requested.
// `DEEPSEEK_PRICING` (the preset default) deliberately uses V4-Flash —
// that's both the cheapest model and the destination `deepseek-chat` now aliases to.
const DEEPSEEK_PRICING: ProviderPricing = {
  inputPerMTokens: 0.14,
  outputPerMTokens: 0.28,
  cacheReadPerMTokens: 0.0028,
  cacheWritePerMTokens: 0.14,
};
const DEEPSEEK_V4_PRO_PRICING: ProviderPricing = {
  // 75% promo through 2026-05-31; regular = inputPerMTokens 1.74 / output 3.48 / cacheRead 0.0145.
  // Bump these numbers once the promo ends or this file is reviewed past that date.
  inputPerMTokens: 0.435,
  outputPerMTokens: 0.87,
  cacheReadPerMTokens: 0.003625,
  cacheWritePerMTokens: 0.435,
};
const DEEPSEEK_V3_LEGACY_PRICING: ProviderPricing = {
  inputPerMTokens: 0.014,
  outputPerMTokens: 0.028,
  cacheReadPerMTokens: 0.014,
  cacheWritePerMTokens: 0.014,
};
const DEEPSEEK_PRICING_BY_MODEL_PREFIX: Record<string, ProviderPricing> = {
  "deepseek-v4-pro": DEEPSEEK_V4_PRO_PRICING,
  "deepseek-v4-flash": DEEPSEEK_PRICING,
  // `deepseek-chat` and `deepseek-reasoner` are deprecated aliases — per docs
  // they currently route to deepseek-v4-flash (non-thinking / thinking modes).
  "deepseek-chat": DEEPSEEK_PRICING,
  "deepseek-reasoner": DEEPSEEK_PRICING,
  "deepseek-v3": DEEPSEEK_V3_LEGACY_PRICING,
};
// Kimi K2 (kimi-k2-0905-preview / kimi-k2.6) — Moonshot official pricing 2026-05.
// Cache hits are heavily discounted (~75% off input). Without an explicit cache rate
// the estimator falls back to full input price, which produces ~4× overestimates for
// long-running sessions that benefit from prompt caching.
const KIMI_PRICING: ProviderPricing = {
  inputPerMTokens: 0.6,
  outputPerMTokens: 2.5,
  cacheReadPerMTokens: 0.15,
  // Moonshot doesn't separately price cache writes; charge as standard input.
  cacheWritePerMTokens: 0.6,
};
// GLM-4.5 — Zhipu official pricing 2026-05. Cached input ~80% off.
const GLM_PRICING: ProviderPricing = {
  inputPerMTokens: 0.5,
  outputPerMTokens: 2,
  cacheReadPerMTokens: 0.1,
  cacheWritePerMTokens: 0.5,
};

export const PROVIDER_PRESETS: Record<
  Exclude<LlmProvider, "bedrock" | "vertex" | "custom">,
  ProviderPreset
> = {
  anthropic: {
    label: "Anthropic (官方)",
    baseUrl: "https://api.anthropic.com",
    defaultPrimaryModel: "claude-sonnet-4-5-20250929",
    defaultLightModel: "claude-haiku-4-5",
    pricing: ANTHROPIC_PRICING,
    trustsSdkCost: true,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    defaultPrimaryModel: "deepseek-v4-pro",
    defaultLightModel: "deepseek-v4-flash",
    pricing: DEEPSEEK_PRICING,
    pricingByModelPrefix: DEEPSEEK_PRICING_BY_MODEL_PREFIX,
    trustsSdkCost: false,
  },
  kimi: {
    label: "Kimi K2 (Moonshot)",
    baseUrl: "https://api.moonshot.cn/anthropic",
    defaultPrimaryModel: "kimi-k2-0905-preview",
    defaultLightModel: "kimi-k2-0905-preview",
    pricing: KIMI_PRICING,
    trustsSdkCost: false,
  },
  glm: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    defaultPrimaryModel: "glm-4.5",
    defaultLightModel: "glm-4.5-air",
    pricing: GLM_PRICING,
    trustsSdkCost: false,
  },
};
