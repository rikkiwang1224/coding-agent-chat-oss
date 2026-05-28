export { HarnessEngine, type HarnessEngineOptions } from "./harness-engine.js";
export { LlmClient, LlmApiError } from "./api-client.js";
export {
  AgentLoop,
  type AgentLoopCallbacks,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopStopReason,
  type ReasonHookConfig,
  type TokenUsage,
} from "./agent-loop.js";
export {
  runReason,
  formatReasonFeedback,
  parseReasonOutput,
  type ReasonInput,
  type ReasonOptions,
  type ReasonResult,
  type ReasonVerdict,
  type ReasonMissedCase,
} from "./reason.js";
export {
  buildActivityDigest,
  renderActivityDigest,
  type ActivityDigest,
  type DigestEvent,
  type DigestOptions,
} from "./activity-digest.js";
export { PlanExecutor, type Plan, type PlanStep, type PlanExecuteOptions, type PlanExecuteCallbacks } from "./plan-execute.js";
export { ContextCompressor, estimateTokens, findSafeCutIndex } from "./context-compressor.js";
export {
  PermissionGuard,
  DEFAULT_POLICY,
  type PermissionPolicy,
  type PermissionLevel,
  type PermissionCallback,
} from "./permissions.js";
export {
  SessionStore,
  resolveHarnessSessionDir,
  sumSessionRunCosts,
  type SessionData,
  type SessionRunRecord,
} from "./session-store.js";
export {
  createTraceSink,
  type TraceConfig,
  type TraceRecord,
  type TraceSink,
} from "./trace-sink.js";
export type { HarnessHooks, PreToolUseContext, PreToolUseResult, PostToolUseContext } from "./hooks.js";
export {
  TOOL_DEFINITIONS,
  ToolExecutor,
  ShellSession,
  applyEdit,
  type TodoItem,
} from "./tools/index.js";
export { buildSystemPrompt, detectWorkspaceContext, type PromptContext } from "./prompt.js";
export type * from "./types.js";
