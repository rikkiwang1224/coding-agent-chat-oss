import { describe, expect, it } from "vitest";
import { estimateRunCostUsd, formatCostUsd } from "@forgelet/sdk-runtime";

describe("cost estimation", () => {
  it("estimates deepseek-v4-pro run cost", () => {
    const cost = estimateRunCostUsd({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      inputTokens: 100_000,
      outputTokens: 20_000,
    });
    expect(cost).toBeGreaterThan(0);
    expect(formatCostUsd(cost)).toMatch(/^\$/);
  });
});
