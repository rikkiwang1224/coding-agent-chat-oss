import { describe, it, expect } from "vitest";
import { parseReasonOutput, formatReasonFeedback, type ReasonResult } from "../src/reason.js";

describe("parseReasonOutput", () => {
  it("parses a clean ship verdict", () => {
    const out = parseReasonOutput(
      JSON.stringify({ verdict: "ship", confidence: "high", rationale: "looks correct" }),
    );
    expect(out.verdict).toBe("ship");
    expect(out.confidence).toBe("high");
    expect(out.rationale).toBe("looks correct");
  });

  it("parses a revise verdict with missed_cases", () => {
    const out = parseReasonOutput(
      JSON.stringify({
        verdict: "revise",
        confidence: "medium",
        rationale: "missed edge case",
        missed_cases: [
          { what: "empty list handling", where: "utils.py:42" },
          { what: "unicode in keys" },
        ],
        suggestions: ["wrap in try/except", "add type check"],
      }),
    );
    expect(out.verdict).toBe("revise");
    expect(out.missed_cases).toHaveLength(2);
    expect(out.missed_cases?.[0]).toEqual({ what: "empty list handling", where: "utils.py:42" });
    expect(out.missed_cases?.[1]).toEqual({ what: "unicode in keys" });
    expect(out.suggestions).toEqual(["wrap in try/except", "add type check"]);
  });

  it("strips ```json fences", () => {
    const fenced = "```json\n" + JSON.stringify({ verdict: "ship" }) + "\n```";
    const out = parseReasonOutput(fenced);
    expect(out.verdict).toBe("ship");
  });

  it("tolerates prose before/after the JSON", () => {
    const noisy = `Sure, here's my verdict:\n\n${JSON.stringify({
      verdict: "revise",
      rationale: "no",
    })}\n\nLet me know!`;
    const out = parseReasonOutput(noisy);
    expect(out.verdict).toBe("revise");
    expect(out.rationale).toBe("no");
  });

  it("marks unparseable output for retry detection", () => {
    const out = parseReasonOutput("just some prose, no JSON");
    expect(out.verdict).toBe("ship");
    expect(out.confidence).toBe("low");
    expect(out.rationale).toMatch(/No JSON object/i);
  });

  it("marks malformed JSON for retry detection", () => {
    const out = parseReasonOutput('{"verdict": "revise", "rationale": ');
    expect(out.verdict).toBe("ship");
    expect(out.confidence).toBe("low");
    expect(out.rationale).toMatch(/Unbalanced JSON|Sensor JSON parse error/i);
  });

  it("defaults verdict to ship if value is neither ship nor revise", () => {
    const out = parseReasonOutput(JSON.stringify({ verdict: "maybe" }));
    expect(out.verdict).toBe("ship");
  });

  it("ignores invalid missed_cases entries", () => {
    const out = parseReasonOutput(
      JSON.stringify({
        verdict: "revise",
        missed_cases: ["string-not-object", null, { no_what: "x" }, { what: "valid" }],
      }),
    );
    expect(out.missed_cases).toEqual([{ what: "valid" }]);
  });

  it("caps missed_cases and suggestions at 10", () => {
    const lots = Array(20).fill(0).map((_, i) => ({ what: `case ${i}` }));
    const out = parseReasonOutput(
      JSON.stringify({ verdict: "revise", missed_cases: lots, suggestions: lots.map((c) => c.what) }),
    );
    expect(out.missed_cases?.length).toBe(10);
    expect(out.suggestions?.length).toBe(10);
  });

  it("handles JSON containing braces in strings (depth tracking)", () => {
    const out = parseReasonOutput(
      JSON.stringify({ verdict: "revise", rationale: "uses {} in code" }),
    );
    expect(out.verdict).toBe("revise");
    expect(out.rationale).toBe("uses {} in code");
  });
});

describe("formatReasonFeedback", () => {
  it("renders a complete revise feedback block", () => {
    const result: ReasonResult = {
      verdict: "revise",
      confidence: "high",
      rationale: "missing error code",
      missed_cases: [{ what: "E001 not emitted", where: "checks.py" }],
      suggestions: ["add E001 to the new check"],
    };
    const out = formatReasonFeedback(result, 1);
    expect(out).toContain("[Independent reviewer feedback — round 1]");
    expect(out).toContain("Verdict: REVISE (high confidence)");
    expect(out).toContain("Rationale: missing error code");
    expect(out).toContain("- E001 not emitted (checks.py)");
    expect(out).toContain("- add E001 to the new check");
    expect(out).toContain("the reviewer is wrong");
  });

  it("omits missing optional sections gracefully", () => {
    const out = formatReasonFeedback({ verdict: "revise" }, 2);
    expect(out).toContain("round 2");
    expect(out).toContain("Verdict: REVISE");
    expect(out).not.toContain("Missed cases:");
    expect(out).not.toContain("Suggested fixes:");
  });
});
