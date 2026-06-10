import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatCostUsd } from "@lattice-code/sdk-runtime";
import { formatTraceTimestamp, shortenSessionId } from "@/lib/trace-format";
import type { SelectedTrace } from "@/hooks/useTraces";
import type { TraceSummary } from "@/types";

interface TraceListPanelProps {
  summaries: TraceSummary[];
  selected: SelectedTrace | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelect: (workspaceRoot: string, sessionId: string) => void;
}

function traceKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}::${sessionId}`;
}

export function TraceListPanel({
  summaries,
  selected,
  loading,
  error,
  onRefresh,
  onSelect,
}: TraceListPanelProps) {
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { workspaceRoot: string; workspaceName: string; chats: TraceSummary[] }
    >();
    for (const item of summaries) {
      const key = item.workspaceRoot;
      const bucket = map.get(key) ?? {
        workspaceRoot: item.workspaceRoot,
        workspaceName: item.workspaceName,
        chats: [],
      };
      bucket.chats.push(item);
      map.set(key, bucket);
    }
    return [...map.values()].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
  }, [summaries]);

  const workspaceCount = grouped.length;
  const selectedKey = selected ? traceKey(selected.workspaceRoot, selected.sessionId) : null;

  return (
    <div className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-line bg-panel-solid/40">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div>
          <h2 className="text-[14px] font-semibold">Chats</h2>
          <p className="text-[11px] text-muted">
            {workspaceCount} workspace(s) · {summaries.length} chat(s)
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh traces"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {error && (
        <p className="px-3 py-2 text-[12px] text-error border-b border-line">{error}</p>
      )}

      <ScrollArea className="flex-1 min-h-0">
        {loading && summaries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted text-[13px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : summaries.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted leading-relaxed">
            No chats yet. Run the agent in any workspace — logs are stored under{" "}
            <code className="text-[11px] font-mono">~/.lattice-code/workspaces/</code>
          </p>
        ) : (
          <div className="py-1">
            {grouped.map((group) => (
              <section key={group.workspaceRoot} className="mb-2">
                <h3 className="sticky top-0 z-10 bg-panel-solid/95 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-soft border-b border-line/60">
                  {group.workspaceName}
                </h3>
                <ul>
                  {group.chats.map((s) => {
                    const title = s.title?.trim();
                    const key = traceKey(s.workspaceRoot, s.sessionId);
                    const active = selectedKey === key;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() => onSelect(s.workspaceRoot, s.sessionId)}
                          className={cn(
                            "w-full px-3 py-2.5 text-left transition-colors border-l-2",
                            active
                              ? "border-accent bg-white/60"
                              : "border-transparent hover:bg-white/35",
                          )}
                        >
                          <p className="text-[13px] font-semibold truncate">
                            {title || shortenSessionId(s.sessionId)}
                          </p>
                          {title && (
                            <p className="text-[11px] font-mono text-soft truncate mt-0.5">
                              {shortenSessionId(s.sessionId)}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted">
                            <span>{s.runCount} run(s)</span>
                            {s.totalCostUsd !== undefined && (
                              <span>{formatCostUsd(s.totalCostUsd)}</span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] text-soft">
                            {formatTraceTimestamp(s.lastEventAt ?? s.startedAt)}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
