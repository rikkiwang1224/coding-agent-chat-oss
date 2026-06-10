import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  resolveHarnessSessionsDir,
  resolveHarnessSessionPath,
  sanitizeStorageSegment,
} from "@lattice-code/storage-core";
import type { ChatMessage } from "./types.js";

/** @deprecated Use resolveHarnessSessionsDir from @lattice-code/storage-core */
export function resolveHarnessSessionDir(workspaceRoot: string): string {
  return resolveHarnessSessionsDir(workspaceRoot);
}

/** One user Send → one harness run (may include multiple LLM/tool steps). */
export interface SessionRunRecord {
  taskId: string;
  /** 1-based index of user messages in this session when the run started */
  turnIndex: number;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  model?: string;
}

export function sumSessionRunCosts(runs: SessionRunRecord[] | undefined): number {
  if (!runs?.length) return 0;
  const total = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  metadata: {
    model?: string;
    workspaceRoot?: string;
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    /** Cumulative estimated spend — sum of `runs[].costUsd` */
    totalCostUsd?: number;
    /** Most recent run in `runs` */
    lastRunCostUsd?: number;
    runs?: SessionRunRecord[];
  };
}

export class SessionStore {
  private readonly storeDir: string;
  private readonly workspaceRoot?: string;

  /** Persist under LATTICE_CODE_HOME/sessions/{workspaceHash}/ */
  static forWorkspace(workspaceRoot: string): SessionStore {
    return new SessionStore(resolveHarnessSessionsDir(workspaceRoot), workspaceRoot);
  }

  constructor(storeDir: string, workspaceRoot?: string) {
    this.storeDir = storeDir;
    this.workspaceRoot = workspaceRoot;
  }

  resolveSessionPath(sessionId: string): string {
    if (this.workspaceRoot) {
      return resolveHarnessSessionPath(this.workspaceRoot, sessionId);
    }
    return path.join(this.storeDir, `${sanitizeStorageSegment(sessionId)}.json`);
  }

  async save(session: SessionData): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const filePath = this.resolveSessionPath(session.id);
    session.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf8");
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const filePath = this.resolveSessionPath(sessionId);
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as SessionData;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(this.storeDir);
      return entries
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  async delete(sessionId: string): Promise<boolean> {
    const filePath = this.resolveSessionPath(sessionId);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
