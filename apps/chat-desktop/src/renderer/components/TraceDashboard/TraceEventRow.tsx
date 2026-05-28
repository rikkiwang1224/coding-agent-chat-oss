import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TRACE_EVENT_LABELS,
  formatTraceTimestamp,
  summarizeEventPayload,
} from "@/lib/trace-format";
import type { AgentEventType, StoredTraceRecord } from "@/types";

const EVENT_COLORS: Partial<Record<AgentEventType, string>> = {
  "tool.called": "text-accent",
  "tool.output": "text-positive",
  "tool.error": "text-error",
  "agent.error": "text-error",
  "agent.done": "text-positive",
  "tool.permission_request": "text-warning",
};

interface TraceEventRowProps {
  record: StoredTraceRecord;
  index: number;
}

export function TraceEventRow({ record, index }: TraceEventRowProps) {
  const { event } = record;

  const [open, setOpen] = useState(false);
  const summary = summarizeEventPayload(event.type, event.payload);
  const hasDetail = Boolean(summary) || Object.keys(event.payload).length > 0;
  const colorClass = EVENT_COLORS[event.type] ?? "text-text";

  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left text-[13px]",
          hasDetail && "hover:bg-white/50 cursor-pointer",
          !hasDetail && "cursor-default",
        )}
      >
        <span className="w-8 shrink-0 tabular-nums text-soft text-[12px] pt-0.5">
          {index + 1}
        </span>
        {hasDetail && (
          <ChevronRight
            className={cn(
              "mt-0.5 h-3 w-3 shrink-0 text-soft transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        {!hasDetail && <span className="w-3 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cn("font-semibold", colorClass)}>
              {TRACE_EVENT_LABELS[event.type]}
            </span>
            <span className="text-[12px] text-soft">
              {formatTraceTimestamp(event.timestamp)}
            </span>
            {event.taskId && (
              <span className="text-[11px] text-soft font-mono truncate max-w-[140px]">
                {event.taskId}
              </span>
            )}
          </div>
          {summary && !open && (
            <p className="mt-0.5 text-[12px] text-muted truncate">{summary}</p>
          )}
        </div>
      </button>
      {open && hasDetail && (
        <pre className="mx-3 mb-2 max-h-64 overflow-auto rounded-lg bg-surface/80 border border-line px-3 py-2 text-[11px] font-mono text-text whitespace-pre-wrap break-words">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
