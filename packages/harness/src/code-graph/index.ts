export {
  CodebaseMemoryClient,
  resolveCodebaseMemoryBinary,
  isCodeGraphDisabled,
  type CodebaseMemoryCliResult,
} from "./codebase-memory.js";
export { CODE_GRAPH_TOOL_DEFINITIONS } from "./definitions.js";

import { CODE_GRAPH_TOOL_DEFINITIONS } from "./definitions.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import type { ToolDefinition } from "../types.js";

export function buildToolDefinitions(codeGraphEnabled: boolean): ToolDefinition[] {
  if (!codeGraphEnabled) return TOOL_DEFINITIONS;
  return [...TOOL_DEFINITIONS, ...CODE_GRAPH_TOOL_DEFINITIONS];
}
