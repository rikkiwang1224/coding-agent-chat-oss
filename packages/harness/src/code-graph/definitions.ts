import type { ToolDefinition } from "../types.js";

/** Tools backed by codebase-memory-mcp (only registered when the binary is available). */
export const CODE_GRAPH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "codebase_overview",
      description:
        "Get a module map of the indexed codebase: business modules with file counts, key symbols, entry points, routes. " +
        "Returns a 'Detected business modules' section listing module names you can pass as file_pattern to symbol_search. " +
        "ALWAYS use this first on an unfamiliar repo, then extract the relevant module name and use symbol_search(file_pattern=<module>) to narrow down.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "symbol_search",
      description:
        "Search the indexed codebase for functions, classes, methods, and variables by SYMBOL NAME and file location. " +
        "Also handles natural language queries: when structural search yields no results it automatically falls back to BM25 keyword matching. " +
        "Best used AFTER codebase_overview: take a module name from the module map and pass it as file_pattern to scope your search. " +
        "name_pattern matches symbol names (function/variable/class names), NOT file paths, route strings, or URL patterns. " +
        "For route/URL lookup (e.g. '/purchase/order/pending'), use text_search instead. " +
        "Examples: symbol_search(file_pattern=\"purchase-request\", name_pattern=\"status|Status\") to find status definitions. " +
        "symbol_search(file_pattern=\"purchase-order\", label=\"File\") to list all files in the module. " +
        "symbol_search(name_pattern=\"download template xlsx\") for natural language when you don't know exact symbol names. " +
        "After results, read_file the file_path before editing.",
      parameters: {
        type: "object",
        properties: {
          name_pattern: {
            type: "string",
            description:
              'Regex matched against symbol names (default ".*"). Also accepts natural language keywords — BM25 fallback kicks in automatically. Example: "transform", "Status", "download template xlsx"',
          },
          label: {
            type: "string",
            description: 'Node label filter: Function, Method, Class, Module, Variable, File, etc.',
          },
          file_pattern: {
            type: "string",
            description:
              'Module or path substring to scope files (auto-wrapped as SQL LIKE). Example: "purchase-order" matches paths containing that segment.',
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
      name: "call_trace",
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
      name: "change_impact",
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
  {
    type: "function",
    function: {
      name: "text_search",
      description:
        "Graph-augmented text search over indexed files. Like grep but only searches indexed project files " +
        "(skips node_modules, dist, etc.) and returns results with graph context (which function/class the match is in). " +
        "Use for finding string literals, route paths, config values, error messages, or comments. " +
        "Supports regex patterns — if text search yields no results, automatically retries with regex. " +
        "If file_pattern is too narrow and yields nothing, automatically broadens the scope.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text or regex pattern to search for in source code.",
          },
          file_pattern: {
            type: "string",
            description:
              'Module substring or glob to scope files (auto-wrapped as *pattern*). Example: "purchase-order" or "*.vue". Use "route|router" for alternates.',
          },
          limit: {
            type: "integer",
            description: "Max results (default 20).",
          },
        },
        required: ["query"],
      },
    },
  },
];
