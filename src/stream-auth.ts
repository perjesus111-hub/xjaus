import { t, bindText } from './i18n';
export type StreamStart = { kind: "home" | "cloud"; target: string; profile: Record<string, unknown> | null; streamingLocale?: string };
type Provisioned = { state?: string; provisioning?: Record<string, number> | null };
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function microsoftSessionExpired(error: unknown): boolean {
  const message = String(error);
  return /invalid_grant|expired_token|token_expired/i.test(message)
    || /(?:lpt|oauth|refresh).*\bexpired\b/i.test(message)
    || /(?:refresh[_ -]?token.*expired|expired.*refresh[_ -]?token)/i.test(message)
    || (/UserNeedsToSignInAgainWithMSA/.test(message) && /Expired/i.test(message));
}

export function appendMicrosoftReauth(container: HTMLElement, onReauth: () => void): void {
  const reauth = document.createElement("button");
  reauth.type = "button";
  bindText(reauth,()=>t('reauth'));
  reauth.addEventListener("click", onReauth);
  container.append(document.createElement("br"), reauth);
}

export async function provisionWithFreshAuth(invoke: Invoke, args: StreamStart): Promise<Provisioned> {
  // Each start obtains a fresh transfer token in both native backends. Never
  // replay SDP/ICE, and never stop an unrelated session on a failed start.
  await invoke("start_stream", { args });
  try {
    return await invoke<Provisioned>("provision_stream");
  } catch (error) {
    const message = String(error);
    if (!/UserNeedsToSignInAgainWithMSA/.test(message) || !/Expired/i.test(message)) throw error;
    // Stop must succeed before another play; this is our own failed provision.
    await invoke("stop_stream");
    await invoke("start_stream", { args });
    return await invoke<Provisioned>("provision_stream");
  }
}
