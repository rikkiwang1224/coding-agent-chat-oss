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

export interface AgentEvent {
  type: AgentEventType;
  sessionId?: string;
  taskId?: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

export type RunState =
  | "idle"
  | "connecting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AppMode = "chat" | "dashboard" | "settings";

export type LlmProvider =
  | "anthropic"
  | "deepseek"
  | "kimi"
  | "glm"
  | "bedrock"
  | "vertex"
  | "custom";

export interface AppSettings {
  general: {
    provider: LlmProvider;
    primaryModel: string;
    lightModel: string;
    apiKey: string;
    baseUrl: string;
  };
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  branch: string;
  threadGroups?: ThreadGroup[];
}

export interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  summary: string;
  time: string;
  placeholder?: string;
  sessionState?: string;
  scope?: string;
  updatedAt: string;
  isLocal?: boolean;
}

export interface LocalThread {
  id: string;
  title: string;
  summary: string;
  placeholder?: string;
  sessionState?: string;
  scope?: string;
  updatedAt: string;
  /** @deprecated threadId === agentSessionId; do not write */
  runSessionIds?: string[];
  messages: SerializedMessage[];
}

export interface SerializedMessage {
  role: MessageRole;
  body: string;
  attachments?: ImageAttachment[];
  toolCalls?: ToolCallInfo[];
  turnCost?: MessageTurnCost;
}

export type MessageRole = "user" | "assistant" | "system" | "error";

export interface MessageTurnCost {
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  body: string;
  attachments: ImageAttachment[];
  toolCalls?: ToolCallInfo[];
  turnCost?: MessageTurnCost;
}

export interface ToolCallInfo {
  id: string;
  toolName: string;
  status: "pending" | "success" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface ImageAttachment {
  id: string;
  path: string;
  name: string;
  mediaType: string;
}

export interface WorkspaceState {
  activeWorkspacePath: string | null;
  workspaces: WorkspaceInfo[];
}

export interface TraceSummary {
  sessionId: string;
  workspaceRoot: string;
  workspaceName: string;
  title?: string;
  startedAt?: string;
  eventCount: number;
  runCount: number;
  totalCostUsd?: number;
  lastEventAt?: string;
  fileSizeBytes: number;
}

export interface TraceManifest {
  schemaVersion: number;
  runKind: string;
  runId: string;
  workspaceRoot: string;
  traceFile?: string;
  startedAt: string;
}

export interface StoredTraceRecord {
  schemaVersion: number;
  runKind: string;
  runId: string;
  workspaceRoot: string;
  instanceId?: string;
  event: AgentEvent;
}

export interface DesktopTraceDetail {
  manifest: TraceManifest | null;
  records: StoredTraceRecord[];
}

export interface DesktopConfig {
  appName: string;
  getWorkspaceState: () => Promise<WorkspaceState>;
  pickWorkspace: () => Promise<WorkspaceState>;
  pickImages: () => Promise<ImageAttachment[]>;
  pasteClipboardImage: () => Promise<{
    attachment?: ImageAttachment | null;
    debug?: Record<string, unknown>;
  }>;
  savePastedImage: (input: {
    dataUrl: string;
    name?: string;
    mediaType?: string;
  }) => Promise<ImageAttachment | null>;
  setActiveWorkspace: (workspacePath: string) => Promise<WorkspaceState>;
  getStoredThreads: (workspacePath: string) => Promise<LocalThread[]>;
  loadSessionThread: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<{
    id: string;
    title: string;
    summary: string;
    updatedAt: string;
    messages: SerializedMessage[];
    runs?: Array<{
      turnIndex: number;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }>;
    totalCostUsd?: number;
  } | null>;
  saveStoredThread: (workspacePath: string, thread: LocalThread) => Promise<LocalThread>;
  deleteStoredThread: (workspacePath: string, threadId: string) => Promise<void>;
  startRun: (input: {
    prompt?: string;
    workspaceRoot?: string;
    sessionId?: string;
    threadContext?: string;
    imageAttachments?: unknown[];
    runMode?: "run" | "resume";
  }) => Promise<{ sessionId?: string }>;
  resumeRun: DesktopConfig["startRun"];
  /** Abort the currently-running agent for this window. No-op when idle. */
  cancelRun: () => Promise<{ ok: boolean }>;
  respondPermission: (
    requestId: string,
    outcome: "allow_once" | "allow_always" | "deny",
  ) => Promise<boolean>;
  onAgentEvent: (listener: (event: AgentEvent) => void) => void;
  debugPing: () => Promise<{
    ok: boolean;
    timestamp: string;
    capabilities?: { storedThreads?: boolean; legacyThreadImport?: boolean };
  }>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: AppSettings) => Promise<{ ok: boolean }>;
  listTraces: (workspacePath?: string) => Promise<TraceSummary[]>;
  listAllTraces: () => Promise<TraceSummary[]>;
  loadTrace: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<DesktopTraceDetail | null>;
}

declare global {
  interface Window {
    desktopConfig?: Partial<DesktopConfig>;
  }
}
