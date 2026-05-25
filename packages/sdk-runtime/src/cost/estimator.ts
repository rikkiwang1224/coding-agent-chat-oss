/**
 * Cost estimation from SDK usage + preset pricing.
 *
 * All pure functions — no I/O. Easy to unit-test by handing in fake messages.
 */
import type { SdkMessage, SdkModelUsage, SdkUsage } from "../types/sdk-messages.js";
import type { LlmProvider, ProviderPreset, ProviderPricing } from "../types/providers.js";
import type { AgentRunMetrics } from "../types/agent-config.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";
import { resolvePricing } from "./pricing.js";

/**
 * Estimate cost for a single (usage, pricing) pair. Cache rates default to
 * input price for read and 1.25× input for write when not specified.
 */
export function estimateCostFromUsage(usage: SdkUsage, pricing: ProviderPricing): number {
  const M = 1_000_000;
  const input = (usage.input_tokens ?? 0) * pricing.inputPerMTokens / M;
  const output = (usage.output_tokens ?? 0) * pricing.outputPerMTokens / M;
  const cacheReadRate = pricing.cacheReadPerMTokens ?? pricing.inputPerMTokens;
  const cacheWriteRate = pricing.cacheWritePerMTokens ?? pricing.inputPerMTokens * 1.25;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * cacheReadRate / M;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * cacheWriteRate / M;
  return input + output + cacheRead + cacheWrite;
}

/**
 * Estimate total cost for a run. Prefers per-model `modelUsage` (so a session
 * that crossed model boundaries — e.g. main agent on sonnet, subagent on haiku,
 * or multi-vendor routing — gets priced correctly per model).
 * Falls back to flat `usage` when modelUsage is unavailable.
 */
export function estimateCostForRun(
  usage: SdkUsage,
  modelUsage: Record<string, SdkModelUsage> | undefined,
  preset: ProviderPreset,
  fallbackModelId: string | undefined,
): number {
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    let total = 0;
    for (const [modelId, mu] of Object.entries(modelUsage)) {
      total += estimateCostFromUsage(
        {
          input_tokens: mu.inputTokens,
          output_tokens: mu.outputTokens,
          cache_read_input_tokens: mu.cacheReadInputTokens,
          cache_creation_input_tokens: mu.cacheCreationInputTokens,
        },
        // Pass fallbackModelId so we still hit the right pricing tier even when
        // modelUsage tracks the alias we sent (e.g. "claude-sonnet-4-5-…")
        // rather than the upstream model id ("deepseek-v4-pro").
        resolvePricing(preset, modelId, fallbackModelId),
      );
    }
    if (total > 0) return total;
    // If modelUsage was all zeros, fall through to flat usage (defensive).
  }
  return estimateCostFromUsage(usage, resolvePricing(preset, fallbackModelId));
}

/**
 * Aggregate token counts. Prefers `modelUsage` (sum over all models, which
 * includes Claude Code's internal sub-agent calls and any cross-vendor routing)
 * and falls back to flat `usage` when modelUsage is unavailable.
 *
 * Flat `usage` on the SDK's final result message often reports only the last
 * turn / main agent, while `modelUsage` is cumulative. Reporting the same
 * source for both tokens and cost keeps the snapshot internally consistent —
 * e.g. a snapshot can't claim 70K tokens but $0.13 cost priced against 130K.
 */
export function aggregateTokens(
  usage: SdkUsage,
  modelUsage: Record<string, SdkModelUsage> | undefined,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} {
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const mu of Object.values(modelUsage)) {
      totals.input += mu.inputTokens ?? 0;
      totals.output += mu.outputTokens ?? 0;
      totals.cacheRead += mu.cacheReadInputTokens ?? 0;
      totals.cacheCreation += mu.cacheCreationInputTokens ?? 0;
    }
    if (totals.input + totals.output + totals.cacheRead + totals.cacheCreation > 0) {
      return totals;
    }
    // Defensive: if modelUsage was present but all zero, fall through to flat usage.
  }
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Build metrics from a SDK result message, computing cost locally when the provider
 * doesn't return a trustworthy `total_cost_usd`.
 *
 * Cost computation precedence:
 *   1. If preset.trustsSdkCost AND SDK gave a positive cost → use SDK value as-is.
 *   2. Else, if `modelUsage` is populated → sum per-model cost using prefix-matched pricing.
 *      (Handles multi-vendor routing in one session.)
 *   3. Else → fall back to total `usage` × resolved pricing (main model only).
 */
