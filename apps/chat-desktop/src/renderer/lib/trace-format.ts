import type { AgentEventType } from "@/types";

export const TRACE_EVENT_LABELS: Record<AgentEventType, string> = {
  "agent.started": "Started",
  "agent.progress": "Progress",
  "agent.delta": "Delta",
  "tool.called": "Tool call",
  "tool.output": "Tool output",
  "tool.error": "Tool error",
  "tool.permission_request": "Permission",
  "tool.permission_resolved": "Permission resolved",
  "agent.done": "Done",
  "agent.error": "Error",
};

export function formatTraceTimestamp(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortenSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function summarizeEventPayload(
  type: AgentEventType,
  payload: Record<string, unknown>,
): string {
  switch (type) {
    case "agent.started":
      return truncate(String(payload.prompt ?? payload.message ?? ""), 120);
    case "agent.progress":
      return truncate(String(payload.message ?? payload.stage ?? ""), 120);
    case "agent.delta":
      return truncate(String(payload.delta ?? ""), 80);
    case "tool.called":
      return formatToolSummary(String(payload.toolName ?? ""), payload.args);
    case "tool.output":
      return truncate(String(payload.output ?? ""), 120);
    case "tool.error":
      return truncate(String(payload.error ?? ""), 120);
    case "tool.permission_request":
      return `${payload.toolName ?? "tool"} — ${payload.reason ?? "needs approval"}`;
    case "tool.permission_resolved":
      return `${payload.outcome ?? "resolved"}`;
    case "agent.done":
      return truncate(String(payload.summary ?? ""), 120);
    case "agent.error":
      return truncate(String(payload.error ?? ""), 120);
    default:
      return "";
  }
}

function formatToolSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return `${toolName}: ${truncate(record.command, 80)}`;
  if (typeof record.path === "string") return `${toolName}: ${record.path}`;
  if (typeof record.pattern === "string") return `${toolName}: ${record.pattern}`;
  const first = Object.values(record).find((v) => typeof v === "string");
  return first ? `${toolName}: ${truncate(String(first), 80)}` : toolName;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
