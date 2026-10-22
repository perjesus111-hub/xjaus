import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard, invokeBackend, openExternalUrl, openMicrosoftVerificationUrl } from "./backend";

afterEach(() => { vi.unstubAllGlobals(); });
describe("Electron backend adapter", () => {
  it("routes only named commands through the isolated bridge", async () => {
    const invoke = vi.fn(async () => ({ authenticated: true }));
    vi.stubGlobal("window", { xjaus: { invoke, openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText: vi.fn() } });
    expect(await invokeBackend("auth_status")).toEqual({ authenticated: true });
    expect(invoke).toHaveBeenCalledWith("auth_status", undefined);
  });
  it("delegates existing approved external URLs to main process", async () => {
    const openExternal = vi.fn(async () => {});
    vi.stubGlobal("window", { xjaus: { invoke: vi.fn(), openExternal, openMicrosoftVerification: vi.fn(), copyText: vi.fn() } });
    await openExternalUrl("https://paypal.me/Comicoon");
    expect(openExternal).toHaveBeenCalledWith("https://paypal.me/Comicoon");
  });
  it("uses the Electron clipboard bridge for approved device-code text", async () => {
    const copyText = vi.fn(async () => {});
    vi.stubGlobal("window", { xjaus: { invoke: vi.fn(), openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText } });
    await copyToClipboard("ABCD-EFGH");
    expect(copyText).toHaveBeenCalledWith("ABCD-EFGH");
  });
  it("opens only the validated Microsoft verification URI on the dedicated bridge", async () => {
    const openMicrosoftVerification = vi.fn(async () => {});
    vi.stubGlobal("window", { xjaus: { invoke: vi.fn(), openExternal: vi.fn(), openMicrosoftVerification, copyText: vi.fn() } });
    await openMicrosoftVerificationUrl("https://microsoft.com/devicelogin");
    expect(openMicrosoftVerification).toHaveBeenCalledExactlyOnceWith("https://microsoft.com/devicelogin");
    await expect(openMicrosoftVerificationUrl("https://microsoft.com/devicelogin?code=secret")).rejects.toThrow();
    expect(openMicrosoftVerification).toHaveBeenCalledTimes(1);
  });
  it("rejects untrusted clipboard content before reaching Electron", async () => {
    const copyText = vi.fn(async () => {});
    vi.stubGlobal("window", { xjaus: { invoke: vi.fn(), openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText } });
    expect(() => copyToClipboard("https://evil.invalid/")).toThrow();
    expect(copyText).not.toHaveBeenCalled();
  });
});
