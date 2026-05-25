import { ipcMain } from "electron";
import { loadSettings, saveSettings, type AppSettings } from "../services/settings.js";

export function registerSettingsIpc(): void {
  ipcMain.handle("chat-desktop:get-settings", () => loadSettings());
  ipcMain.handle("chat-desktop:update-settings", async (_event, settings: AppSettings) => {
    await saveSettings(settings);
    return { ok: true };
  });
}
