import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@lattice-code/shared-types";
import type { TraceRunKind } from "@lattice-code/storage-core";
import {
  resolveCliTraceDir,
  resolveDesktopTraceDir,
  resolveEvalTraceDir,
  resolveSweBenchTraceInstancePath,
} from "@lattice-code/storage-core";

export interface TraceConfig {
  enabled?: boolean;
  runKind: TraceRunKind;
  runId: string;
  instanceId?: string;
  workspaceRoot: string;
  maxPayloadBytes?: number;
}

export interface TraceRecord {
  schemaVersion: 1;
  runKind: TraceRunKind;
  runId: string;
  instanceId?: string;
  workspaceRoot: string;
  event: AgentEvent;
}

export interface TraceSink {
  append(event: AgentEvent): void | Promise<void>;
  close(): Promise<void>;
}

export function createTraceSink(config: TraceConfig | undefined): TraceSink | undefined {
  if (!config || config.enabled === false) {
    return undefined;
  }
  return new JsonlTraceSink(config);
}

class NullTraceSink implements TraceSink {
  append(): void {}
  async close(): Promise<void> {}
}

class JsonlTraceSink implements TraceSink {
  private readonly config: TraceConfig;
  private readonly traceFilePath: string;
  private readonly manifestPath: string;
  private manifestWritten = false;
  private readonly maxPayloadBytes: number;
  private closed = false;

  constructor(config: TraceConfig) {
    this.config = config;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 16_384;
    const traceDir = resolveTraceDir(config);
    this.traceFilePath = resolveTraceFilePath(config, traceDir);
    this.manifestPath = path.join(traceDir, "manifest.json");
  }

  async append(event: AgentEvent): Promise<void> {
    if (this.closed) return;
    await mkdir(path.dirname(this.traceFilePath), { recursive: true });
    if (!this.manifestWritten) {
      await writeFile(
        this.manifestPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            runKind: this.config.runKind,
            runId: this.config.runId,
            instanceId: this.config.instanceId,
            workspaceRoot: this.config.workspaceRoot,
            traceFile: this.traceFilePath,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      this.manifestWritten = true;
    }

    const record: TraceRecord = {
      schemaVersion: 1,
      runKind: this.config.runKind,
      runId: this.config.runId,
      instanceId: this.config.instanceId,
      workspaceRoot: this.config.workspaceRoot,
      event: sanitizeEventForTrace(event, this.maxPayloadBytes),
    };
    await appendFile(this.traceFilePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function resolveTraceDir(config: TraceConfig): string {
  switch (config.runKind) {
    case "desktop":
      return resolveDesktopTraceDir(config.workspaceRoot, config.runId);
    case "cli":
      return resolveCliTraceDir(config.workspaceRoot, config.runId);
    case "eval":
      return config.instanceId
        ? path.join(resolveEvalTraceDir(config.runId), "instances")
        : resolveEvalTraceDir(config.runId);
    case "swe-bench":
      return path.dirname(
        resolveSweBenchTraceInstancePath(config.runId, config.instanceId ?? "unknown"),
      );
    default:
      return resolveEvalTraceDir(config.runId);
  }
}

function resolveTraceFilePath(config: TraceConfig, traceDir: string): string {
  if (config.instanceId && (config.runKind === "swe-bench" || config.runKind === "eval")) {
    if (config.runKind === "swe-bench") {
      return resolveSweBenchTraceInstancePath(config.runId, config.instanceId);
    }
    return path.join(traceDir, `${sanitizeInstanceId(config.instanceId)}.jsonl`);
  }
  return path.join(traceDir, "trace.jsonl");
}

function sanitizeInstanceId(instanceId: string): string {
  return instanceId.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function sanitizeEventForTrace(event: AgentEvent, maxPayloadBytes: number): AgentEvent {
  try {
    const raw = JSON.stringify(event.payload);
    if (raw.length <= maxPayloadBytes) {
      return event;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["output", "error", "summary", "delta"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > maxPayloadBytes) {
        parsed[key] = truncateText(value, maxPayloadBytes);
        parsed._traceTruncated = true;
      }
    }
    return { ...event, payload: parsed };
  } catch {
    return event;
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

export { NullTraceSink };
