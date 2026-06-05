export {
  CodebaseMemoryClient,
  resolveCodebaseMemoryBinary,
  isCodeGraphDisabled,
  type CodebaseMemoryCliResult,
} from "./codebase-memory.js";
export { CODE_GRAPH_TOOL_DEFINITIONS } from "./definitions.js";
export {
  normalizeSearchCodeScope,
  normalizeSearchGraphFilePattern,
  sanitizeSearchGraphNamePattern,
  splitAlternatives,
  splitAndCleanCodeSearchQuery,
} from "./patterns.js";

import { CODE_GRAPH_TOOL_DEFINITIONS } from "./definitions.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import type { ToolDefinition } from "../types.js";

/**
 * When code graph is available, replace overlapping basic tools with their
 * graph-powered equivalents to reduce the agent's choice surface:
 *   - grep_search → code_graph_code_search (graph-augmented, returns context)
 *   - list_directory removed (architecture module map replaces manual traversal)
 *
 * grep_search and list_directory still WORK (executor handles them), they're
 * just not advertised to the model so it won't pick them over graph tools.
 */
const TOOLS_HIDDEN_WHEN_GRAPH_ENABLED = new Set(["grep_search", "list_directory"]);

export function buildToolDefinitions(codeGraphEnabled: boolean): ToolDefinition[] {
  if (!codeGraphEnabled) return TOOL_DEFINITIONS;
  const base = TOOL_DEFINITIONS.filter(
    (t) => !TOOLS_HIDDEN_WHEN_GRAPH_ENABLED.has(t.function.name),
  );
  return [...base, ...CODE_GRAPH_TOOL_DEFINITIONS];
}
