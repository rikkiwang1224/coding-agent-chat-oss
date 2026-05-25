import { Pencil, MoreVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApp } from "@/context/AppContext";

export function ChatTopBar() {
  const { workspace, agentRun } = useApp();
  const { currentWorkspace, threadId, allThreads } = workspace;
  const { runState, messages } = agentRun;

  const selectedThread = allThreads.find((t) => t.id === threadId);
  const title = selectedThread?.title ?? (messages.length > 0 ? "New chat" : "New chat");
  const subtitle = currentWorkspace
    ? `Linked to ${currentWorkspace.name}`
    : "Choose a workspace";

  const statusLabel =
    runState === "connecting"
      ? "Connecting..."
      : runState === "running"
        ? "Agent running"
        : runState === "completed"
          ? "Completed"
          : runState === "failed"
            ? "Failed"
            : "Ready";

  const statusVariant =
    runState === "running" || runState === "connecting"
      ? ("warning" as const)
      : runState === "failed"
        ? ("destructive" as const)
        : runState === "completed"
          ? ("success" as const)
          : ("default" as const);

  return (
    <header className="flex items-center justify-between gap-4 px-1 pb-3">
      <div className="min-w-0">
        <h1 className="text-base font-semibold truncate">{title}</h1>
        <p className="text-xs text-muted truncate">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {currentWorkspace && (
          <>
            <Badge variant="default">
              {currentWorkspace.name}
            </Badge>
            <Badge variant="default">
              {currentWorkspace.branch}
            </Badge>
          </>
        )}
        <Badge variant={statusVariant}>{statusLabel}</Badge>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );
}
