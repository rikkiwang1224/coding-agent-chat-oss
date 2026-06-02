import type { ToolDefinition } from "../types.js";

/** Tools backed by codebase-memory-mcp (only registered when the binary is available). */
export const CODE_GRAPH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "code_graph_architecture",
      description:
        "Get a structural overview of the indexed codebase: languages, packages, entry points, routes, hotspots, layers, clusters. " +
        "Use when entering an unfamiliar or large repo before grep — not for reading source text (use read_file after you pick files).",
      parameters: {
        type: "object",
        properties: {
          aspects: {
            type: "array",
            items: { type: "string" },
            description:
              'Sections to include. Default ["all"]. Examples: ["languages","packages"], ["entry_points","routes"], ["hotspots","clusters"].',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_graph_search",
      description:
        "Search the indexed codebase graph for functions, classes, and methods by name pattern. " +
        "Use for symbols and APIs (e.g. inverse_transform, __exit__) — not for arbitrary strings in files (use grep_search). " +
        "After results, read_file the file_path before editing.",
      parameters: {
        type: "object",
        properties: {
          name_pattern: {
            type: "string",
            description:
              'Regex matched against symbol names (default ".*"). Example: "transform" or "LabelEncoder"',
          },
          label: {
            type: "string",
            description: 'Node label filter: Function, Method, Class, Module, etc.',
          },
          file_pattern: {
            type: "string",
            description: 'Regex to scope to files, e.g. "label\\\\.py" or "sessions"',
          },
          limit: {
            type: "integer",
            description: "Max results (default 50).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_graph_trace",
      description:
        "Trace call relationships for a function or method: who calls it (inbound), what it calls (outbound), or both. " +
        "Use after locating a symbol to understand impact before and after your edit.",
      parameters: {
        type: "object",
        properties: {
          function_name: {
            type: "string",
            description: "Function or method name to trace (as indexed in the graph).",
          },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "both"],
            description: "inbound = callers, outbound = callees, both = default.",
          },
          depth: {
            type: "integer",
            description: "Traversal depth 1-5 (default 3).",
          },
        },
        required: ["function_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_graph_impact",
      description:
        "Analyze uncommitted git changes: map modified files to affected symbols and blast radius. " +
        "Use before declaring done to see if related methods still need the same fix.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
