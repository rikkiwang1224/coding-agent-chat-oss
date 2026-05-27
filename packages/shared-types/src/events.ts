import type { AgentToolMetadata, PermissionDecision } from "./tools.js";

export type AgentEventType =
  | "agent.started"
  | "agent.progress"
  | "agent.delta"
  | "tool.called"
  | "tool.output"
  | "tool.error"
  | "tool.permission_request"
  | "tool.permission_resolved"
  | "agent.done"
  | "agent.error";

export interface AgentEvent<TPayload = unknown> {
  type: AgentEventType;
  sessionId: string;
  taskId: string;
  timestamp: string;
  payload: TPayload;
}

export type AgentTaskStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunMode = "run" | "resume" | "retry";
export type AgentLoopStage = "plan" | "execute" | "verify" | "summarize";
export type AgentContinueReason = "needs_follow_up" | "tool_failure_recoverable";
export interface AgentImageAttachment {
  path: string;
  mediaType: string;
}

export type AgentTerminalReason =
  | "completed"
  | "tool_failure_recoverable"
  | "cancelled"
  | "failed_terminal"
  | "prompt_too_long";

export interface AgentToolFailure {
  toolName: string;
  summary: string;
  decision?: PermissionDecision;
}

export interface AgentVerification {
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  filesRead: string[];
  filesWritten: string[];
  searchQueries: string[];
  commandsRun: string[];
  failures: AgentToolFailure[];
  evidenceBasis: string[];
  verificationMessage: string;
}

export interface AgentStartedPayload {
  prompt: string;
  status?: Extract<AgentTaskStatus, "running">;
  recoverable?: boolean;
  runMode?: AgentRunMode;
}

export interface AgentProgressPayload {
  stage: AgentLoopStage;
  message: string;
  status?: Extract<AgentTaskStatus, "running">;
  recoverable?: boolean;
  reason?: AgentContinueReason;
}

export interface AgentDeltaPayload {
  delta: string;
}

export interface ToolCalledPayload {
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  metadata?: AgentToolMetadata;
}

export interface ToolOutputPayload {
  toolCallId?: string;
  toolName: string;
  output: string;
}

export interface ToolErrorPayload {
  toolCallId?: string;
  toolName: string;
  error: string;
  decision?: PermissionDecision;
}

export type PermissionRequestOutcome = "allow_once" | "allow_always" | "deny";

export interface ToolPermissionRequestPayload {
  requestId: string;
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  decision: Extract<PermissionDecision, "ask">;
}

export interface ToolPermissionResolvedPayload {
  requestId: string;
  outcome: PermissionRequestOutcome;
}

export interface AgentToolCalledEvent {
  type: "tool.called";
  timestamp?: string;
  toolName: string;
  args: Record<string, unknown>;
  metadata?: AgentToolMetadata;
  truncated?: boolean;
}

export interface AgentToolOutputEvent {
  type: "tool.output";
  timestamp?: string;
  toolName: string;
  output: string;
  truncated?: boolean;
}

export interface AgentToolErrorEvent {
  type: "tool.error";
  timestamp?: string;
  toolName: string;
  error: string;
  decision?: PermissionDecision;
  truncated?: boolean;
}

export type AgentToolEvent =
  | AgentToolCalledEvent
  | AgentToolOutputEvent
  | AgentToolErrorEvent;

export interface AgentDonePayload {
  summary: string;
  diff?: string;
  metrics?: AgentRunMetrics;
  status?: Extract<AgentTaskStatus, "completed">;
  recoverable?: boolean;
  verification?: AgentVerification;
  terminalReason?: Extract<AgentTerminalReason, "completed">;
}

export interface AgentErrorPayload {
  error: string;
  status?: Exclude<AgentTaskStatus, "running" | "completed">;
  recoverable?: boolean;
  metrics?: AgentRunMetrics;
  verification?: AgentVerification;
  terminalReason?: Exclude<AgentTerminalReason, "completed">;
  recoverableReason?: AgentContinueReason;
}

export interface AgentModelUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

export interface AgentRunMetrics {
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /** Estimated cost for this run only (USD) */
  totalCostUsd?: number;
  /** Token usage for this run only */
  runInputTokens?: number;
  runOutputTokens?: number;
  /** Session cumulative cost after this run (USD) */
  sessionTotalCostUsd?: number;
  /** Session cumulative token usage */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  primaryModel?: string;
  modelUsage?: Record<string, AgentModelUsageMetrics>;
}
