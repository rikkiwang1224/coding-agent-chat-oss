import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveSessionSnapshotPath,
  resolveWorkspaceSessionIndexPath,
  resolveWorkspaceThreadPath,
  resolveWorkspaceThreadsDir,
  type WorkspaceSessionIndex,
} from "@forgelet/storage-core";
import { collapseText, truncateText, isRecord } from "../utils/text.js";
import { readImageAttachments, type ChatDesktopImageAttachment } from "../utils/image.js";

// ── Types ──

export interface ChatDesktopStoredToolCall {
  id: string;
  toolName: string;
  status: "pending" | "success" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface ChatDesktopStoredMessage {
  role: string;
  body: string;
  attachments?: ChatDesktopImageAttachment[];
  toolCalls?: ChatDesktopStoredToolCall[];
}

export interface ChatDesktopStoredThread {
  id: string;
  title: string;
  summary: string;
  placeholder: string;
  sessionState: string;
  scope: string;
  updatedAt: string;
  runSessionIds: string[];
  messages: ChatDesktopStoredMessage[];
}

export interface ChatDesktopThreadSummary {
  id: string;
  title: string;
  summary: string;
  time: string;
  placeholder: string;
  sessionState: string;
  scope: string;
  updatedAt: string;
}

export interface ChatDesktopThreadGroup {
  label: string;
  threads: ChatDesktopThreadSummary[];
}

// ── Normalizers ──

function isStoredMessage(value: unknown): value is ChatDesktopStoredMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== "string" || typeof record.body !== "string") return false;
  const att = record.attachments;
  if (att != null && !Array.isArray(att)) return false;
  const tc = record.toolCalls;
  return tc == null || Array.isArray(tc);
}

function normalizeStoredThread(input: unknown): ChatDesktopStoredThread | null {
  if (!isRecord(input)) return null;

  const id = collapseText(input.id);
  const updatedAt = collapseText(input.updatedAt) || new Date().toISOString();
  if (!id) return null;

  return {
    id,
    title: collapseText(input.title) || "New thread",
    summary: collapseText(input.summary) || "New thread",
    placeholder: collapseText(input.placeholder) || "Continue the conversation",
    sessionState: collapseText(input.sessionState) || "Ready for follow-up",
    scope: collapseText(input.scope) || "Workspace root",
    updatedAt,
    runSessionIds: Array.isArray(input.runSessionIds)
      ? input.runSessionIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
      : [],
    messages: Array.isArray(input.messages)
      ? input.messages.filter(isStoredMessage).map((m) => ({
          role: m.role,
          body: m.body,
          attachments: readImageAttachments(m.attachments),
          toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : undefined,
        }))
      : [],
  };
}

// ── CRUD ──

