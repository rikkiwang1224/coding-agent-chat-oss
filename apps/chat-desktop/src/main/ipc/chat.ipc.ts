import { ipcMain } from "electron";
import {
  listStoredThreads,
  saveStoredThread,
  deleteStoredThread,
  importLegacyThreads,
  loadSessionThread,
} from "../services/thread-store.js";
import {
  getWorkspaceState,
  setActiveWorkspace,
  chooseWorkspace,
} from "../services/workspace-state.js";
import {
  pickImageAttachments,
  readClipboardImagePayload,
  pasteClipboardImage,
  savePastedImage,
  type PersistPastedImageInput,
} from "../services/clipboard.js";
import {
  startAgentRun,
  handleRespondPermission,
  disconnectActiveAgent,
  type StartAgentRunInput,
} from "../services/agent-runner.js";
import { listAllDesktopTraces, listDesktopTraces, loadDesktopTrace } from "../services/trace-store.js";

export function registerChatIpc(): void {
  ipcMain.on("chat-desktop:get-runtime-env", (event) => {
    event.returnValue = { appName: "Forgelet" };
  });

  ipcMain.handle("chat-desktop:get-workspace-state", () => getWorkspaceState());
  ipcMain.handle("chat-desktop:pick-workspace", () => chooseWorkspace());
  ipcMain.handle("chat-desktop:pick-images", () => pickImageAttachments());
  ipcMain.handle("chat-desktop:read-clipboard-image", () => readClipboardImagePayload());
  ipcMain.handle("chat-desktop:paste-clipboard-image", () => pasteClipboardImage());
  ipcMain.handle("chat-desktop:save-pasted-image", (_event, input: PersistPastedImageInput | undefined) =>
    savePastedImage(input),
  );
  ipcMain.handle("chat-desktop:set-active-workspace", (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) return getWorkspaceState();
    return setActiveWorkspace(workspacePath);
  });
  ipcMain.handle("chat-desktop:start-run", (event, input: StartAgentRunInput | undefined) =>
    startAgentRun(event, input),
  );
  ipcMain.handle("chat-desktop:resume-run", (event, input: StartAgentRunInput | undefined) =>
    startAgentRun(event, { ...input, runMode: "resume" }),
  );
  ipcMain.handle("chat-desktop:cancel-run", (event) => {
    disconnectActiveAgent(event.sender.id);
    return { ok: true };
  });
  ipcMain.handle(
    "chat-desktop:respond-permission",
    (_event, requestId: unknown, outcome: unknown) => {
      if (typeof requestId !== "string" || !requestId.trim()) return false;
      const valid = outcome === "allow_once" || outcome === "allow_always" || outcome === "deny";
      if (!valid) return false;
      return handleRespondPermission(requestId, outcome);
    },
  );
  ipcMain.handle("chat-desktop:get-stored-threads", (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) return [];
    return listStoredThreads(workspacePath);
  });
  ipcMain.handle("chat-desktop:load-session-thread", (_event, workspacePath: unknown, sessionId: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) return null;
    if (typeof sessionId !== "string" || !sessionId.trim()) return null;
    return loadSessionThread(workspacePath, sessionId);
  });
  ipcMain.handle("chat-desktop:save-thread", (_event, workspacePath: unknown, thread: unknown) => {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) throw new Error("Workspace path is required");
    return saveStoredThread(workspacePath, thread);
  });
  ipcMain.handle("chat-desktop:delete-thread", (_event, workspacePath: unknown, threadId: unknown) => {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) throw new Error("Workspace path is required");
    if (typeof threadId !== "string" || threadId.trim().length === 0) throw new Error("Thread ID is required");
    return deleteStoredThread(workspacePath, threadId);
  });
  ipcMain.handle("chat-desktop:import-legacy-threads", (_event, payload: unknown) => importLegacyThreads(payload));
  ipcMain.handle("chat-desktop:debug-ping", () => ({
    ok: true,
    timestamp: new Date().toISOString(),
    capabilities: { storedThreads: true, legacyThreadImport: true },
  }));
  ipcMain.handle("chat-desktop:list-traces", (_event, workspacePath: unknown) => {
    if (typeof workspacePath === "string" && workspacePath.trim()) {
      return listDesktopTraces(workspacePath);
    }
    return listAllDesktopTraces();
  });
  ipcMain.handle(
    "chat-desktop:load-trace",
    (_event, workspacePath: unknown, sessionId: unknown) => {
      if (typeof workspacePath !== "string" || !workspacePath.trim()) return null;
      if (typeof sessionId !== "string" || !sessionId.trim()) return null;
      return loadDesktopTrace(workspacePath, sessionId);
    },
  );
}
