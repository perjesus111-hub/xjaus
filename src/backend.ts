import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

interface XjausBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openExternal(url: string): Promise<void>;
}
declare global { interface Window { xjaus?: XjausBridge } }

export async function invokeBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (window.xjaus) return window.xjaus.invoke<T>(command, args);
  return tauriInvoke<T>(command, args);
}
export async function openExternalUrl(url: string): Promise<void> {
  if (window.xjaus) return window.xjaus.openExternal(url);
  return tauriOpenUrl(url);
}
