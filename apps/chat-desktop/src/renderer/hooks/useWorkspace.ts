import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktopConfig } from "./useDesktopConfig";
import type {
  WorkspaceState,
  WorkspaceInfo,
  LocalThread,
  ThreadSummary,
  Message,
  ImageAttachment,
  SerializedMessage,
} from "@/types";

interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

function formatRelativeTime(timestamp: string): string {
  const target = new Date(timestamp).getTime();
  if (!Number.isFinite(target)) return "-";
  const delta = Date.now() - target;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))}m`;
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))}h`;
  if (delta < 7 * day) return `${Math.max(1, Math.floor(delta / day))}d`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(target));
}

function getThreadGroupLabel(timestamp: string): string {
  const target = new Date(timestamp);
  if (!Number.isFinite(target.getTime())) return "Earlier";
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const targetDay = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  ).getTime();
  const deltaDays = Math.round((today - targetDay) / (24 * 60 * 60 * 1000));
  if (deltaDays <= 0) return "Today";
  if (deltaDays === 1) return "Yesterday";
  return "Earlier";
}

function groupThreadsByDate(threads: ThreadSummary[]): ThreadGroup[] {
  const grouped = new Map<string, ThreadSummary[]>();
  threads.forEach((t) => {
    const label = getThreadGroupLabel(t.updatedAt);
    const bucket = grouped.get(label) ?? [];
    bucket.push(t);
    grouped.set(label, bucket);
  });
  return ["Today", "Yesterday", "Earlier"]
    .map((label) => ({ label, threads: grouped.get(label) ?? [] }))
    .filter((g) => g.threads.length > 0);
}

