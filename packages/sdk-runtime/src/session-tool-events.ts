import type { AgentSessionSnapshot } from "@forgelet/sdk-core";
import type {
  AgentToolEvent,
  AgentToolMetadata,
  PermissionDecision
} from "@forgelet/shared-types";

const MAX_TOOL_EVENT_TEXT_LENGTH = 16_000;
const MAX_TOOL_EVENT_ARG_STRING_LENGTH = 4_000;

export function appendToolCalledEvent(
  snapshot: AgentSessionSnapshot,
  input: {
    toolName: string;
    args: Record<string, unknown>;
    metadata?: AgentToolMetadata;
    timestamp?: string;
  }
): void {
  const sanitized = sanitizeArgs(input.args);
  appendToolEvent(snapshot, {
    type: "tool.called",
    timestamp: input.timestamp,
    toolName: input.toolName,
    args: sanitized.args,
    metadata: input.metadata,
    truncated: sanitized.truncated
  });
}

export function appendToolOutputEvent(
  snapshot: AgentSessionSnapshot,
  input: {
    toolName: string;
    output: string;
    timestamp?: string;
  }
): void {
  const output = truncateText(input.output, MAX_TOOL_EVENT_TEXT_LENGTH);
  appendToolEvent(snapshot, {
    type: "tool.output",
    timestamp: input.timestamp,
    toolName: input.toolName,
    output,
    truncated: output !== input.output
  });
}

export function appendToolErrorEvent(
  snapshot: AgentSessionSnapshot,
  input: {
    toolName: string;
    error: string;
    decision?: PermissionDecision;
    timestamp?: string;
  }
): void {
  const error = truncateText(input.error, MAX_TOOL_EVENT_TEXT_LENGTH);
  appendToolEvent(snapshot, {
    type: "tool.error",
    timestamp: input.timestamp,
    toolName: input.toolName,
    error,
    decision: input.decision,
    truncated: error !== input.error
  });
}

function appendToolEvent(snapshot: AgentSessionSnapshot, event: AgentToolEvent): void {
  if (!Array.isArray(snapshot.toolEvents)) {
    snapshot.toolEvents = [];
  }
  snapshot.toolEvents.push({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString()
  });
}

function sanitizeArgs(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;

  try {
    const raw = JSON.stringify(args, (_key, value) => {
      if (typeof value === "string" && value.length > MAX_TOOL_EVENT_ARG_STRING_LENGTH) {
        truncated = true;
        return truncateText(value, MAX_TOOL_EVENT_ARG_STRING_LENGTH);
      }
      return value;
    });

    if (!raw) {
      return { args: {}, truncated };
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { args: {}, truncated: true };
    }

    return { args: parsed, truncated };
  } catch {
    return { args: {}, truncated: true };
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
