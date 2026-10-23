import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { isAllowedMicrosoftVerificationUri } from './device-login-flow';

interface XjausBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openExternal(url: string): Promise<void>;
  openMicrosoftVerification(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
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

export async function openMicrosoftVerificationUrl(url: string): Promise<void> {
  if (!isAllowedMicrosoftVerificationUri(url)) throw new Error('Microsoft verification URL not permitted');
  if (window.xjaus) return window.xjaus.openMicrosoftVerification(url);
  return tauriOpenUrl(url);
}

export function copyToClipboard(text: string): Promise<void> {
  const userCode = /^[A-Za-z0-9-]{1,64}$/.test(text);
  if (typeof text !== 'string' || text.length > 512 || (!userCode && !isAllowedMicrosoftVerificationUri(text))) {
    throw new Error('Clipboard value not permitted');
  }
  if (window.xjaus) return window.xjaus.copyText(text);
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
  return navigator.clipboard.writeText(text);
}
