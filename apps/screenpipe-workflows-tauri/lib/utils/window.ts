import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands } from "./tauri";

export async function openSettingsWindow(section?: string) {
  await commands.showWindow({ Home: { page: section ?? null } });
}
export async function openMainWindow() {
  await commands.showWindow("Main");
} 