import { describe, expect, it } from "vitest";
import {
  buildToolDefinitions,
  CODE_GRAPH_TOOL_DEFINITIONS,
  isCodeGraphDisabled,
  normalizeSearchCodeScope,
  normalizeSearchGraphFilePattern,
  sanitizeSearchGraphNamePattern,
  splitAndCleanCodeSearchQuery,
  TOOLS_HIDDEN_WHEN_GRAPH_ENABLED,
} from "../src/code-graph/index.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import {
  buildArchitectureSummary,
  formatGraphSearchResults,
  formatCodeSearchResults,
  formatSnippetResult,
} from "../src/tools/executor.js";
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
    expect(withGraph).toHaveLength(
      TOOL_DEFINITIONS.length - TOOLS_HIDDEN_WHEN_GRAPH_ENABLED.size + CODE_GRAPH_TOOL_DEFINITIONS.length,
    );
    expect(withGraph.map((t) => t.function.name)).toContain("codebase_overview");
    expect(withGraph.map((t) => t.function.name)).toContain("symbol_search");
    expect(withGraph.map((t) => t.function.name)).toContain("text_search");
    expect(withGraph.map((t) => t.function.name)).toContain("call_trace");
    expect(withGraph.map((t) => t.function.name)).toContain("change_impact");
    // Legacy names no longer registered as tool definitions
    expect(withGraph.map((t) => t.function.name)).not.toContain("code_graph_architecture");
    expect(withGraph.map((t) => t.function.name)).not.toContain("code_graph_search");
    expect(withGraph.map((t) => t.function.name)).not.toContain("code_graph_code_search");
    expect(withGraph.map((t) => t.function.name)).not.toContain("code_graph_snippet");
    expect(withGraph.map((t) => t.function.name)).not.toContain("code_graph_semantic_search");
    // read_file should have qualified_name parameter
    const readFileDef = withGraph.find((t) => t.function.name === "read_file");
    expect(readFileDef?.function.parameters.properties).toHaveProperty("qualified_name");
  });

  it("buildSystemPrompt includes code graph tools and routing when enabled", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      codeGraphEnabled: true,
    });
    expect(prompt).toContain("codebase_overview");
    expect(prompt).toContain("symbol_search");
    expect(prompt).toContain("text_search");
    expect(prompt).toContain("call_trace");
    expect(prompt).toContain("change_impact");
    expect(prompt).toContain("qualified_name");
    // No legacy code_graph_* names in prompt
    expect(prompt).not.toContain("code_graph_");
    expect(prompt).toContain("Search tool routing");
    expect(prompt).toContain("3 orthogonal search tools");
    expect(prompt).toContain("Structural completeness");
    expect(prompt).toContain("Finish with impact");
    expect(prompt).toContain("BM25");
  });

  it("normalizeSearchGraphFilePattern wraps module names for SQL LIKE", () => {
    expect(normalizeSearchGraphFilePattern("purchase-order")).toBe("%purchase-order%");
    expect(normalizeSearchGraphFilePattern("%purchase-order%")).toBe("%purchase-order%");
    expect(normalizeSearchGraphFilePattern(".*purchase-order.*")).toBe("%purchase-order%");
    // Multi-segment regex: all .* / .+ become %
    expect(normalizeSearchGraphFilePattern(".*foo.*bar.*")).toBe("%foo%bar%");
    expect(normalizeSearchGraphFilePattern(".*download.+template.*")).toBe("%download%template%");
    // Anchored regex
    expect(normalizeSearchGraphFilePattern("^purchase-order$")).toBe("%purchase-order%");
  });

  it("normalizeSearchCodeScope maps module names to globs or path", () => {
    expect(normalizeSearchCodeScope("purchase-order")).toEqual({ file_pattern: "*purchase-order*" });
    expect(normalizeSearchCodeScope("domains/scm-execution/src/modules/pms/purchase-order")).toEqual({
      file_pattern: "**/domains/scm-execution/src/modules/pms/purchase-order/**",
    });
    expect(normalizeSearchCodeScope("purchase-order/views/list")).toEqual({
      file_pattern: "**/purchase-order/views/list/**",
    });
    expect(normalizeSearchCodeScope("purchase-order/views/list/")).toEqual({
      file_pattern: "**/purchase-order/views/list/**",
    });
    expect(normalizeSearchCodeScope("pr-list.vue")).toEqual({ file_pattern: "*pr-list.vue*" });
    expect(normalizeSearchCodeScope("*.vue")).toEqual({ file_pattern: "*.vue" });
  });

  it("sanitizeSearchGraphNamePattern strips unsupported (?i) flag", () => {
    expect(sanitizeSearchGraphNamePattern("(?i)downloadTemplate")).toBe("downloadTemplate");
  });

  it("splitAndCleanCodeSearchQuery splits on | and strips regex", () => {
    expect(splitAndCleanCodeSearchQuery("downloadTemplate")).toEqual(["downloadTemplate"]);
    expect(splitAndCleanCodeSearchQuery("download|template")).toEqual(["download", "template"]);
    expect(splitAndCleanCodeSearchQuery("downloadTemplate|download.*template|down.*tmp|模板")).toEqual([
      "downloadTemplate",
      "downloadtemplate",
      "downtmp",
      "模板",
    ]);
    expect(splitAndCleanCodeSearchQuery("download.*template")).toEqual(["downloadtemplate"]);
    expect(splitAndCleanCodeSearchQuery("  |  |  ")).toEqual([]);
  });

  it("buildArchitectureSummary extracts module map and business modules", () => {
    const summary = buildArchitectureSummary({
      total_nodes: 100,
      total_edges: 200,
      languages: [{ language: "TypeScript", file_count: 42 }],
      file_tree: [
        { path: "src/purchase-order", type: "dir", children: 12 },
        { path: "src/purchase-order/handler.ts", type: "file" },
      ],
      hotspots: [{ name: "processOrder", fan_in: 12, qualified_name: "proj.src.handler.processOrder" }],
    });
    expect(summary).toContain("Project overview");
    expect(summary).toContain("purchase-order");
    expect(summary).toContain("Detected business modules");
    expect(summary).toContain("processOrder");
  });

  it("buildSystemPrompt includes few-shot example when codeGraphEnabled", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/ws",
      codeGraphEnabled: true,
    });
    expect(prompt).toContain("Example trajectory");
    expect(prompt).toContain("symbol_search(name_pattern=");
    expect(prompt).toContain('read_file(qualified_name=');
    expect(prompt).toContain("2 tool calls");
  });
});

