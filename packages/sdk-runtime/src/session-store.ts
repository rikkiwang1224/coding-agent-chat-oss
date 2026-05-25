import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSessionSnapshot } from "@forgelet/sdk-core";
import {
  resolveSessionsDir,
  resolveSessionSnapshotPath,
  resolveTimestampPrefixedSessionSnapshotPath,
  resolveWorkspaceHash,
  resolveWorkspaceSessionIndexPath,
  sanitizeStorageSegment,
  type WorkspaceSessionIndex,
  type WorkspaceSessionIndexEntry
} from "@forgelet/storage-core";

export interface ClaudeCodeSessionStoreOptions {
  workspaceRoot: string;
  directory?: string;
}

export class ClaudeCodeSessionStore {
  private readonly workspaceRoot: string;
  private readonly directory?: string;
  private readonly workspaceHash: string;
  private readonly workspaceSessionIndexPath?: string;

  constructor(options: ClaudeCodeSessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    const configuredDirectory = options.directory ?? process.env.AGENT_SESSION_STORE_DIR;
    this.directory =
      typeof configuredDirectory === "string" && configuredDirectory.trim().length > 0
        ? path.resolve(configuredDirectory)
        : undefined;
    this.workspaceHash = resolveWorkspaceHash(this.workspaceRoot);
    this.workspaceSessionIndexPath = this.directory
      ? undefined
      : resolveWorkspaceSessionIndexPath(this.workspaceRoot);
  }

  async load(sessionId: string): Promise<AgentSessionSnapshot | null> {
    const candidatePaths = this.directory
      ? [this.resolveFlatPath(sessionId)]
      : await this.resolveHomeStoreCandidatePaths(sessionId);

    for (const candidatePath of candidatePaths) {
      try {
        const raw = await readFile(candidatePath, "utf8");
        return normalizeSessionSnapshot(JSON.parse(raw) as AgentSessionSnapshot);
      } catch {
        continue;
      }
    }

    return null;
  }

  async save(snapshot: AgentSessionSnapshot): Promise<string> {
    const target = await this.resolvePath(snapshot);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(snapshot, null, 2), "utf8");

    if (!this.directory) {
      await this.saveWorkspaceSessionIndex(snapshot, target);
    }

    return target;
  }

  async list(): Promise<AgentSessionSnapshot[]> {
    if (this.directory) {
      return this.listFromFlatDirectory();
    }

    const index = await this.loadWorkspaceSessionIndex();
    const sessions: AgentSessionSnapshot[] = [];
    for (const entry of index?.sessions ?? []) {
      const session = await this.load(entry.sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
  }

  async resolvePath(snapshot: Pick<AgentSessionSnapshot, "sessionId" | "createdAt" | "updatedAt">): Promise<string> {
    if (this.directory) {
      return this.resolveFlatPath(snapshot.sessionId);
    }

    const indexedPath = await this.resolveIndexedSnapshotPath(snapshot.sessionId);
    if (indexedPath) {
      return indexedPath;
    }

    const timestampedMatches = await this.resolveTimestampedSnapshotPaths(snapshot.sessionId);
    if (timestampedMatches.length > 0) {
      return timestampedMatches[0] ?? resolveTimestampPrefixedSessionSnapshotPath(snapshot.sessionId, snapshot.createdAt ?? snapshot.updatedAt);
    }

    return resolveTimestampPrefixedSessionSnapshotPath(snapshot.sessionId, snapshot.createdAt ?? snapshot.updatedAt);
  }

  private async listFromFlatDirectory(): Promise<AgentSessionSnapshot[]> {
    if (!this.directory) {
      return [];
    }

    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: AgentSessionSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const session = await this.load(path.basename(entry.name, ".json"));
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
  }

  private resolveFlatPath(sessionId: string): string {
    return path.join(this.directory ?? "", `${sanitizeStorageSegment(sessionId)}.json`);
  }

  private resolveLegacyPath(sessionId: string): string {
    return path.join(this.workspaceRoot, ".forgelet", "sessions", `${sanitizeStorageSegment(sessionId)}.json`);
  }

  private async resolveHomeStoreCandidatePaths(sessionId: string): Promise<string[]> {
    const indexedPath = await this.resolveIndexedSnapshotPath(sessionId);
    const timestampedMatches = await this.resolveTimestampedSnapshotPaths(sessionId);
    const candidates = [
      indexedPath,
      ...timestampedMatches,
      resolveSessionSnapshotPath(sessionId),
      this.resolveLegacyPath(sessionId)
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    return Array.from(new Set(candidates));
  }

  private async resolveTimestampedSnapshotPaths(sessionId: string): Promise<string[]> {
    const sessionSuffix = `_${sanitizeStorageSegment(sessionId)}`;

    try {
      const entries = await readdir(resolveSessionsDir(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(sessionSuffix))
        .map((entry) => path.join(resolveSessionsDir(), entry.name, "snapshot.json"))
        .sort((left, right) => right.localeCompare(left));
    } catch {
      return [];
    }
  }

  private async resolveIndexedSnapshotPath(sessionId: string): Promise<string | null> {
    const index = await this.loadWorkspaceSessionIndex();
    const entry = index?.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (typeof entry?.snapshotPath === "string" && entry.snapshotPath.trim().length > 0) {
      return entry.snapshotPath;
    }

    return null;
  }

  private async loadWorkspaceSessionIndex(): Promise<WorkspaceSessionIndex | null> {
    if (!this.workspaceSessionIndexPath) {
      return null;
    }

    try {
      const raw = await readFile(this.workspaceSessionIndexPath, "utf8");
      return JSON.parse(raw) as WorkspaceSessionIndex;
    } catch {
      return null;
    }
  }

  private async saveWorkspaceSessionIndex(snapshot: AgentSessionSnapshot, snapshotPath: string): Promise<void> {
    if (!this.workspaceSessionIndexPath) {
      return;
    }

    const currentIndex = (await this.loadWorkspaceSessionIndex()) ?? {
      workspaceHash: this.workspaceHash,
      workspaceRoot: this.workspaceRoot,
      updatedAt: snapshot.updatedAt,
      sessions: []
    };

    const nextEntry: WorkspaceSessionIndexEntry = {
      sessionId: snapshot.sessionId,
      updatedAt: snapshot.updatedAt,
      runtime: "claude_sdk",
      snapshotPath,
      taskId: snapshot.taskId,
      taskStatus: snapshot.taskStatus,
      recoverable: snapshot.recoverable,
      sdkSessionId: snapshot.sdkSessionId,
      lastSummary: snapshot.lastSummary,
      lastError: snapshot.lastError
    };

    const nextIndex: WorkspaceSessionIndex = {
      ...currentIndex,
      workspaceHash: this.workspaceHash,
      workspaceRoot: this.workspaceRoot,
      updatedAt: snapshot.updatedAt,
      sessions: [nextEntry, ...currentIndex.sessions.filter((entry: WorkspaceSessionIndexEntry) => entry.sessionId !== snapshot.sessionId)].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
    };

    await mkdir(path.dirname(this.workspaceSessionIndexPath), { recursive: true });
    await writeFile(this.workspaceSessionIndexPath, JSON.stringify(nextIndex, null, 2), "utf8");
  }
}

function normalizeSessionSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  return {
    ...snapshot,
    transcriptEntries: Array.isArray(snapshot.transcriptEntries) ? snapshot.transcriptEntries : [],
    historyEvents: Array.isArray(snapshot.historyEvents) ? snapshot.historyEvents : [],
    toolEvents: Array.isArray(snapshot.toolEvents) ? snapshot.toolEvents : []
  };
}
