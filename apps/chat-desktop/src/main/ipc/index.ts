import { registerSettingsIpc } from "./settings.ipc.js";
import { registerChatIpc } from "./chat.ipc.js";

export function registerAllIpc(): void {
  registerSettingsIpc();
  registerChatIpc();
}
