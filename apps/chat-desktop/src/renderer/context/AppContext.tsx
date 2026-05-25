import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buildLocalThreadFromMessages } from "@/lib/thread-meta";
import { useWorkspace, type WorkspaceHook } from "@/hooks/useWorkspace";
import { useAgentRun, type AgentRunHook } from "@/hooks/useAgentRun";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppMode, RunState } from "@/types";

interface AppContextValue {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  workspace: WorkspaceHook;
  agentRun: AgentRunHook;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode>("chat");
  const workspace = useWorkspace();
  const agentRun = useAgentRun();
  const prevRunStateRef = useRef<RunState>("idle");
  const prevWorkspacePathRef = useRef<string | null>(null);
  const activeSidebarThreadRef = useRef<string | null>(null);

  useEffect(() => {
    const currentPath = workspace.currentWorkspace?.path ?? null;
    const prevPath = prevWorkspacePathRef.current;
    prevWorkspacePathRef.current = currentPath;
    if (prevPath !== null && currentPath !== prevPath) {
      agentRun.resetConversation();
      activeSidebarThreadRef.current = null;
    }
  }, [workspace.currentWorkspace?.path, agentRun]);

  // Pin thread to sidebar as soon as the user sends (don't wait for agent.done).
  useEffect(() => {
    const { runState, messages, sessionId } = agentRun;
    const { currentWorkspace, threadId, setThreadId, upsertLocalThread, saveThreadSnapshot } =
      workspace;

    if (runState !== "connecting" && runState !== "running") {
      if (runState === "idle" || runState === "completed" || runState === "failed") {
        activeSidebarThreadRef.current = null;
      }
      return;
    }
    if (!currentWorkspace || messages.length === 0) return;

    const id = threadId ?? sessionId;
    if (!id) return;

    const userTurns = messages.filter((m) => m.role === "user").length;
    const pinKey = `${id}:${userTurns}:${runState === "connecting" ? "start" : sessionId ?? "pending"}`;
    if (activeSidebarThreadRef.current === pinKey) return;
    activeSidebarThreadRef.current = pinKey;

    if (!threadId && sessionId) {
      setThreadId(sessionId);
    }

    const thread = buildLocalThreadFromMessages(id, messages, {
      summary: "Agent is working…",
      sessionState: "Running",
    });

    upsertLocalThread(currentWorkspace.path, thread);
    void saveThreadSnapshot(currentWorkspace.path, thread);
  }, [
    agentRun.runState,
    agentRun.messages,
    agentRun.sessionId,
    workspace.currentWorkspace,
    workspace.threadId,
    workspace.setThreadId,
    workspace.upsertLocalThread,
    workspace.saveThreadSnapshot,
  ]);

  useEffect(() => {
    const prev = prevRunStateRef.current;
    const curr = agentRun.runState;
    prevRunStateRef.current = curr;

    const justFinished =
      (prev === "running" || prev === "connecting") &&
      (curr === "completed" || curr === "failed" || curr === "cancelled");
    if (!justFinished) return;

    const { messages, sessionId } = agentRun;
    const { currentWorkspace, threadId, setThreadId, upsertLocalThread, saveThreadSnapshot } =
      workspace;

    if (!currentWorkspace || messages.length === 0) return;

    const id = threadId ?? sessionId ?? `local-${Date.now()}`;
    const thread = buildLocalThreadFromMessages(id, messages, {
      sessionState: curr === "completed" ? "Ready for follow-up" : "Needs attention",
    });

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
