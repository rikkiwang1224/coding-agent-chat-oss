import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, shell } from "electron";

import { loadRuntimeEnv } from "./main/utils/env.js";
import { disconnectAllAgents } from "./main/services/agent-runner.js";
import { registerAllIpc } from "./main/ipc/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_NAME = "Lattice Code";
const APP_ID = "dev.latticecode.chat";

function resolveRendererAsset(relativePath: string): string {
  const fromDist = path.resolve(__dirname, "renderer", relativePath);
  if (existsSync(fromDist)) return fromDist;
  return path.resolve(__dirname, "../src/renderer", relativePath);
}

function resolvePreloadAsset(): string {
  const fromSrc = path.resolve(__dirname, "../src/preload.cjs");
  if (existsSync(fromSrc)) return fromSrc;
  return path.resolve(__dirname, "preload.cjs");
}

function resolveIconAsset(): string | null {
  const candidates = [
    path.resolve(__dirname, "../build/icon.png"),
    path.resolve(__dirname, "build/icon.png"),
    path.resolve(__dirname, "../src/renderer/assets/icon.png")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isExternalHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function applyAppBranding(): void {
  app.setName(APP_NAME);
  app.setAppUserModelId(APP_ID);

  const iconPath = resolveIconAsset();
  if (!iconPath) return;

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;

  if (process.platform === "darwin") {
    app.dock?.setIcon(icon);
  }
}

function hardenWindowNavigation(window: BrowserWindow): void {
  const rendererUrl = new URL(`file://${resolveRendererAsset("index.html")}`).href;

  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });
}

function createMainWindow(): BrowserWindow {
  const iconPath = resolveIconAsset();
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#f6f3ed",
    title: APP_NAME,
    ...(iconPath ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadAsset(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWindowNavigation(window);
  void window.loadFile(resolveRendererAsset("index.html"));

  if (process.env.DESKTOP_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
}

// ── App lifecycle ──

app.whenReady().then(() => {
  applyAppBranding();
  loadRuntimeEnv(__dirname);
  registerAllIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => disconnectAllAgents());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