function truncateText(value: string, max: number): string {
  const n = value.trim();
  if (n.length <= max) return n;
  return `${n.slice(0, max - 1).trimEnd()}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface WorkspaceHook {
  loading: boolean;
  error: string;
  workspaceData: WorkspaceState;
  currentWorkspace: WorkspaceInfo | null;
  threadId: string | null;
  allThreads: ThreadSummary[];
  threadGroups: ThreadGroup[];
  localThreads: Record<string, LocalThread[]>;
  capabilities: { storedThreads: boolean; legacyThreadImport: boolean };
  setThreadId: (id: string | null) => void;
  loadWorkspaceState: (resetThread?: boolean) => Promise<void>;
  selectWorkspace: (path: string) => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  startNewChat: () => void;
  findLocalThread: (
    workspacePath: string,
    threadId: string,
  ) => LocalThread | null;
  upsertLocalThread: (workspacePath: string, thread: LocalThread) => void;
  getWorkspaceLocalThreads: (workspacePath: string) => LocalThread[];
  saveThreadSnapshot: (
    workspacePath: string,
    thread: LocalThread,
  ) => Promise<void>;
  deleteThread: (workspacePath: string, threadId: string) => Promise<void>;
}

export function useWorkspace(): WorkspaceHook {
  const config = getDesktopConfig();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspaceData, setWorkspaceData] = useState<WorkspaceState>({
    activeWorkspacePath: null,
    workspaces: [],
  });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [localThreads, setLocalThreads] = useState<
    Record<string, LocalThread[]>
  >({});
  const [capabilities, setCapabilities] = useState({
    storedThreads: false,
    legacyThreadImport: false,
  });
  const initializedRef = useRef(false);

  const currentWorkspace =
    workspaceData.workspaces.find(
      (w) => w.path === workspaceData.activeWorkspacePath,
    ) ??
    workspaceData.workspaces[0] ??
    null;

  const normalizeWorkspaceState = useCallback((next: Partial<WorkspaceState> | undefined | null): WorkspaceState => {
    const workspaces = Array.isArray(next?.workspaces) ? next.workspaces : [];
    const activeWorkspacePath = next?.activeWorkspacePath ?? null;
    return {
      activeWorkspacePath,
      workspaces,
    };
  }, []);

  const getWorkspaceLocalThreads = useCallback(
    (path: string): LocalThread[] => {
      return localThreads[path] ?? [];
    },
    [localThreads],
  );

  const findLocalThread = useCallback(
    (workspacePath: string, tid: string): LocalThread | null => {
      if (!workspacePath || !tid) return null;
      return (
        getWorkspaceLocalThreads(workspacePath).find((t) => t.id === tid) ??
        null
      );
    },
    [getWorkspaceLocalThreads],
  );

  const getAllThreads = useCallback(
    (ws: WorkspaceInfo | null): ThreadSummary[] => {
      if (!ws) return [];
      const local = getWorkspaceLocalThreads(ws.path);
      const hiddenIds = new Set(local.flatMap((t) => t.runSessionIds));
      const persisted =
        ws.threadGroups
          ?.flatMap((g) => g.threads)
          .filter((t) => !hiddenIds.has(t.id)) ?? [];
      const merged: ThreadSummary[] = [
        ...local.map(
          (t): ThreadSummary => ({
            id: t.id,
            title: t.title,
            summary: t.summary,
            time: formatRelativeTime(t.updatedAt),
            placeholder: t.placeholder,
            sessionState: t.sessionState || "Saved thread",
            scope: t.scope || "Workspace root",
            updatedAt: t.updatedAt,
            isLocal: true,
          }),
        ),
        ...persisted,
      ];
      return merged.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },
    [getWorkspaceLocalThreads],
  );

  const allThreads = getAllThreads(currentWorkspace);
  const threadGroupsList = groupThreadsByDate(allThreads);

  const upsertLocalThread = useCallback(
    (workspacePath: string, thread: LocalThread) => {
      setLocalThreads((prev) => {
        const existing = prev[workspacePath] ?? [];
        const next = [
          thread,
          ...existing.filter((t) => t.id !== thread.id),
        ].sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        return { ...prev, [workspacePath]: next };
      });
    },
    [],
  );

  const saveThreadSnapshot = useCallback(
    async (workspacePath: string, thread: LocalThread) => {
      if (!workspacePath) return;
      if (capabilities.storedThreads && config.saveStoredThread) {
        try {
          await config.saveStoredThread(workspacePath, thread);
        } catch {
          /* ignore */
        }
      }
    },
    [capabilities.storedThreads, config],
  );

  const deleteThread = useCallback(
    async (workspacePath: string, tid: string) => {
      if (!workspacePath || !tid) return;
      if (config.deleteStoredThread) {
        try {
          await config.deleteStoredThread(workspacePath, tid);
        } catch {
          /* ignore */
        }
      }
      setLocalThreads((prev) => {
        const existing = prev[workspacePath] ?? [];
        const next = existing.filter((t) => t.id !== tid);
        return { ...prev, [workspacePath]: next };
      });
      // Also remove from persisted threadGroups (session-index based threads)
      setWorkspaceData((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((ws) => {
          if (ws.path !== workspacePath) return ws;
          return {
            ...ws,
            threadGroups: ws.threadGroups?.map((g) => ({
              ...g,
              threads: g.threads.filter((t) => t.id !== tid),
            })) ?? [],
          };
        }),
      }));
    },
    [config],
  );

  const hydrateStoredThreads = useCallback(
    async (workspaces: WorkspaceInfo[], enabledOverride?: boolean) => {
      const enabled = enabledOverride ?? capabilities.storedThreads;
      if (!enabled || !config.getStoredThreads) return;
      const entries = await Promise.all(
        workspaces.map(async (ws) => {
          if (!ws?.path) return [null, []] as const;
          try {
            const threads = await config.getStoredThreads!(ws.path);
            return [ws.path, Array.isArray(threads) ? threads : []] as const;
          } catch {
            return [ws.path, []] as const;
          }
        }),
      );
      setLocalThreads((prev) => ({
        ...prev,
        ...Object.fromEntries(
          entries.filter(([p]) => typeof p === "string") as [
            string,
            LocalThread[],
          ][],
        ),
      }));
    },
    [capabilities.storedThreads, config],
  );

  const loadWorkspaceStateImpl = useCallback(
    async (resetThread = true, storedThreadsEnabled?: boolean) => {
      if (!config.getWorkspaceState) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const next = await config.getWorkspaceState();
        setWorkspaceData(normalizeWorkspaceState(next));
        if (resetThread) setThreadId(null);
        await hydrateStoredThreads(
          Array.isArray(next?.workspaces) ? next.workspaces : [],
          storedThreadsEnabled,
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load workspaces",
        );
      } finally {
        setLoading(false);
      }
    },
    [config, hydrateStoredThreads, normalizeWorkspaceState],
  );

  const selectWorkspace = useCallback(
    async (path: string) => {
      if (!config.setActiveWorkspace) return;
      try {
        setError("");
        const next = await config.setActiveWorkspace(path);
        setWorkspaceData(normalizeWorkspaceState(next));
        setThreadId(null);
        await hydrateStoredThreads(
          Array.isArray(next?.workspaces) ? next.workspaces : [],
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to switch workspace",
        );
      }
    },
    [config, hydrateStoredThreads, normalizeWorkspaceState],
  );

  const chooseWorkspace = useCallback(async () => {
    if (!config.pickWorkspace) {
      setError("Folder picker bridge is unavailable");
      return;
    }
    try {
      const next = await config.pickWorkspace();
      setWorkspaceData(normalizeWorkspaceState(next));
      setThreadId(null);
      setError("");
      await hydrateStoredThreads(
        Array.isArray(next?.workspaces) ? next.workspaces : [],
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to open folder picker",
      );
    }
  }, [config, hydrateStoredThreads, normalizeWorkspaceState]);

  const startNewChat = useCallback(() => {
    setThreadId(null);
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      if (!config.debugPing) {
        setError("IPC bridge is unavailable");
        setLoading(false);
        return;
      }
      let hasStoredThreads = false;
      try {
        const info = await config.debugPing();
        const caps = info?.capabilities;
        hasStoredThreads = Boolean(caps?.storedThreads);
        setCapabilities({
          storedThreads: hasStoredThreads,
          legacyThreadImport: Boolean(caps?.legacyThreadImport),
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "IPC bridge failed",
        );
        setLoading(false);
        return;
      }
      await loadWorkspaceStateImpl(true, hasStoredThreads);
    })();
  }, [config, loadWorkspaceStateImpl]);

  return {
    loading,
    error,
    workspaceData,
    currentWorkspace,
    threadId,
    allThreads,
    threadGroups: threadGroupsList,
    localThreads,
    capabilities,
    setThreadId,
    loadWorkspaceState: loadWorkspaceStateImpl,
    selectWorkspace,
    chooseWorkspace,
    startNewChat,
    findLocalThread,
    upsertLocalThread,
    getWorkspaceLocalThreads,
    saveThreadSnapshot,
    deleteThread,
  };
}
