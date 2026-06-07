import { describe, it, expect } from "vitest";
import { buildArchitectureSummary } from "../src/tools/executor.js";

describe("buildArchitectureSummary — module detection", () => {
  it("surfaces snake_case Python packages from the `packages` field (django/sympy shape)", () => {
    // Shape mirrors a real `get_architecture` response (verified against the
    // codebase-memory-mcp CLI on a Python repo): `packages` ranked by node_count.
    const raw = {
      total_nodes: 45481,
      total_edges: 217043,
      languages: [{ language: "Python", file_count: 2668 }],
      packages: [
        { name: "django", node_count: 4000, fan_in: 0 },
        { name: "tests", node_count: 3000, fan_in: 0 },
        { name: "test_autodetector", node_count: 240, fan_in: 0 },
        { name: "docs", node_count: 120, fan_in: 0 },
        { name: "setup", node_count: 8, fan_in: 0 },
        { name: "forms", node_count: 90, fan_in: 0 },
      ],
    };
    const out = buildArchitectureSummary(raw);
    expect(out).toContain("## Detected business modules");
    // Real source packages are surfaced as file_pattern values…
    expect(out).toMatch(/"django"/);
    expect(out).toMatch(/"forms"/);
    // …and test / infra packages are filtered out.
    expect(out).not.toMatch(/"tests"/);
    expect(out).not.toMatch(/"test_autodetector"/);
    expect(out).not.toMatch(/"docs"/);
    expect(out).not.toMatch(/"setup"/);
  });

  it("ranks modules by symbol count (largest first)", () => {
    const raw = {
      packages: [
        { name: "small", node_count: 5 },
        { name: "huge", node_count: 900 },
        { name: "medium", node_count: 50 },
      ],
    };
    const out = buildArchitectureSummary(raw);
    const order = ["huge", "medium", "small"].map((n) => out.indexOf(`"${n}"`));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("falls back to the file_tree heuristic when `packages` is absent (kebab-case frontend repo)", () => {
    const raw = {
      file_tree: [
        { path: "src", type: "dir", children: 4 },
        { path: "src/purchase-order", type: "dir", children: 12 },
        { path: "src/purchase-request", type: "dir", children: 8 },
        { path: "src/tests", type: "dir", children: 20 },
      ],
    };
    const out = buildArchitectureSummary(raw);
    expect(out).toContain("## Detected business modules");
    expect(out).toMatch(/"purchase-order"/);
    expect(out).toMatch(/"purchase-request"/);
    expect(out).not.toMatch(/"tests"/);
  });

  it("warns when neither packages nor file_tree are available", () => {
    const out = buildArchitectureSummary({ total_nodes: 1 });
    expect(out).toContain("Module map unavailable");
  });
});