export function buildMetricsFromResult(
  message: SdkMessage,
  provider: LlmProvider,
  model: string | undefined,
  runStartMs: number,
): AgentRunMetrics {
  const usage = message.usage ?? {};
  const modelUsage = message.modelUsage;
  const sdkCost = typeof message.total_cost_usd === "number"
    ? message.total_cost_usd
    : typeof message.cost_usd === "number"
      ? message.cost_usd
      : undefined;

  const preset =
    provider in PROVIDER_PRESETS
      ? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
      : undefined;

  let totalCostUsd = sdkCost;
  let costIsEstimated = false;
  const trustSdk = preset?.trustsSdkCost && sdkCost != null && sdkCost > 0;
  if (preset && !trustSdk) {
    const estimated = estimateCostForRun(usage, modelUsage, preset, model);
    if (estimated > 0) {
      totalCostUsd = estimated;
      costIsEstimated = true;
    }
  }

  // Use the same token aggregation strategy as cost — without this, snapshot
  // would show flat `usage` tokens alongside `modelUsage`-derived cost and
  // appear to be charging way more per token than the math actually says.
  const tokens = aggregateTokens(usage, modelUsage);

  return {
    durationMs:
      typeof message.duration_ms === "number" ? message.duration_ms : Date.now() - runStartMs,
    durationApiMs:
      typeof message.duration_api_ms === "number" ? message.duration_api_ms : undefined,
    numTurns: typeof message.num_turns === "number" ? message.num_turns : undefined,
    totalCostUsd,
    costIsEstimated: costIsEstimated || undefined,
    inputTokens: tokens.input || undefined,
    outputTokens: tokens.output || undefined,
    cacheReadInputTokens: tokens.cacheRead || undefined,
    cacheCreationInputTokens: tokens.cacheCreation || undefined,
    provider,
    model,
  };
}

/**
 * Merge a new run's metrics into the existing snapshot metrics.
 *
 * Chat-mode sessions reuse the same `sessionId` across multiple `query()` calls
 * (one per user turn). Each call returns its own `SDKResultMessage` with usage
 * scoped to that turn only — so naively assigning `snapshot.metrics = turn`
 * would discard all prior turns' cost / tokens / duration.
 *
 * This accumulator sums numeric counters, OR-s the `costIsEstimated` flag
 * (any local estimate taints the whole session), and keeps the latest non-null
 * provider/model identifiers (last-write-wins; provider rarely changes mid-session).
 */
export function accumulateMetrics(
  prev: AgentRunMetrics | undefined,
  next: AgentRunMetrics,
): AgentRunMetrics {
  if (!prev) return next;
  const sum = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a == null && b == null) return undefined;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    durationMs: sum(prev.durationMs, next.durationMs),
    durationApiMs: sum(prev.durationApiMs, next.durationApiMs),
    numTurns: sum(prev.numTurns, next.numTurns),
    totalCostUsd: sum(prev.totalCostUsd, next.totalCostUsd),
    costIsEstimated: prev.costIsEstimated || next.costIsEstimated || undefined,
    inputTokens: sum(prev.inputTokens, next.inputTokens),
    outputTokens: sum(prev.outputTokens, next.outputTokens),
    cacheReadInputTokens: sum(prev.cacheReadInputTokens, next.cacheReadInputTokens),
    cacheCreationInputTokens: sum(prev.cacheCreationInputTokens, next.cacheCreationInputTokens),
    provider: next.provider ?? prev.provider,
    model: next.model ?? prev.model,
  };
}
