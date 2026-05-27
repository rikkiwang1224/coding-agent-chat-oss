import { describe, it, expect } from "vitest";
import { summarizeEvalUsage, summarizeTaskUsage } from "../eval/usage-summary.js";
import type { AgentEvent } from "@forgelet/shared-types";

function doneEvent(metrics: Record<string, number>): AgentEvent {
  return {
    type: "agent.done",
    sessionId: "s1",
    taskId: "t1",
    timestamp: new Date().toISOString(),
    payload: {
      summary: "done",
      status: "completed",
      recoverable: false,
      terminalReason: "completed",
      metrics,
    },
  };
}

describe("eval usage summary", () => {
  it("sums token usage and cost from agent.done events", () => {
    const events = [
      doneEvent({ runInputTokens: 1000, runOutputTokens: 200, totalCostUsd: 0.01 }),
    ];
    expect(summarizeTaskUsage(events)).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      totalCostUsd: 0.01,
    });
  });

  it("estimates cost when provider is set but metrics omit cost", () => {
    const usage = summarizeEvalUsage(
      [{ events: [doneEvent({ inputTokens: 1_000_000, outputTokens: 0 })] }],
      { provider: "deepseek", model: "deepseek-v4-pro" },
    );
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.totalCostUsd).toBeGreaterThan(0);
  });
});
