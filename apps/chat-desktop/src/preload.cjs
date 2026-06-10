const { contextBridge, ipcRenderer } = require("electron");

function resolveAppName() {
  try {
    const payload = ipcRenderer.sendSync("chat-desktop:get-runtime-env");
    if (payload && typeof payload.appName === "string") {
      return payload.appName;
    }
  } catch (error) {
    console.error("[preload] failed to resolve runtime env from main process", error);
  }
  return "Lattice Code";
}

contextBridge.exposeInMainWorld("desktopConfig", {
  appName: resolveAppName(),
  getWorkspaceState: () => ipcRenderer.invoke("chat-desktop:get-workspace-state"),
  pickWorkspace: () => ipcRenderer.invoke("chat-desktop:pick-workspace"),
  pickImages: () => ipcRenderer.invoke("chat-desktop:pick-images"),
  pasteClipboardImage: () => ipcRenderer.invoke("chat-desktop:paste-clipboard-image"),
  savePastedImage: (input) => ipcRenderer.invoke("chat-desktop:save-pasted-image", input),
  setActiveWorkspace: (workspacePath) => ipcRenderer.invoke("chat-desktop:set-active-workspace", workspacePath),
  getStoredThreads: (workspacePath) => ipcRenderer.invoke("chat-desktop:get-stored-threads", workspacePath),
  loadSessionThread: (workspacePath, sessionId) => ipcRenderer.invoke("chat-desktop:load-session-thread", workspacePath, sessionId),
  saveStoredThread: (workspacePath, thread) => ipcRenderer.invoke("chat-desktop:save-thread", workspacePath, thread),
  deleteStoredThread: (workspacePath, threadId) => ipcRenderer.invoke("chat-desktop:delete-thread", workspacePath, threadId),
  importLegacyThreads: (payload) => ipcRenderer.invoke("chat-desktop:import-legacy-threads", payload),
  startRun: (input) => ipcRenderer.invoke("chat-desktop:start-run", input),
  resumeRun: (input) => ipcRenderer.invoke("chat-desktop:resume-run", input),
  cancelRun: () => ipcRenderer.invoke("chat-desktop:cancel-run"),
  respondPermission: (requestId, outcome) =>
    ipcRenderer.invoke("chat-desktop:respond-permission", requestId, outcome),
  onAgentEvent: (listener) => {
    ipcRenderer.removeAllListeners("chat-desktop:agent-event");
    if (typeof listener !== "function") return;
    ipcRenderer.on("chat-desktop:agent-event", (_event, payload) => {
      listener(payload);
    });
  },
  debugPing: () => ipcRenderer.invoke("chat-desktop:debug-ping"),
  getSettings: () => ipcRenderer.invoke("chat-desktop:get-settings"),
  updateSettings: (settings) => ipcRenderer.invoke("chat-desktop:update-settings", settings),
  listTraces: (workspacePath) =>
    ipcRenderer.invoke("chat-desktop:list-traces", workspacePath ?? ""),
  listAllTraces: () => ipcRenderer.invoke("chat-desktop:list-traces", ""),
  loadTrace: (workspacePath, sessionId) =>
    ipcRenderer.invoke("chat-desktop:load-trace", workspacePath, sessionId),
});
