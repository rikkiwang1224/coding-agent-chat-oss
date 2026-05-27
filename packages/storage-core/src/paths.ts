import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_AGENT_HOME_DIRNAME = ".forgelet";
const SESSION_SNAPSHOT_FILENAME = "snapshot.json";
const SESSIONS_DIRNAME = "sessions";
const WORKSPACE_SESSION_INDEX_FILENAME = "session-index.json";
const WORKSPACE_METADATA_FILENAME = "workspace.json";
const WORKSPACE_THREADS_DIRNAME = "threads";
const TRACES_DIRNAME = "traces";
const RUNS_DIRNAME = "runs";
export type AgentStorageRuntime = "harness";
export type TraceRunKind = "desktop" | "cli" | "eval" | "swe-bench";

export interface WorkspaceSessionIndexEntry {
  sessionId: string;
  updatedAt: string;
  runtime?: AgentStorageRuntime;
  snapshotPath?: string;
  taskId?: string;
  taskStatus?: string;
  recoverable?: boolean;
  lastSummary?: string;
  lastError?: string;
}

export interface WorkspaceSessionIndex {
  workspaceHash: string;
  workspaceRoot: string;
  updatedAt: string;
  sessions: WorkspaceSessionIndexEntry[];
}

export function resolveAgentHome(): string {
  const configuredHome = process.env.FORGELET_HOME?.trim();
  if (configuredHome) {
    return path.resolve(configuredHome);
  }

  return path.join(homedir(), DEFAULT_AGENT_HOME_DIRNAME);
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

export function resolveWorkspaceHash(workspaceRoot: string): string {
  return createHash("sha1").update(normalizeWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 12);
}

export function resolveWorkspaceStorageDir(workspaceRoot: string): string {
  return path.join(resolveAgentHome(), "workspaces", resolveWorkspaceHash(workspaceRoot));
}

export function resolveWorkspaceSessionIndexPath(workspaceRoot: string): string {
  return path.join(resolveWorkspaceStorageDir(workspaceRoot), WORKSPACE_SESSION_INDEX_FILENAME);
}

export function resolveWorkspaceMetadataPath(workspaceRoot: string): string {
  return path.join(resolveWorkspaceStorageDir(workspaceRoot), WORKSPACE_METADATA_FILENAME);
}

export function resolveWorkspaceThreadsDir(workspaceRoot: string): string {
  return path.join(resolveWorkspaceStorageDir(workspaceRoot), WORKSPACE_THREADS_DIRNAME);
}

export function resolveWorkspaceThreadPath(workspaceRoot: string, threadId: string): string {
  return path.join(resolveWorkspaceThreadsDir(workspaceRoot), `${sanitizeStorageSegment(threadId)}.json`);
}

export function resolveForgeletTracesDir(): string {
  const override = process.env.FORGELET_TRACE_ROOT?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveAgentHome(), TRACES_DIRNAME);
}

export function resolveForgeletRunsDir(): string {
  const override = process.env.FORGELET_RUNS_ROOT?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveAgentHome(), RUNS_DIRNAME);
}

/** Harness resume sessions: FORGELET_HOME/sessions/{workspaceHash}/{sessionId}.json */
export function resolveHarnessSessionsDir(workspaceRoot: string): string {
  return path.join(resolveAgentHome(), SESSIONS_DIRNAME, resolveWorkspaceHash(workspaceRoot));
}

export function resolveHarnessSessionPath(workspaceRoot: string, sessionId: string): string {
  return path.join(
    resolveHarnessSessionsDir(workspaceRoot),
    `${sanitizeStorageSegment(sessionId)}.json`,
  );
}

export function resolveDesktopTraceDir(workspaceRoot: string, sessionId: string): string {
  return path.join(
    resolveForgeletTracesDir(),
    "desktop",
    resolveWorkspaceHash(workspaceRoot),
    sanitizeStorageSegment(sessionId),
  );
}

export function resolveCliTraceDir(workspaceRoot: string, sessionId: string): string {
  return path.join(
    resolveForgeletTracesDir(),
    "cli",
    resolveWorkspaceHash(workspaceRoot),
    sanitizeStorageSegment(sessionId),
  );
}

export function resolveEvalRunDir(runId: string): string {
  return path.join(resolveForgeletRunsDir(), "eval", sanitizeStorageSegment(runId));
}

export function resolveEvalTraceDir(runId: string): string {
  return path.join(resolveForgeletTracesDir(), "eval", sanitizeStorageSegment(runId));
}

export function resolveSweBenchRunDir(runId: string): string {
  return path.join(resolveForgeletRunsDir(), "swe-bench", sanitizeRunId(runId));
}

export function resolveSweBenchTraceDir(runId: string): string {
  return path.join(resolveForgeletTracesDir(), "swe-bench", sanitizeRunId(runId));
}

export function resolveSweBenchTraceInstancePath(runId: string, instanceId: string): string {
  return path.join(
    resolveSweBenchTraceDir(runId),
    "instances",
    `${sanitizeStorageSegment(instanceId)}.jsonl`,
  );
}

export function resolveSessionsDir(): string {
  return path.join(resolveAgentHome(), SESSIONS_DIRNAME);
}

function sanitizeRunId(runId: string): string {
  const trimmed = runId.trim();
  if (trimmed.startsWith("eval-")) {
    return sanitizeStorageSegment(trimmed);
  }
  return sanitizeStorageSegment(`eval-${trimmed}`);
}

export function resolveSessionStorageDir(sessionId: string): string {
  return path.join(resolveSessionsDir(), sanitizeStorageSegment(sessionId));
}

export function resolveSessionSnapshotPath(sessionId: string): string {
  return path.join(resolveSessionStorageDir(sessionId), SESSION_SNAPSHOT_FILENAME);
}

export function buildTimestampPrefixedSessionDirName(
  sessionId: string,
  createdAt: string | Date | undefined
): string {
  return `${formatSessionDirectoryTimestamp(createdAt)}_${sanitizeStorageSegment(sessionId)}`;
}

export function resolveTimestampPrefixedSessionStorageDir(
  sessionId: string,
  createdAt: string | Date | undefined
): string {
  return path.join(resolveSessionsDir(), buildTimestampPrefixedSessionDirName(sessionId, createdAt));
}

export function resolveTimestampPrefixedSessionSnapshotPath(
  sessionId: string,
  createdAt: string | Date | undefined
): string {
  return path.join(resolveTimestampPrefixedSessionStorageDir(sessionId, createdAt), SESSION_SNAPSHOT_FILENAME);
}

/** @deprecated Use resolveHarnessSessionsDir — sessions live under FORGELET_HOME, not the repo. */
export function resolveHarnessSessionDir(workspaceRoot: string): string {
  return resolveHarnessSessionsDir(workspaceRoot);
}

export function sanitizeStorageSegment(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "unknown";
}

function formatSessionDirectoryTimestamp(input: string | Date | undefined): string {
  const value = input instanceof Date ? input : input ? new Date(input) : new Date();
  const normalized = Number.isNaN(value.getTime()) ? new Date() : value;
  return normalized.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