describe("graph output formatters", () => {
  it("formatGraphSearchResults formats to grep-like output", () => {
    const parsed = {
      total: 2,
      has_more: false,
      results: [
        {
          name: "downloadTemplate",
          qualified_name: "proj.utils.downloadFile.downloadTemplate",
          file_path: "utils/downloadFile.js",
          line: 18,
          label: "Function",
        },
        {
          name: "handleDownLoadASNTemplate",
          qualified_name: "proj.views.pr-list.handleDownLoadASNTemplate",
          file_path: "views/pr-list.vue",
          line: 245,
          label: "Function",
        },
      ],
    };
    const output = formatGraphSearchResults(parsed, "raw");
    expect(output).toContain("Found 2 result(s):");
    expect(output).toContain("utils/downloadFile.js:18: downloadTemplate  (Function)");
    expect(output).toContain("views/pr-list.vue:245: handleDownLoadASNTemplate  (Function)");
    expect(output).toContain("[proj.utils.downloadFile.downloadTemplate]");
  });

  it("formatGraphSearchResults handles empty results", () => {
    const parsed = { total: 0, results: [] };
    const output = formatGraphSearchResults(parsed, "raw");
    expect(output).toContain("No results found");
  });

  it("formatGraphSearchResults omits line number when 0", () => {
    const parsed = {
      total: 1,
      results: [
        { name: "foo", file_path: "src/foo.ts", line: 0, label: "Function" },
      ],
    };
    const output = formatGraphSearchResults(parsed, "raw");
    expect(output).toContain("src/foo.ts: foo  (Function)");
    expect(output).not.toContain(":0:");
  });

  it("formatGraphSearchResults falls back to raw on non-object", () => {
    expect(formatGraphSearchResults(null, "raw fallback")).toBe("raw fallback");
    expect(formatGraphSearchResults(undefined, "raw fallback")).toBe("raw fallback");
  });

  it("formatCodeSearchResults formats to grep-like output", () => {
    const parsed = {
      total_results: 1,
      results: [
        {
          file: "utils/downloadFile.js",
          start_line: 18,
          snippet: "export function downloadTemplate(baseUrl, fileName) {",
          function_name: "downloadTemplate",
        },
      ],
    };
    const output = formatCodeSearchResults(parsed, "raw");
    expect(output).toContain("Found 1 match(es):");
    expect(output).toContain("utils/downloadFile.js:18: export function downloadTemplate");
    expect(output).toContain("(in downloadTemplate)");
  });

  it("formatCodeSearchResults handles empty results", () => {
    const parsed = { total_results: 0, results: [] };
    const output = formatCodeSearchResults(parsed, "raw");
    expect(output).toBe("No matches found.");
  });

  it("formatSnippetResult formats to read_file-style numbered lines", () => {
    const parsed = {
      qualified_name: "proj.utils.downloadFile.downloadTemplate",
      file_path: "utils/downloadFile.js",
      start_line: 18,
      code: "export function downloadTemplate(baseUrl, fileName) {\n  window.open(baseUrl + fileName);\n}",
    };
    const output = formatSnippetResult(parsed, "raw");
    expect(output).toContain("--- utils/downloadFile.js ---");
    expect(output).toContain("    18|export function downloadTemplate(baseUrl, fileName) {");
    expect(output).toContain("    19|  window.open(baseUrl + fileName);");
    expect(output).toContain("    20|}");
  });

  it("formatSnippetResult falls back to raw when no code field", () => {
    const parsed = { qualified_name: "foo" };
    expect(formatSnippetResult(parsed, "raw fallback")).toBe("raw fallback");
  });

  it("formatCodeSearchResults omits line number when 0", () => {
    const parsed = {
      total_results: 1,
      results: [
        { file: "src/foo.ts", start_line: 0, snippet: "const x = 1;", function_name: "init" },
      ],
    };
    const output = formatCodeSearchResults(parsed, "raw");
    expect(output).toContain("src/foo.ts: const x = 1;  (in init)");
    expect(output).not.toContain(":0:");
  });
});
