import type { AgentEvent } from "@forgelet/shared-types";
import { estimateRunCostUsd, formatCostUsd, type LlmProvider } from "@forgelet/sdk-runtime";

export interface EvalUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export function summarizeTaskUsage(events: AgentEvent[]): EvalUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;

  for (const event of events) {
    if (event.type !== "agent.done") continue;
    const metrics = event.payload?.metrics;
    if (!metrics) continue;

    inputTokens += metrics.runInputTokens ?? metrics.inputTokens ?? 0;
    outputTokens += metrics.runOutputTokens ?? metrics.outputTokens ?? 0;
    totalCostUsd += metrics.totalCostUsd ?? 0;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalCostUsd,
  };
}

export function summarizeEvalUsage(
  results: { events: AgentEvent[] }[],
  pricing?: { provider: LlmProvider; model?: string },
): EvalUsageSummary {
  const totals: EvalUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };

  for (const result of results) {
    const usage = summarizeTaskUsage(result.events);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalCostUsd += usage.totalCostUsd;
  }

  totals.totalTokens = totals.inputTokens + totals.outputTokens;

  if (
    totals.totalCostUsd === 0 &&
    pricing &&
    (totals.inputTokens > 0 || totals.outputTokens > 0)
  ) {
    totals.totalCostUsd =
      estimateRunCostUsd({
        provider: pricing.provider,
        model: pricing.model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
      }) ?? 0;
  }

  return totals;
}

export { formatCostUsd };
