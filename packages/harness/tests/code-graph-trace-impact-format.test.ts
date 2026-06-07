import { describe, it, expect } from "vitest";
import { formatTraceResult, formatImpactResult } from "../src/tools/executor.js";

describe("formatTraceResult (P6)", () => {
  it("renders inbound callers compactly with qualified names", () => {
    // Exact shape captured from real codebase-memory-mcp trace output.
    const parsed = {
      function: "get_class_members",
      direction: "inbound",
      callers: [
        { name: "get_object_members", qualified_name: "testbed.sphinx.ext.autodoc.ClassDocumenter.get_object_members", hop: 1 },
      ],
    };
    const out = formatTraceResult(parsed, "raw");
    expect(out).toContain("Trace get_class_members (inbound):");
    expect(out).toContain("callers (1):");
    expect(out).toContain("[hop 1] get_object_members");
    expect(out).toContain("[testbed.sphinx.ext.autodoc.ClassDocumenter.get_object_members]");
    expect(out).not.toContain("{"); // no raw JSON
  });

  it("renders outbound callees", () => {
    const parsed = {
      function: "get_quantity_scale_factor",
      direction: "outbound",
      callees: [
        { name: "get_dimension_system", qualified_name: "testbed.sympy.physics.units.unitsystem.UnitSystem.get_dimension_system", hop: 1 },
      ],
    };
    const out = formatTraceResult(parsed, "raw");
    expect(out).toContain("callees (1):");
    expect(out).toContain("get_dimension_system");
  });

  it("reports when there are no call relationships", () => {
    const out = formatTraceResult({ function: "foo", direction: "both", callers: [], callees: [] }, "raw");
    expect(out).toBe("Trace foo (both): no call relationships found.");
  });

  it("falls back to raw output on an unexpected shape", () => {
    expect(formatTraceResult("not an object", "RAW")).toBe("RAW");
  });
});

describe("formatImpactResult (P6)", () => {
  it("summarizes changed files and impacted symbols compactly", () => {
    const parsed = {
      changed_files: ["sympy/parsing/mathematica.py"],
      changed_count: 1,
      depth: 2,
      impacted_symbols: [
        { name: "mathematica", label: "Function", file: "sympy/parsing/mathematica.py" },
        { name: "parse_mathematica", label: "Function", file: "sympy/parsing/mathematica.py" },
      ],
    };
    const out = formatImpactResult(parsed, "raw");
    expect(out).toContain("Impact (depth 2): 1 changed file(s):");
    expect(out).toContain("sympy/parsing/mathematica.py");
    expect(out).toContain("Impacted symbols (2):");
    expect(out).toContain("mathematica  (Function)");
    expect(out).not.toContain("{");
  });

  it("caps long symbol lists", () => {
    const symbols = Array.from({ length: 50 }, (_, i) => ({ name: `s${i}`, label: "Function", file: "f.py" }));
    const out = formatImpactResult({ changed_files: ["f.py"], impacted_symbols: symbols }, "raw");
    expect(out).toContain("Impacted symbols (50):");
    expect(out).toContain("... and 20 more");
  });

  it("reports when there are no uncommitted changes", () => {
    expect(formatImpactResult({ changed_files: [], impacted_symbols: [] }, "raw")).toBe(
      "Impact: no uncommitted changes detected.",
    );
  });

  it("falls back to raw output on an unexpected shape", () => {
    expect(formatImpactResult(42, "RAW")).toBe("RAW");
  });
});
