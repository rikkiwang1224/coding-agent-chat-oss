import { ScrollText } from "lucide-react";
import { useTraces } from "@/hooks/useTraces";
import { TraceListPanel } from "./TraceListPanel";
import { TraceRunPanel } from "./TraceRunPanel";
import { shortenSessionId } from "@/lib/trace-format";

export function TraceDashboard() {
  const traces = useTraces();

  const selectedSummary = traces.selected
    ? traces.summaries.find(
        (s) =>
          s.sessionId === traces.selected!.sessionId &&
          s.workspaceRoot === traces.selected!.workspaceRoot,
      )
    : null;

  const headerSubtitle = selectedSummary
    ? `${selectedSummary.workspaceName} · ${selectedSummary.title?.trim() || shortenSessionId(selectedSummary.sessionId)}`
    : `${traces.summaries.length} chats across all workspaces`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-[#fffdf9]">
          <ScrollText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Chat traces</h1>
          <p className="text-sm text-muted truncate">{headerSubtitle}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <TraceListPanel
          summaries={traces.summaries}
          selected={traces.selected}
          loading={traces.loadingList}
          error={traces.listError}
          onRefresh={() => void traces.refreshList()}
          onSelect={(workspaceRoot, sessionId) => void traces.loadDetail(workspaceRoot, sessionId)}
        />
        <TraceRunPanel
          sessionId={traces.selected?.sessionId ?? null}
          detail={traces.detail}
          loading={traces.loadingDetail}
          error={traces.detailError}
        />
      </div>
    </div>
  );
}