export async function listStoredThreads(workspacePath: string): Promise<ChatDesktopStoredThread[]> {
  const directory = resolveWorkspaceThreadsDir(workspacePath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const threads: ChatDesktopStoredThread[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(directory, entry.name), "utf8");
      const parsed = normalizeStoredThread(JSON.parse(raw));
      if (parsed) threads.push(parsed);
    } catch {
      continue;
    }
  }

  return threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function saveStoredThread(workspacePath: string, thread: unknown): Promise<ChatDesktopStoredThread> {
  const normalized = normalizeStoredThread(thread);
  if (!normalized) throw new Error("Invalid thread payload");

  const target = resolveWorkspaceThreadPath(workspacePath, normalized.id);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

export async function deleteStoredThread(workspacePath: string, threadId: string): Promise<void> {
  if (!workspacePath || !threadId) return;
  const resolvedPath = path.resolve(workspacePath);

  // Remove from threads directory
  const target = resolveWorkspaceThreadPath(resolvedPath, threadId);
  try {
    await unlink(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Also remove from workspace session index (session-snapshot based threads)
  const indexPath = resolveWorkspaceSessionIndexPath(resolvedPath);
  try {
    const raw = await readFile(indexPath, "utf8");
    const index = JSON.parse(raw) as WorkspaceSessionIndex;
    const filtered = index.sessions.filter((s) => s.sessionId !== threadId);
    if (filtered.length !== index.sessions.length) {
      await writeFile(indexPath, JSON.stringify({ ...index, sessions: filtered }, null, 2), "utf8");
    }
  } catch {
    // Index missing or malformed — nothing to clean up
  }
}

export async function importLegacyThreads(payload: unknown): Promise<void> {
  if (!isRecord(payload)) return;

  for (const [workspacePath, threads] of Object.entries(payload)) {
    if (!workspacePath || !Array.isArray(threads)) continue;
    const normalizedWorkspacePath = path.resolve(workspacePath);
    for (const thread of threads) {
      try {
        await saveStoredThread(normalizedWorkspacePath, thread);
      } catch {
        continue;
      }
    }
  }
}

// ── Session thread loading ──

interface LoadedSessionMessage {
  role: "user" | "assistant" | "system" | "error";
  body: string;
  toolCalls?: ChatDesktopStoredToolCall[];
}

export interface LoadedSessionThread {
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
  sdkSessionId?: string;
  messages: LoadedSessionMessage[];
}

const TRANSCRIPT_ROLE_PATTERN = /^\[([\dT:.Z-]+)\]\s+(User|Assistant|System):\n?/;

interface TimestampedMessage {
  timestamp: string;
  role: "user" | "assistant" | "system";
  body: string;
}

function extractUserRequest(rawPrompt: unknown): string {
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt) return "";

  const marker = "[USER_REQUEST]";
  const idx = prompt.lastIndexOf(marker);
  return idx < 0 ? prompt : prompt.slice(idx + marker.length).trim();
}

function parseTranscriptWithTimestamps(entries: unknown[]): TimestampedMessage[] {
  const messages: TimestampedMessage[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const match = entry.match(TRANSCRIPT_ROLE_PATTERN);
    if (!match) continue;
    const timestamp = match[1];
    const label = match[2].toLowerCase() as "user" | "assistant" | "system";
    let body = entry.slice(match[0].length).trim();
    if (!body) continue;
    if (label === "user") body = extractUserRequest(body);
    if (!body) continue;
    messages.push({ timestamp, role: label, body });
  }
  return messages;
}

interface ParsedToolCall {
  timestamp: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

function parseToolEvents(toolEvents: unknown[]): ParsedToolCall[] {
  const calls: { timestamp: string; toolName: string; input?: Record<string, unknown> }[] = [];
  const results: ParsedToolCall[] = [];

  for (const event of toolEvents) {
    if (!event || typeof event !== "object") continue;
    const ev = event as Record<string, unknown>;
    const type = ev.type as string;
    const timestamp = (ev.timestamp as string) || "";

    if (type === "tool.called") {
      calls.push({ timestamp, toolName: (ev.toolName as string) || "unknown", input: (ev.args as Record<string, unknown>) ?? undefined });
    } else if (type === "tool.output") {
      const pending = calls.shift();
      if (pending) results.push({ ...pending, output: typeof ev.output === "string" ? ev.output : undefined });
    } else if (type === "tool.error") {
      const pending = calls.shift();
      if (pending) results.push({ ...pending, error: typeof ev.error === "string" ? ev.error : undefined });
    }
  }

  for (const remaining of calls) {
    results.push(remaining);
  }

  return results;
}

function mergeTranscriptAndToolEvents(transcriptEntries: unknown[], toolEvents: unknown[]): LoadedSessionMessage[] {
  const tsMessages = parseTranscriptWithTimestamps(transcriptEntries);
  const toolCalls = parseToolEvents(toolEvents);

  if (toolCalls.length === 0) return tsMessages.map((m) => ({ role: m.role, body: m.body }));

  const result: LoadedSessionMessage[] = [];
  let toolIdx = 0;

  for (let i = 0; i < tsMessages.length; i++) {
    const msg = tsMessages[i];
    result.push({ role: msg.role, body: msg.body });

    const nextTs = i + 1 < tsMessages.length ? tsMessages[i + 1].timestamp : "\uffff";
    const grouped: ChatDesktopStoredToolCall[] = [];

    while (toolIdx < toolCalls.length && toolCalls[toolIdx].timestamp <= nextTs) {
      const tc = toolCalls[toolIdx];
      grouped.push({
        id: `tc-${toolIdx}`,
        toolName: tc.toolName,
        status: tc.error ? "error" : "success",
        input: tc.input,
        output: tc.output,
        error: tc.error,
      });
      toolIdx++;
    }

    if (grouped.length > 0) {
      result.push({ role: "system", body: `Used ${grouped.length} tool(s)`, toolCalls: grouped });
    }
  }

  while (toolIdx < toolCalls.length) {
    const tc = toolCalls[toolIdx];
    const last = result.find((m) => m.role === "system" && m.toolCalls);
    const entry: ChatDesktopStoredToolCall = {
      id: `tc-${toolIdx}`,
      toolName: tc.toolName,
      status: tc.error ? "error" : "success",
      input: tc.input,
      output: tc.output,
      error: tc.error,
    };
    if (last?.toolCalls) {
      last.toolCalls.push(entry);
    } else {
      result.push({ role: "system", body: `Used tool: ${tc.toolName}`, toolCalls: [entry] });
    }
    toolIdx++;
  }

  return result;
}

// ── Thread helpers ──

function deriveThreadTitle(snapshot: Record<string, unknown>, fileName: string): string {
  const prompt = collapseText(extractUserRequest(snapshot.originalPrompt));
  const sessionId = collapseText(snapshot.sessionId) || path.basename(fileName, ".json");
  return truncateText(prompt || sessionId || "Untitled thread", 64);
}

function deriveThreadSummary(snapshot: Record<string, unknown>): string {
  const summary = collapseText(snapshot.lastSummary);
  if (summary) return truncateText(summary, 120);
  const lastError = collapseText(snapshot.lastError);
  if (lastError) return truncateText(lastError, 120);
  const status = collapseText(snapshot.taskStatus);
  if (status) return `Session status: ${status}`;
  return "Saved session in this workspace.";
}

function deriveThreadState(snapshot: Record<string, unknown>): string {
  const status = collapseText(snapshot.taskStatus);
  const recoverable = snapshot.recoverable === true;
  switch (status) {
    case "running": return "Running";
    case "cancelled": return recoverable ? "Resume available" : "Cancelled";
    case "failed": return recoverable ? "Retry available" : "Failed";
    case "completed": return "Completed";
    default: return recoverable ? "Resume available" : "Saved session";
  }
}

function buildThreadPlaceholder(workspaceName: string, snapshot: Record<string, unknown>): string {
  const prompt = collapseText(extractUserRequest(snapshot.originalPrompt));
  return prompt ? `Continue in ${workspaceName}: ${truncateText(prompt, 140)}` : `Ask ${workspaceName} to inspect the codebase, explain a file, or plan a change.`;
}

export { extractUserRequest };

function formatRelativeTime(timestamp: string): string {
  const target = new Date(timestamp).getTime();
  if (!Number.isFinite(target)) return "-";
  const delta = Date.now() - target;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))}m`;
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))}h`;
  if (delta < 7 * day) return `${Math.max(1, Math.floor(delta / day))}d`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(target));
}

