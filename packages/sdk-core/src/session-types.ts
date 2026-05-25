import type {
  AgentLoopStage,
  AgentRunMetrics,
  AgentRunMode,
  AgentToolEvent,
  AgentTaskStatus,
  AgentTerminalReason,
  AgentVerification
} from "@forgelet/shared-types";

export interface AgentSessionHistoryEvent {
  title: string;
  detail: string;
  timestamp?: string;
  tone?: "info" | "success" | "danger";
}

export interface AgentSessionResumeState {
  runMode?: AgentRunMode;
  lastCompletedStage?: AgentLoopStage;
  lastTurnIndex?: number;
  nextTurnIndex?: number;
  terminalReason?: AgentTerminalReason;
  lastSummaryDraft?: string;
}

export interface AgentSessionSnapshot {
  sessionId: string;
  sdkSessionId?: string;
  workspaceRoot: string;
  createdAt?: string;
  taskId?: string;
  taskStatus?: AgentTaskStatus;
  recoverable?: boolean;
  originalPrompt?: string;
  transcriptEntries: string[];
  historyEvents: AgentSessionHistoryEvent[];
  toolEvents: AgentToolEvent[];
  resumeState?: AgentSessionResumeState;
  updatedAt: string;
  lastSummary?: string;
  lastError?: string;
  verification?: AgentVerification;
  metrics?: AgentRunMetrics;
}

export interface AgentSessionLookup {
  clientSessionId: string;
  sdkSessionId: string;
  workspaceRoot: string;
  updatedAt: string;
  taskId?: string;
  status?: AgentTaskStatus;
  lastSummary?: string;
  lastError?: string;
}
