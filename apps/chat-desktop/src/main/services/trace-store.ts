import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@lattice-code/shared-types";
import {
  resolveAgentHome,
  resolveDesktopTraceDir,
  resolveWorkspaceThreadPath,
  resolveWorkspaceThreadsDir,
} from "@lattice-code/storage-core";

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

interface ThreadMeta {
  id: string;
  title?: string;
  updatedAt?: string;
}

function isIgnorableEntry(name: string): boolean {
  return !name || name.startsWith(".");
}

async function readThreadMeta(
  workspaceRoot: string,
  sessionId: string,
): Promise<ThreadMeta | null> {
  try {
    const raw = await readFile(resolveWorkspaceThreadPath(workspaceRoot, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id : sessionId;
    const title = typeof parsed.title === "string" ? parsed.title : undefined;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
    return { id, title, updatedAt };
  } catch {
    return null;
  }
}

async function readTraceFileStats(
  workspaceRoot: string,
  sessionId: string,
): Promise<{
  eventCount: number;
  runCount: number;
  totalCostUsd?: number;
  lastEventAt?: string;
  fileSizeBytes: number;
  startedAt?: string;
}> {
  const tracePath = path.join(resolveDesktopTraceDir(workspaceRoot, sessionId), "trace.jsonl");
  const manifestPath = path.join(resolveDesktopTraceDir(workspaceRoot, sessionId), "manifest.json");

  let startedAt: string | undefined;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TraceManifest;
    startedAt = manifest.startedAt;
  } catch {
    // optional
  }

  try {
    const content = await readFile(tracePath, "utf8");
    const st = await stat(tracePath);
    const lines = content.split("\n").filter((l) => l.trim());
    let lastEventAt: string | undefined;
    let runCount = 0;
    let totalCostUsd: number | undefined;
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as StoredTraceRecord;
        if (record.event?.type === "agent.done") {
          runCount += 1;
          const metrics = record.event.payload as { metrics?: { sessionTotalCostUsd?: number; totalCostUsd?: number } };
          if (typeof metrics?.metrics?.sessionTotalCostUsd === "number") {
            totalCostUsd = metrics.metrics.sessionTotalCostUsd;
          }
        }
        lastEventAt = record.event?.timestamp ?? lastEventAt;
      } catch {
        // skip malformed line
      }
    }
    return {
      eventCount: lines.length,
      runCount,
      totalCostUsd,
      lastEventAt,
      fileSizeBytes: st.size,
      startedAt,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { eventCount: 0, runCount: 0, fileSizeBytes: 0, startedAt };
    }
    throw err;
  }
}

async function resolveWorkspaceRootForHash(
  workspaceHash: string,
): Promise<{ workspaceRoot: string; workspaceName: string }> {
  const storageDir = path.join(resolveAgentHome(), "workspaces", workspaceHash);

  try {
    const metaPath = path.join(storageDir, "workspace.json");
    const parsed = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    const root =
      typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot.trim()
        ? path.resolve(parsed.workspaceRoot)
        : null;
    if (root) {
      return { workspaceRoot: root, workspaceName: path.basename(root) };
    }
  } catch {
    // optional
  }

  try {
    const indexPath = path.join(storageDir, "session-index.json");
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    const root =
      typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot.trim()
        ? path.resolve(parsed.workspaceRoot)
        : null;
    if (root) {
      return { workspaceRoot: root, workspaceName: path.basename(root) };
    }
  } catch {
    // optional
  }

  const traceDesktopDir = path.join(resolveAgentHome(), "traces", "desktop", workspaceHash);
  try {
    const sessions = await readdir(traceDesktopDir, { withFileTypes: true });
    for (const entry of sessions) {
      if (!entry.isDirectory() || isIgnorableEntry(entry.name)) continue;
      try {
        const manifest = JSON.parse(
          await readFile(path.join(traceDesktopDir, entry.name, "manifest.json"), "utf8"),
        ) as TraceManifest;
        if (manifest.workspaceRoot?.trim()) {
          const root = path.resolve(manifest.workspaceRoot);
          return { workspaceRoot: root, workspaceName: path.basename(root) };
        }
      } catch {
        // try next session dir
      }
    }
  } catch {
    // no traces dir
  }

  return { workspaceRoot: storageDir, workspaceName: workspaceHash };
}

/** List sessions from ~/.lattice-code/workspaces/{hash}/threads/ for one workspace. */
export async function listDesktopTraces(workspaceRoot: string): Promise<TraceSummary[]> {
  const workspaceName = path.basename(workspaceRoot);
  const summaries = await listDesktopTracesForRoot(workspaceRoot, workspaceName);
  return summaries;
}

async function listDesktopTracesForRoot(
  workspaceRoot: string,
  workspaceName: string,
): Promise<TraceSummary[]> {
  const threadsDir = resolveWorkspaceThreadsDir(workspaceRoot);
  let entries;
  try {
    entries = await readdir(threadsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const summaries: TraceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.slice(0, -".json".length);
    if (isIgnorableEntry(sessionId)) continue;

    const [thread, traceStats] = await Promise.all([
      readThreadMeta(workspaceRoot, sessionId),
      readTraceFileStats(workspaceRoot, sessionId),
    ]);

    summaries.push({
      sessionId,
      workspaceRoot,
      workspaceName,
      title: thread?.title,
      startedAt: traceStats.startedAt ?? thread?.updatedAt,
      eventCount: traceStats.eventCount,
      runCount: traceStats.runCount,
      totalCostUsd: traceStats.totalCostUsd,
      lastEventAt: traceStats.lastEventAt ?? thread?.updatedAt,
      fileSizeBytes: traceStats.fileSizeBytes,
    });
  }

  return summaries.sort((a, b) => {
    const aTime = a.lastEventAt ?? a.startedAt ?? "";
    const bTime = b.lastEventAt ?? b.startedAt ?? "";
    return bTime.localeCompare(aTime);
  });
}

/** List chats across every workspace under ~/.lattice-code/workspaces/ */
export async function listAllDesktopTraces(): Promise<TraceSummary[]> {
  const workspacesRoot = path.join(resolveAgentHome(), "workspaces");
  let entries;
  try {
    entries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const all: TraceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnorableEntry(entry.name)) continue;
    const { workspaceRoot, workspaceName } = await resolveWorkspaceRootForHash(entry.name);
    const items = await listDesktopTracesForRoot(workspaceRoot, workspaceName);
    all.push(...items);
  }

  return all.sort((a, b) => {
    const aTime = a.lastEventAt ?? a.startedAt ?? "";
    const bTime = b.lastEventAt ?? b.startedAt ?? "";
    return bTime.localeCompare(aTime);
  });
}

export async function loadDesktopTrace(
  workspaceRoot: string,
  sessionId: string,
): Promise<DesktopTraceDetail | null> {
  const dir = resolveDesktopTraceDir(workspaceRoot, sessionId);
  const tracePath = path.join(dir, "trace.jsonl");
  const manifestPath = path.join(dir, "manifest.json");

  let manifest: TraceManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TraceManifest;
  } catch {
    // manifest optional
  }

  let content: string;
  try {
    content = await readFile(tracePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const records: StoredTraceRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as StoredTraceRecord);
    } catch {
      // skip malformed lines
    }
  }

  return { manifest, records };
}