function getThreadGroupLabel(timestamp: string): string {
  const target = new Date(timestamp);
  if (!Number.isFinite(target.getTime())) return "Earlier";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const deltaDays = Math.round((today - targetDay) / (24 * 60 * 60 * 1000));
  if (deltaDays <= 0) return "Today";
  if (deltaDays === 1) return "Yesterday";
  return "Earlier";
}

export function groupThreads(threads: ChatDesktopThreadSummary[]): ChatDesktopThreadGroup[] {
  const grouped = new Map<string, ChatDesktopThreadSummary[]>();
  for (const thread of threads) {
    const label = getThreadGroupLabel(thread.updatedAt);
    const bucket = grouped.get(label) ?? [];
    bucket.push(thread);
    grouped.set(label, bucket);
  }
  return ["Today", "Yesterday", "Earlier"]
    .map((label) => ({ label, threads: grouped.get(label) ?? [] }))
    .filter((g) => g.threads.length > 0);
}

// ── Workspace thread listing (snapshot-based) ──

async function loadWorkspaceSessionIndex(workspacePath: string): Promise<WorkspaceSessionIndex | null> {
  try {
    const raw = await readFile(resolveWorkspaceSessionIndexPath(workspacePath), "utf8");
    return JSON.parse(raw) as WorkspaceSessionIndex;
  } catch {
    return null;
  }
}

/**
 * Returns true if the session snapshot was created by the Chat agent (AgentSdkEngine).
 * Internal agent runs may write snapshots with a custom sessionLabel
 * (for example "codegen"), producing historyEvents with non-session titles.
 * Chat sessions always have "session.start", "session.resume", or "session.retry".
 * Snapshots with no historyEvents are treated as chat sessions for backward compatibility.
 */
function isChatSessionSnapshot(snapshot: Record<string, unknown>): boolean {
  const events = Array.isArray(snapshot.historyEvents) ? snapshot.historyEvents : [];
  if (events.length === 0) return true;
  const firstTitle = typeof (events[0] as Record<string, unknown>)?.title === "string"
    ? (events[0] as Record<string, unknown>).title as string
    : "";
  return !firstTitle || firstTitle.startsWith("session.");
}

