import { summarizeEventPayload } from "@/lib/trace-format";
import type { AgentEvent, StoredTraceRecord } from "@/types";

export interface TraceToolCall {
  toolCallId: string;
  toolName: string;
  argsPreview?: string;
  status: "pending" | "success" | "error";
  durationMs?: number;
  error?: string;
}

export interface TraceRunSummary {
  taskId: string;
  runIndex: number;
  userPrompt: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  costUsd?: number;
  sessionTotalCostUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  status: "completed" | "failed" | "running" | "unknown";
  summary?: string;
  tools: TraceToolCall[];
}

export interface SessionTraceAnalysis {
  runs: TraceRunSummary[];
  totalRuns: number;
  totalCostUsd?: number;
}

function extractUserRequest(rawPrompt: string): string {
  const marker = "[USER_REQUEST]";
  const idx = rawPrompt.lastIndexOf(marker);
  return idx < 0 ? rawPrompt.trim() : rawPrompt.slice(idx + marker.length).trim();
}

function parseTime(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function toolCallKey(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.toolCallId === "string" && payload.toolCallId) {
    return payload.toolCallId;
  }
  return fallback;
}

function buildRunFromEvents(taskId: string, events: StoredTraceRecord[]): TraceRunSummary | null {
  const sorted = [...events].sort(
    (a, b) => (parseTime(a.event.timestamp) ?? 0) - (parseTime(b.event.timestamp) ?? 0),
  );
  if (sorted.length === 0) return null;

  const started = sorted.find((r) => r.event.type === "agent.started");
  const terminal = [...sorted]
    .reverse()
    .find((r) => r.event.type === "agent.done" || r.event.type === "agent.error");

  const startedPayload = (started?.event.payload ?? {}) as Record<string, unknown>;
  const rawPrompt = typeof startedPayload.prompt === "string" ? startedPayload.prompt : "";
  const userPrompt = extractUserRequest(rawPrompt) || rawPrompt || "(no prompt)";

  const tools = new Map<string, TraceToolCall>();
  let toolSeq = 0;

  for (const record of sorted) {
    const { event } = record;
    const payload = event.payload as Record<string, unknown>;

    if (event.type === "tool.called") {
      const key = toolCallKey(payload, `${taskId}-tool-${toolSeq++}`);
      tools.set(key, {
        toolCallId: key,
        toolName: String(payload.toolName ?? "tool"),
        argsPreview: summarizeEventPayload("tool.called", payload),
        status: "pending",
      });
      continue;
    }

    if (event.type === "tool.output" || event.type === "tool.error") {
      const key = toolCallKey(payload, "");
      const match =
        (key && tools.get(key)) ||
        [...tools.values()].reverse().find((t) => t.toolName === payload.toolName && t.status === "pending");

      if (!match) continue;

      const calledAt = sorted.find(
        (r) =>
          r.event.type === "tool.called" &&
          toolCallKey(r.event.payload as Record<string, unknown>, "") === match.toolCallId,
      );
      const startMs = parseTime(calledAt?.event.timestamp);
      const endMs = parseTime(event.timestamp);

      match.status = event.type === "tool.error" ? "error" : "success";
      if (event.type === "tool.error" && typeof payload.error === "string") {
        match.error = payload.error;
      }
      if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
        match.durationMs = endMs - startMs;
      }
    }
  }

  let status: TraceRunSummary["status"] = "unknown";
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  let sessionTotalCostUsd: number | undefined;
  let numTurns: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let summary: string | undefined;
  let completedAt: string | undefined;

  if (terminal?.event.type === "agent.done") {
    status = "completed";
    completedAt = terminal.event.timestamp;
    const p = terminal.event.payload as Record<string, unknown>;
    summary = typeof p.summary === "string" ? p.summary : undefined;
    const metrics = p.metrics as Record<string, unknown> | undefined;
    if (metrics) {
      durationMs = typeof metrics.durationMs === "number" ? metrics.durationMs : durationMs;
      costUsd = typeof metrics.totalCostUsd === "number" ? metrics.totalCostUsd : costUsd;
      sessionTotalCostUsd =
        typeof metrics.sessionTotalCostUsd === "number" ? metrics.sessionTotalCostUsd : sessionTotalCostUsd;
      numTurns = typeof metrics.numTurns === "number" ? metrics.numTurns : numTurns;
      inputTokens = typeof metrics.runInputTokens === "number" ? metrics.runInputTokens : inputTokens;
      outputTokens = typeof metrics.runOutputTokens === "number" ? metrics.runOutputTokens : outputTokens;
      if (inputTokens === undefined && typeof metrics.inputTokens === "number") {
        inputTokens = metrics.inputTokens;
      }
      if (outputTokens === undefined && typeof metrics.outputTokens === "number") {
        outputTokens = metrics.outputTokens;
      }
    }
  } else if (terminal?.event.type === "agent.error") {
    status = "failed";
    completedAt = terminal.event.timestamp;
    const p = terminal.event.payload as Record<string, unknown>;
    summary = typeof p.error === "string" ? p.error : undefined;
    const metrics = p.metrics as Record<string, unknown> | undefined;
    if (metrics && typeof metrics.durationMs === "number") durationMs = metrics.durationMs;
  } else if (started) {
    status = "running";
  }

  if (durationMs === undefined) {
    const startMs = parseTime(started?.event.timestamp ?? sorted[0]?.event.timestamp);
    const endMs = parseTime(completedAt);
    if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
      durationMs = endMs - startMs;
    }
  }

  return {
    taskId,
    runIndex: 0,
    userPrompt,
    startedAt: started?.event.timestamp ?? sorted[0]?.event.timestamp ?? "",
    completedAt,
    durationMs,
    costUsd,
    sessionTotalCostUsd,
    numTurns,
    inputTokens,
    outputTokens,
    status,
    summary,
    tools: [...tools.values()],
  };
}

export function aggregateTraceRuns(records: StoredTraceRecord[]): SessionTraceAnalysis {
  const byTask = new Map<string, StoredTraceRecord[]>();

  for (const record of records) {
    const taskId = record.event.taskId?.trim() || "unknown";
    const bucket = byTask.get(taskId) ?? [];
    bucket.push(record);
    byTask.set(taskId, bucket);
  }

  const runs: TraceRunSummary[] = [];
  for (const [taskId, events] of byTask) {
    const run = buildRunFromEvents(taskId, events);
    if (run) runs.push(run);
  }

  runs.sort((a, b) => (parseTime(a.startedAt) ?? 0) - (parseTime(b.startedAt) ?? 0));
  runs.forEach((run, i) => {
    run.runIndex = i + 1;
  });

  const lastWithSessionCost = [...runs]
    .reverse()
    .find((r) => r.sessionTotalCostUsd !== undefined);
  const totalCostUsd =
    lastWithSessionCost?.sessionTotalCostUsd ??
    (runs.some((r) => r.costUsd !== undefined)
      ? runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      : undefined);

  return {
    runs,
    totalRuns: runs.length,
    totalCostUsd,
  };
}
