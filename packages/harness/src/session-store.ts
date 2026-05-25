import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./types.js";

/** Directory for harness-native session files under a workspace. */
export function resolveHarnessSessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".forgelet", "harness-sessions");
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
  };
}

export class SessionStore {
  private readonly storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
  }

  async save(session: SessionData): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const filePath = path.join(this.storeDir, `${session.id}.json`);
    session.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf8");
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const filePath = path.join(this.storeDir, `${sessionId}.json`);
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
    const filePath = path.join(this.storeDir, `${sessionId}.json`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