async function addThreadFromSnapshotPath(
  threadsById: Map<string, ChatDesktopThreadSummary>,
  snapshotPath: string,
  workspacePath: string,
  fileName: string,
): Promise<void> {
  try {
    const raw = await readFile(snapshotPath, "utf8");
    const snapshot = JSON.parse(raw) as Record<string, unknown>;

    // Skip non-chat agent sessions.
    if (!isChatSessionSnapshot(snapshot)) return;

    const updatedAt = collapseText(snapshot.updatedAt) || new Date().toISOString();

    const thread: ChatDesktopThreadSummary = {
      id: collapseText(snapshot.sessionId) || path.basename(fileName, ".json"),
      title: deriveThreadTitle(snapshot, fileName),
      summary: deriveThreadSummary(snapshot),
      time: formatRelativeTime(updatedAt),
      placeholder: buildThreadPlaceholder(path.basename(workspacePath), snapshot),
      sessionState: deriveThreadState(snapshot),
      scope: "Workspace root",
      updatedAt,
    };

    const existing = threadsById.get(thread.id);
    if (!existing || new Date(thread.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
      threadsById.set(thread.id, thread);
    }
  } catch {
    // Ignore malformed or missing session snapshots during discovery.
  }
}

export async function listWorkspaceThreads(workspacePath: string): Promise<ChatDesktopThreadSummary[]> {
  const threadsById = new Map<string, ChatDesktopThreadSummary>();
  const directories = [
    path.join(workspacePath, ".forgelet", "query-loop-sessions"),
    path.join(workspacePath, ".forgelet", "sessions"),
  ];

  for (const sessionsDirectory of directories) {
    let entries;
    try {
      entries = await readdir(sessionsDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      await addThreadFromSnapshotPath(threadsById, path.join(sessionsDirectory, entry.name), workspacePath, entry.name);
    }
  }

  const workspaceSessionIndex = await loadWorkspaceSessionIndex(workspacePath);
  for (const session of workspaceSessionIndex?.sessions ?? []) {
    await addThreadFromSnapshotPath(
      threadsById,
      typeof session.snapshotPath === "string" && session.snapshotPath.trim().length > 0
        ? session.snapshotPath
        : resolveSessionSnapshotPath(session.sessionId),
      workspacePath,
      `${session.sessionId}.json`,
    );
  }

  const threads = [...threadsById.values()];
  threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return threads;
}

export async function loadSessionThread(workspacePath: string, sessionId: string): Promise<LoadedSessionThread | null> {
  const candidatePaths = [
    path.join(workspacePath, ".forgelet", "query-loop-sessions", `${sessionId}.json`),
    path.join(workspacePath, ".forgelet", "sessions", `${sessionId}.json`),
    resolveSessionSnapshotPath(sessionId),
  ];

  const workspaceIndex = await loadWorkspaceSessionIndex(workspacePath);
  for (const session of workspaceIndex?.sessions ?? []) {
    if (session.sessionId === sessionId && typeof session.snapshotPath === "string" && session.snapshotPath.trim()) {
      candidatePaths.unshift(session.snapshotPath);
    }
  }

  for (const candidatePath of candidatePaths) {
    let raw: string;
    try {
      raw = await readFile(candidatePath, "utf8");
    } catch {
      continue;
    }

    try {
      const snapshot = JSON.parse(raw) as Record<string, unknown>;
      const transcriptEntries = Array.isArray(snapshot.transcriptEntries) ? snapshot.transcriptEntries : [];
      const toolEvents = Array.isArray(snapshot.toolEvents) ? snapshot.toolEvents : [];
      const messages = mergeTranscriptAndToolEvents(transcriptEntries, toolEvents);
      if (messages.length === 0) {
        const prompt = extractUserRequest(snapshot.originalPrompt);
        if (prompt) messages.push({ role: "user", body: prompt });
        const summary = collapseText(snapshot.lastSummary);
        if (summary) messages.push({ role: "assistant", body: summary });
      }
      if (messages.length === 0) continue;

      return {
        id: collapseText(snapshot.sessionId) || sessionId,
        title: deriveThreadTitle(snapshot, `${sessionId}.json`),
        summary: deriveThreadSummary(snapshot),
        updatedAt: collapseText(snapshot.updatedAt) || new Date().toISOString(),
        sdkSessionId: typeof snapshot.sdkSessionId === "string" ? snapshot.sdkSessionId : undefined,
        messages,
      };
    } catch {
      continue;
    }
  }

  return null;
}
