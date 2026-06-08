import { describe, expect, it } from "vitest";
import { applyThinkingMode, parseThinkingMode } from "../src/thinking-mode.js";

describe("parseThinkingMode", () => {
  it("returns undefined when unset or blank", () => {
    expect(parseThinkingMode(undefined)).toBeUndefined();
    expect(parseThinkingMode("")).toBeUndefined();
    expect(parseThinkingMode("   ")).toBeUndefined();
  });

  it("parses off variants", () => {
    expect(parseThinkingMode("off")).toEqual({ thinking: false });
    expect(parseThinkingMode("disabled")).toEqual({ thinking: false });
    expect(parseThinkingMode("false")).toEqual({ thinking: false });
  });

  it("parses high variants", () => {
    expect(parseThinkingMode("high")).toEqual({ thinking: true, reasoningEffort: "high" });
    expect(parseThinkingMode("enabled")).toEqual({ thinking: true, reasoningEffort: "high" });
    expect(parseThinkingMode("on")).toEqual({ thinking: true, reasoningEffort: "high" });
  });

  it("parses max", () => {
    expect(parseThinkingMode("max")).toEqual({ thinking: true, reasoningEffort: "max" });
  });

  it("applies defaultWhenUnset", () => {
    expect(parseThinkingMode(undefined, "max")).toEqual({
      thinking: true,
      reasoningEffort: "max",
    });
  });

  it("rejects unknown values", () => {
    expect(() => parseThinkingMode("turbo")).toThrow(/Invalid THINKING_MODE/);
  });
});

describe("applyThinkingMode", () => {
  it("leaves config unchanged when mode is unset", () => {
    const base = { apiKey: "k" };
    expect(applyThinkingMode(base, undefined)).toEqual(base);
  });

  it("merges max thinking into LlmConfig", () => {
    expect(
      applyThinkingMode({ apiKey: "k" }, { thinking: true, reasoningEffort: "max" }),
    ).toEqual({
      apiKey: "k",
      thinking: true,
      reasoningEffort: "max",
    });
  });
});
