import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import {
  resolveDefaultWorkspacePath,
  normalizeWorkspacePaths,
  discoverWorkspacePaths,
  readGitBranch,
} from "../utils/workspace.js";
import {
  listWorkspaceThreads,
  groupThreads,
  type ChatDesktopThreadSummary,
  type ChatDesktopThreadGroup,
} from "./thread-store.js";

const WORKSPACE_STATE_FILENAME = "chat-desktop-workspaces.json";

export interface PersistedWorkspaceConfig {
  activeWorkspacePath?: string;
  activeChatWorkspacePath?: string;
  recentWorkspacePaths: string[];
}

export interface ChatDesktopWorkspaceSummary {
  id: string;
  name: string;
  path: string;
  branch: string;
  threadCount: number;
  threadGroups: ChatDesktopThreadGroup[];
}

export interface ChatDesktopWorkspaceState {
  activeWorkspacePath: string | null;
  workspaces: ChatDesktopWorkspaceSummary[];
}

function getWorkspaceStateFilePath(): string {
  return path.join(app.getPath("userData"), WORKSPACE_STATE_FILENAME);
}

export async function loadPersistedWorkspaceConfig(): Promise<PersistedWorkspaceConfig> {
  try {
    const raw = await readFile(getWorkspaceStateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceConfig>;
    const activeChatWorkspacePath =
      typeof parsed.activeChatWorkspacePath === "string" && parsed.activeChatWorkspacePath.trim().length > 0
        ? parsed.activeChatWorkspacePath
        : parsed.activeWorkspacePath;
    return {
      activeWorkspacePath:
        typeof activeChatWorkspacePath === "string" && activeChatWorkspacePath.trim().length > 0
          ? path.resolve(activeChatWorkspacePath)
          : undefined,
      activeChatWorkspacePath:
        typeof activeChatWorkspacePath === "string" && activeChatWorkspacePath.trim().length > 0
          ? path.resolve(activeChatWorkspacePath)
          : undefined,
      recentWorkspacePaths: Array.isArray(parsed.recentWorkspacePaths)
        ? parsed.recentWorkspacePaths
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => path.resolve(v))
        : [],
    };
  } catch {
    return { recentWorkspacePaths: [] };
  }
}

export async function savePersistedWorkspaceConfig(config: PersistedWorkspaceConfig): Promise<void> {
  const target = getWorkspaceStateFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(config, null, 2), "utf8");
}

async function summarizeWorkspace(workspacePath: string): Promise<ChatDesktopWorkspaceSummary> {
  const threads = await listWorkspaceThreads(workspacePath);
  return {
    id: workspacePath,
    name: path.basename(workspacePath),
    path: workspacePath,
    branch: readGitBranch(workspacePath),
    threadCount: threads.length,
    threadGroups: groupThreads(threads),
  };
}

async function buildWorkspaceState(
  persistedConfig?: PersistedWorkspaceConfig,
): Promise<{ state: ChatDesktopWorkspaceState; config: PersistedWorkspaceConfig }> {
  const persisted = persistedConfig ?? (await loadPersistedWorkspaceConfig());
  const defaultWorkspace = resolveDefaultWorkspacePath();
  const discovered = defaultWorkspace ? await discoverWorkspacePaths(defaultWorkspace) : [];
  const activeChatWorkspacePath = persisted.activeChatWorkspacePath ?? persisted.activeWorkspacePath;

  const workspacePaths = normalizeWorkspacePaths([
    activeChatWorkspacePath,
    ...persisted.recentWorkspacePaths,
    defaultWorkspace,
    ...discovered,
  ]);

  const workspaces = await Promise.all(workspacePaths.map(summarizeWorkspace));
  const activeWorkspacePath =
    workspacePaths.find((wp) => wp === activeChatWorkspacePath) ?? workspaces[0]?.path ?? null;

  const nextConfig: PersistedWorkspaceConfig = {
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    activeChatWorkspacePath: activeWorkspacePath ?? undefined,
    recentWorkspacePaths: workspaces.map((ws) => ws.path),
  };

  return { state: { activeWorkspacePath, workspaces }, config: nextConfig };
}

export async function getWorkspaceState(): Promise<ChatDesktopWorkspaceState> {
  const { state, config } = await buildWorkspaceState();
  await savePersistedWorkspaceConfig(config);
  return state;
}

export async function setActiveWorkspace(workspacePath: string): Promise<ChatDesktopWorkspaceState> {
  const persisted = await loadPersistedWorkspaceConfig();
  const activeChatWorkspacePath = path.resolve(workspacePath);
  const nextConfig: PersistedWorkspaceConfig = {
    activeWorkspacePath: activeChatWorkspacePath,
    activeChatWorkspacePath,
    recentWorkspacePaths: normalizeWorkspacePaths([workspacePath, ...persisted.recentWorkspacePaths]),
  };
  await savePersistedWorkspaceConfig(nextConfig);
  const { state, config } = await buildWorkspaceState(nextConfig);
  await savePersistedWorkspaceConfig(config);
  return state;
}

export async function chooseWorkspace(): Promise<ChatDesktopWorkspaceState> {
  const persisted = await loadPersistedWorkspaceConfig();
  const options: Electron.OpenDialogOptions = {
    title: "Choose a codebase",
    buttonLabel: "Open codebase",
    defaultPath: persisted.activeChatWorkspacePath ?? persisted.activeWorkspacePath ?? resolveDefaultWorkspacePath() ?? app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  };
  const ownerWindow = BrowserWindow.getFocusedWindow();
  ownerWindow?.focus();
  const filePaths = ownerWindow
    ? dialog.showOpenDialogSync(ownerWindow, options)
    : dialog.showOpenDialogSync(options);

  if (!filePaths || filePaths.length === 0) return getWorkspaceState();
  return setActiveWorkspace(filePaths[0]);
}
