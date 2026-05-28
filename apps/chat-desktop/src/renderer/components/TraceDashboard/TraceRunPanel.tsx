import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  Wrench,
  XCircle,
} from "lucide-react";
import { formatCostUsd } from "@forgelet/sdk-runtime";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { aggregateTraceRuns } from "@/lib/trace-runs";
import { formatDuration, formatTraceTimestamp } from "@/lib/trace-format";
import type { DesktopTraceDetail } from "@/types";

interface TraceRunPanelProps {
  sessionId: string | null;
  detail: DesktopTraceDetail | null;
  loading: boolean;
  error: string | null;
}

export function TraceRunPanel({ sessionId, detail, loading, error }: TraceRunPanelProps) {
  const analysis = useMemo(
    () => (detail?.records ? aggregateTraceRuns(detail.records) : null),
    [detail],
  );

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted text-[14px]">
        Select a chat to see runs, tools, duration, and cost
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
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

  if (!analysis || analysis.runs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted text-[14px] px-6 text-center">
        No runs recorded for this chat yet
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-[12px] text-muted">
        <span>
          <strong className="text-text font-semibold">{analysis.totalRuns}</strong> runs
        </span>
        {analysis.totalCostUsd !== undefined && (
          <span>
            Session total{" "}
            <strong className="text-text font-semibold">
              {formatCostUsd(analysis.totalCostUsd)}
            </strong>
          </span>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-2 p-3">
          {analysis.runs.map((run) => (
            <RunCard key={run.taskId} run={run} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function RunCard({ run }: { run: ReturnType<typeof aggregateTraceRuns>["runs"][number] }) {
  const [open, setOpen] = useState(true);
  const statusIcon =
    run.status === "completed" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-positive shrink-0" />
    ) : run.status === "failed" ? (
      <XCircle className="h-3.5 w-3.5 text-error shrink-0" />
    ) : (
      <Loader2 className="h-3.5 w-3.5 text-warning animate-spin shrink-0" />
    );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-line bg-panel-solid/70 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-white/50 transition-colors"
          >
            <ChevronRight
              className={cn(
                "mt-1 h-3.5 w-3.5 shrink-0 text-soft transition-transform",
                open && "rotate-90",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {statusIcon}
                <span className="text-[13px] font-semibold text-text">
                  Run {run.runIndex}
                </span>
                <span className="text-[11px] text-soft">
                  {formatTraceTimestamp(run.startedAt)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
                <span>{formatDuration(run.durationMs)}</span>
                {run.costUsd !== undefined && (
                  <span>{formatCostUsd(run.costUsd)}</span>
                )}
                {run.numTurns !== undefined && (
                  <span>{run.numTurns} agent turns</span>
                )}
                {run.tools.length > 0 && (
                  <span>{run.tools.length} tool(s)</span>
                )}
              </div>
              <p className="mt-1.5 text-[12px] text-text line-clamp-2">{run.userPrompt}</p>
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-line px-3 py-2 space-y-2">
            {(run.inputTokens !== undefined || run.outputTokens !== undefined) && (
              <p className="text-[11px] text-soft">
                Tokens:{" "}
                {run.inputTokens !== undefined ? `${run.inputTokens.toLocaleString()} in` : ""}
                {run.inputTokens !== undefined && run.outputTokens !== undefined ? " / " : ""}
                {run.outputTokens !== undefined ? `${run.outputTokens.toLocaleString()} out` : ""}
              </p>
            )}
            {run.summary && (
              <p className="text-[12px] text-muted whitespace-pre-wrap line-clamp-4">
                {run.summary}
              </p>
            )}
            {run.tools.length > 0 ? (
              <ul className="space-y-1">
                {run.tools.map((tool) => (
                  <li
                    key={tool.toolCallId}
                    className="flex items-start gap-2 rounded-lg bg-white/50 px-2.5 py-1.5 text-[12px]"
                  >
                    <Wrench className="h-3 w-3 shrink-0 text-soft mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium text-text">{tool.toolName}</span>
                        {tool.durationMs !== undefined && (
                          <span className="text-soft">{formatDuration(tool.durationMs)}</span>
                        )}
                        {tool.status === "error" && (
                          <span className="text-error text-[11px]">failed</span>
                        )}
                      </div>
                      {tool.argsPreview && (
                        <p className="text-soft truncate font-mono text-[11px] mt-0.5">
                          {tool.argsPreview}
                        </p>
                      )}
                      {tool.error && (
                        <p className="text-error text-[11px] mt-0.5 line-clamp-2">{tool.error}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-soft">No tool calls in this run</p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
