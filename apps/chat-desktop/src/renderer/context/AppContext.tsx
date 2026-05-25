import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWorkspace, type WorkspaceHook } from "@/hooks/useWorkspace";
import { useAgentRun, type AgentRunHook } from "@/hooks/useAgentRun";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppMode, LocalThread, RunState } from "@/types";

interface AppContextValue {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  workspace: WorkspaceHook;
  agentRun: AgentRunHook;
}

const AppContext = createContext<AppContextValue | null>(null);

function deriveThreadTitle(firstUserBody: string): string {
  const trimmed = firstUserBody.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 60) return trimmed || "Untitled chat";
  return `${trimmed.slice(0, 57).trimEnd()}...`;
}

function deriveThreadSummary(lastAssistantBody: string): string {
  const trimmed = lastAssistantBody.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197).trimEnd()}...`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode>("chat");
  const workspace = useWorkspace();
  const agentRun = useAgentRun();
  const prevRunStateRef = useRef<RunState>("idle");
  const prevWorkspacePathRef = useRef<string | null>(null);

  useEffect(() => {
    const currentPath = workspace.currentWorkspace?.path ?? null;
    const prevPath = prevWorkspacePathRef.current;
    prevWorkspacePathRef.current = currentPath;
    if (prevPath !== null && currentPath !== prevPath) {
      agentRun.resetConversation();
    }
  }, [workspace.currentWorkspace?.path, agentRun]);

  useEffect(() => {
    const prev = prevRunStateRef.current;
    const curr = agentRun.runState;
    prevRunStateRef.current = curr;

    const justFinished =
      (prev === "running" || prev === "connecting") &&
      (curr === "completed" || curr === "failed");
    if (!justFinished) return;

    const { messages, sessionId } = agentRun;
    const { currentWorkspace, threadId, setThreadId, upsertLocalThread, saveThreadSnapshot } =
      workspace;

    if (!currentWorkspace || messages.length === 0) return;

    const firstUser = messages.find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const id = threadId ?? sessionId ?? `local-${Date.now()}`;
    const now = new Date().toISOString();

    const thread: LocalThread = {
      id,
      title: deriveThreadTitle(firstUser?.body ?? ""),
      summary: deriveThreadSummary(lastAssistant?.body ?? ""),
      updatedAt: now,
      runSessionIds: [
        ...(sessionId ? [sessionId] : []),
        ...(id !== sessionId ? [id] : []),
      ],
      messages: messages.map((m) => ({
        role: m.role,
        body: m.body,
        attachments: m.attachments.length > 0 ? m.attachments : undefined,
        toolCalls: m.toolCalls && m.toolCalls.length > 0 ? m.toolCalls : undefined,
      })),
    };

    upsertLocalThread(currentWorkspace.path, thread);
    void saveThreadSnapshot(currentWorkspace.path, thread);

    if (!threadId) {
      setThreadId(id);
    }
  }, [agentRun.runState, agentRun, workspace]);

  const value = {
    mode,
    setMode: useCallback((next: AppMode) => setMode(next), []),
    workspace,
    agentRun,
  };

  return (
    <AppContext.Provider value={value}>
      <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
