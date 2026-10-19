import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeBackend, openExternalUrl } from "./backend";

afterEach(() => { vi.unstubAllGlobals(); });
describe("Electron backend adapter", () => {
  it("routes only named commands through the isolated bridge", async () => {
    const invoke = vi.fn(async () => ({ authenticated: true }));
    vi.stubGlobal("window", { xjaus: { invoke, openExternal: vi.fn() } });
    expect(await invokeBackend("auth_status")).toEqual({ authenticated: true });
    expect(invoke).toHaveBeenCalledWith("auth_status", undefined);
  });
  it("delegates external URLs to main process without exposing Node", async () => {
    const openExternal = vi.fn(async () => {});
    vi.stubGlobal("window", { xjaus: { invoke: vi.fn(), openExternal } });
    await openExternalUrl("https://microsoft.com/devicelogin");
    expect(openExternal).toHaveBeenCalledWith("https://microsoft.com/devicelogin");
  });
});
