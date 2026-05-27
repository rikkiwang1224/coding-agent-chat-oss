import type { ToolExecutionResult } from "./tools/executor.js";

export interface PreToolUseContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

export interface PreToolUseResult {
  allow: boolean;
  args?: Record<string, unknown>;
  reason?: string;
}

export interface PostToolUseContext {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  sessionId?: string;
}

export interface HarnessHooks {
  preToolUse?: (ctx: PreToolUseContext) => Promise<PreToolUseResult | void>;
  postToolUse?: (ctx: PostToolUseContext) => Promise<void>;
}
