import { describe, expect, it } from "vitest";
import {
  buildToolDefinitions,
  CODE_GRAPH_TOOL_DEFINITIONS,
  isCodeGraphDisabled,
} from "../src/code-graph/index.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { buildSystemPrompt } from "../src/prompt.js";

describe("code graph integration", () => {
  it("isCodeGraphDisabled respects FORGELET_CODE_GRAPH=0", () => {
    const prev = process.env.FORGELET_CODE_GRAPH;
    process.env.FORGELET_CODE_GRAPH = "0";
    expect(isCodeGraphDisabled()).toBe(true);
    if (prev === undefined) delete process.env.FORGELET_CODE_GRAPH;
    else process.env.FORGELET_CODE_GRAPH = prev;
  });

  it("buildToolDefinitions merges code graph tools when enabled", () => {
    const without = buildToolDefinitions(false);
    const withGraph = buildToolDefinitions(true);
    expect(without).toHaveLength(TOOL_DEFINITIONS.length);
    expect(withGraph).toHaveLength(TOOL_DEFINITIONS.length + CODE_GRAPH_TOOL_DEFINITIONS.length);
    expect(withGraph.map((t) => t.function.name)).toContain("code_graph_architecture");
    expect(withGraph.map((t) => t.function.name)).toContain("code_graph_search");
  });

  it("buildSystemPrompt includes code graph tools and routing when enabled", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      codeGraphEnabled: true,
    });
    expect(prompt).toContain("code_graph_architecture");
    expect(prompt).toContain("code_graph_search");
    expect(prompt).toContain("Tool routing");
    expect(prompt).toContain("Structural completeness");
    expect(prompt).toContain("Finish with impact");
  });
});
