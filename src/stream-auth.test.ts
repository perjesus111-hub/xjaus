import { describe, expect, it, vi } from "vitest";
import { provisionWithFreshAuth, microsoftSessionExpired, appendMicrosoftReauth } from "./stream-auth";

describe("expired MSA transfer token recovery", () => {
  const expired = 'MsaVeto UserNeedsToSignInAgainWithMSA Details Expired';
  it("stops only the failed own session then retries the same start/profile once", async () => {
    const calls: Array<[string, unknown]> = [];
    let provisions = 0;
    const invoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
      calls.push([cmd, args]);
      if (cmd === "provision_stream" && ++provisions === 1) throw new Error(expired);
      return { state: "Provisioned" } as T;
    };
    const args = { kind: "cloud" as const, target: "1000XRESIST", profile: { width: 2560 }, streamingLocale: "en-US" };
    expect(await provisionWithFreshAuth(invoke, args)).toEqual({ state: "Provisioned" });
    expect(calls.map(([cmd]) => cmd)).toEqual(["start_stream", "provision_stream", "stop_stream", "start_stream", "provision_stream"]);
    expect(calls[0][1]).toEqual({ args });
    expect(calls[3][1]).toEqual({ args });
  });
  it("bounds recovery to one retry", async () => {
    const calls: string[] = [];
    const invoke = async <T>(cmd: string): Promise<T> => {
      calls.push(cmd);
      if (cmd === "provision_stream") throw new Error(expired);
      return undefined as T;
    };
    await expect(provisionWithFreshAuth(invoke, { kind: "cloud", target: "ABSOLUM", profile: null })).rejects.toThrow("UserNeedsToSignInAgainWithMSA");
    expect(calls).toEqual(["start_stream", "provision_stream", "stop_stream", "start_stream", "provision_stream"]);
  });
  it("never retries entitlement or other failures, or starts after cleanup fails", async () => {
    for (const failure of ["UserNotEntitled", "ConcurrentStreamDisallowed", "MsaVeto Unknown"]) {
      const calls: string[] = [];
      const invoke = async <T>(cmd: string): Promise<T> => { calls.push(cmd); if (cmd === "provision_stream") throw new Error(failure); return undefined as T; };
      await expect(provisionWithFreshAuth(invoke, { kind: "cloud", target: "ABSOLUM", profile: null })).rejects.toThrow(failure);
      expect(calls).toEqual(["start_stream", "provision_stream"]);
    }
    const calls: string[] = [];
    const invoke = async <T>(cmd: string): Promise<T> => { calls.push(cmd); if (cmd === "provision_stream") throw new Error(expired); if (cmd === "stop_stream") throw new Error("cleanup failed"); return undefined as T; };
    await expect(provisionWithFreshAuth(invoke, { kind: "cloud", target: "ABSOLUM", profile: null })).rejects.toThrow("cleanup failed");
    expect(calls).toEqual(["start_stream", "provision_stream", "stop_stream"]);
  });
  it("offers a Microsoft re-login button that calls the existing OAuth action only when clicked", () => {
    const actions = new Map<string, () => void>();
    const button = { type: "", textContent: "", addEventListener: (event: string, action: () => void) => actions.set(event, action) };
    const append = vi.fn();
    const login = vi.fn();
    vi.stubGlobal("document", { createElement: (tag: string) => tag === "button" ? button : { tag } });
    try {
      appendMicrosoftReauth({ append } as unknown as HTMLElement, login);
      expect(button.type).toBe("button");
      expect(button.textContent).toBe("Tu sesión de Microsoft ha expirado. Haz clic aquí para iniciar sesión nuevamente");
      expect(append).toHaveBeenCalledOnce();
      expect(login).not.toHaveBeenCalled();
      actions.get("click")!();
      expect(login).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  it("recognizes root OAuth expiry without classifying title policy failures as auth expiry", () => {
    expect(microsoftSessionExpired("Transfer token: invalid_grant")).toBe(true);
    expect(microsoftSessionExpired("refresh_token expired")).toBe(true);
    expect(microsoftSessionExpired("Transfer token: Xbox/Microsoft rechazó la autenticación: lpt: expired_token")).toBe(true);
    expect(microsoftSessionExpired("Xbox/Microsoft rechazó la autenticación: expired_token")).toBe(true);
    expect(microsoftSessionExpired("UserNeedsToSignInAgainWithMSA Details Expired")).toBe(true);
    expect(microsoftSessionExpired("UserNotEntitled")).toBe(false);
    expect(microsoftSessionExpired("ConcurrentStreamDisallowed")).toBe(false);
  });
});
