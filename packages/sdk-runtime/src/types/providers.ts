/**
 * LLM provider configuration types.
 *
 * Lives at the type layer (no values, no presets) so any package can import it
 * without pulling in the full sdk-runtime. Actual preset values live in
 * `providers/presets.ts`.
 */

/**
 * Supported LLM provider presets. Each preset maps to an Anthropic-compatible
 * endpoint so the underlying Claude Agent SDK can stay unchanged.
 *
 *  - `anthropic` : Anthropic 官方
 *  - `deepseek`  : DeepSeek 官方 Anthropic 兼容端点
 *  - `kimi`      : Moonshot Kimi K2 Anthropic 兼容端点
 *  - `glm`       : 智谱 GLM Anthropic 兼容端点
 *  - `bedrock` / `vertex`: AWS Bedrock / GCP Vertex AI (env flags only)
 *  - `custom`    : 用户自定义 baseUrl，跳过 preset 默认值
 */
export type LlmProvider =
  | "anthropic"
  | "deepseek"
  | "kimi"
  | "glm"
  | "bedrock"
  | "vertex"
  | "custom";

export interface ProviderPricing {
  /** USD per 1M input tokens */
  inputPerMTokens: number;
  /** USD per 1M output tokens */
  outputPerMTokens: number;
  /** USD per 1M cache-read tokens (typically ~10% of input price) */
  cacheReadPerMTokens?: number;
  /** USD per 1M cache-creation tokens (typically ~125% of input price) */
  cacheWritePerMTokens?: number;
}

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /**
   * Default model id for the main agent (heavy / coding / planning work).
   * Vendor-neutral name — maps to Sonnet on Anthropic, V4-Pro on DeepSeek,
   * K2-0905 on Kimi, GLM-4.5 on Zhipu, etc.
   */
  defaultPrimaryModel: string;
  /**
   * Default model id for lightweight / auxiliary work. Maps to Haiku on Anthropic, V4-Flash
   * on DeepSeek, GLM-4.5-air on Zhipu, etc.
   */
  defaultLightModel: string;
  /** Default pricing — used when no `pricingByModelPrefix` match. */
  pricing: ProviderPricing;
  /**
   * Optional per-model-id-prefix pricing overrides for gateways that route to
   * multiple vendors under one baseUrl.
   * Prefixes should end with "/" (e.g. "anthropic/", "deepseek/").
   * Matched longest-prefix-first; falls back to `pricing` when nothing matches.
   */
  pricingByModelPrefix?: Record<string, ProviderPricing>;
  /**
   * Whether the SDK's `total_cost_usd` is reliable for this provider.
   * Third-party Anthropic-compatible proxies often return 0 or omit it.
   * When false, we recompute from `usage` + preset pricing.
   */
  trustsSdkCost: boolean;
  /**
   * When true, only use `ANTHROPIC_AUTH_TOKEN` for auth and explicitly clear
   * `ANTHROPIC_API_KEY`. Some gateways reject requests when both are set.
   */
  authTokenOnly?: boolean;
}

export interface LlmConfig {
  /** Provider preset; defaults to "anthropic" when omitted. */
  provider?: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Main agent (primary / heavy) model id. Vendor-neutral name; the actual id
   * depends on the configured `provider`.
   */
  primaryModel?: string;
  /**
   * Light / auxiliary model id used for low-stakes tasks. Falls back to
   * `primaryModel` when omitted.
   * Shares the same apiKey / baseUrl as the primary.
   */
  lightModel?: string;
}
