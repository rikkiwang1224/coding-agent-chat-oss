import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { TraceEventRow } from "./TraceEventRow";
import { TRACE_EVENT_LABELS } from "@/lib/trace-format";
import type { AgentEventType, DesktopTraceDetail } from "@/types";

interface TraceEventTimelineProps {
  sessionId: string | null;
  detail: DesktopTraceDetail | null;
  loading: boolean;
  error: string | null;
}

const FILTER_TYPES: AgentEventType[] = [
  "agent.started",
  "agent.progress",
  "agent.delta",
  "tool.called",
  "tool.output",
  "tool.error",
  "tool.permission_request",
  "agent.done",
  "agent.error",
];

export function TraceEventTimeline({
  sessionId,
  detail,
  loading,
  error,
}: TraceEventTimelineProps) {
  const [hideDeltas, setHideDeltas] = useState(true);
  const [typeFilter, setTypeFilter] = useState<AgentEventType | "all">("all");

  const records = detail?.records ?? [];
  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (typeFilter !== "all" && r.event.type !== typeFilter) return false;
      if (hideDeltas && r.event.type === "agent.delta") return false;
      return true;
    });
  }, [records, typeFilter, hideDeltas]);

  const eventCounts = useMemo(() => {
    const counts: Partial<Record<AgentEventType, number>> = {};
    for (const r of records) {
      counts[r.event.type] = (counts[r.event.type] ?? 0) + 1;
    }
    return counts;
  }, [records]);

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted text-[14px]">
        Select a session to view its trace timeline
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading trace…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-error text-[14px] px-6 text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[12px]"
          onClick={() => setHideDeltas((v) => !v)}
        >
          {hideDeltas ? "Show deltas" : "Hide deltas"}
        </Button>
        <div className="flex flex-wrap gap-1">
          <FilterChip
            active={typeFilter === "all"}
            label={`All (${records.length})`}
            onClick={() => setTypeFilter("all")}
          />
          {FILTER_TYPES.map((type) => {
            const count = eventCounts[type] ?? 0;
            if (count === 0) return null;
            return (
              <FilterChip
                key={type}
                active={typeFilter === type}
                label={`${TRACE_EVENT_LABELS[type]} (${count})`}
                onClick={() => setTypeFilter(type)}
              />
            );
          })}
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted text-[13px]">
              No events match the current filters
            </p>
          ) : (
            filtered.map((record, i) => (
              <TraceEventRow
                key={`${record.event.timestamp}-${record.event.type}-${i}`}
                record={record}
                index={i}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "border-accent bg-accent text-[#fffdf9]"
          : "border-line bg-panel-solid text-muted hover:border-line-strong"
      }`}
    >
      {label}
    </button>
  );
}
