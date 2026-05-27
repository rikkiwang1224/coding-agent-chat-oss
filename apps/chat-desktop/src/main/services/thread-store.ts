import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionData } from "@forgelet/harness";
import {
  resolveHarnessSessionPath,
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
  turnCost?: {
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  };
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
          turnCost:
            m.turnCost &&
            typeof m.turnCost === "object" &&
            typeof (m.turnCost as { costUsd?: unknown }).costUsd === "number"
              ? {
                  costUsd: (m.turnCost as { costUsd: number }).costUsd,
                  inputTokens:
                    typeof (m.turnCost as { inputTokens?: unknown }).inputTokens === "number"
                      ? (m.turnCost as { inputTokens: number }).inputTokens
                      : undefined,
                  outputTokens:
                    typeof (m.turnCost as { outputTokens?: unknown }).outputTokens === "number"
                      ? (m.turnCost as { outputTokens: number }).outputTokens
                      : undefined,
                }
              : undefined,
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
  messages: LoadedSessionMessage[];
  runs?: Array<{
    turnIndex: number;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  }>;
  totalCostUsd?: number;
}

function extractUserRequest(rawPrompt: unknown): string {
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt) return "";

  const marker = "[USER_REQUEST]";
  const idx = prompt.lastIndexOf(marker);
  return idx < 0 ? prompt : prompt.slice(idx + marker.length).trim();
}

function harnessMessagesToLoaded(messages: SessionData["messages"]): LoadedSessionMessage[] {
  const result: LoadedSessionMessage[] = [];
  for (const message of messages) {
    const body = collapseText(message.content);
    if (!body) continue;
    const role =
      message.role === "tool"
        ? "system"
        : message.role === "user" || message.role === "assistant" || message.role === "system"
          ? message.role
          : "system";
    result.push({ role, body: message.role === "user" ? extractUserRequest(body) || body : body });
  }
  return result;
}

function deriveHarnessThreadTitle(session: SessionData): string {
  const firstUser = session.messages.find((m) => m.role === "user");
  const prompt = extractUserRequest(firstUser?.content ?? "") || collapseText(firstUser?.content);
  return truncateText(prompt || session.id, 64);
}

function deriveHarnessThreadSummary(session: SessionData): string {
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
  const summary = collapseText(lastAssistant?.content);
  if (summary) return truncateText(summary, 120);
  return `Harness session (${session.metadata.turnCount} turns)`;
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

function storedThreadToSummary(
  thread: ChatDesktopStoredThread,
  workspacePath: string,
): ChatDesktopThreadSummary {
  const workspaceName = path.basename(workspacePath);
  const firstUser = thread.messages.find((m) => m.role === "user");
  const prompt = collapseText(firstUser?.body);
  return {
    id: thread.id,
    title: thread.title,
    summary: thread.summary,
    time: formatRelativeTime(thread.updatedAt),
    placeholder:
      thread.placeholder ||
      (prompt
        ? `Continue in ${workspaceName}: ${truncateText(prompt, 140)}`
        : `Ask ${workspaceName} to inspect the codebase, explain a file, or plan a change.`),
    sessionState: thread.sessionState || "Ready for follow-up",
    scope: thread.scope || "Workspace root",
    updatedAt: thread.updatedAt,
  };
}

/** Sidebar list source: only FORGELET_HOME/workspaces/{hash}/threads/*.json */
export async function listWorkspaceThreads(workspacePath: string): Promise<ChatDesktopThreadSummary[]> {
  const stored = await listStoredThreads(workspacePath);
  return stored.map((thread) => storedThreadToSummary(thread, workspacePath));
}

export async function loadSessionThread(workspacePath: string, sessionId: string): Promise<LoadedSessionThread | null> {
  const filePath = resolveHarnessSessionPath(workspacePath, sessionId);
  try {
    const raw = await readFile(filePath, "utf8");
    const session = JSON.parse(raw) as SessionData;
    const messages = harnessMessagesToLoaded(session.messages);
    if (messages.length === 0) return null;

    return {
      id: session.id,
      title: deriveHarnessThreadTitle(session),
      summary: deriveHarnessThreadSummary(session),
      updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
      messages,
      runs: session.metadata.runs?.map((run) => ({
        turnIndex: run.turnIndex,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
      })),
      totalCostUsd: session.metadata.totalCostUsd,
    };
  } catch {
    return null;
  }
}
