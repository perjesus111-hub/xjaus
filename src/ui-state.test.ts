import { describe, expect, it } from "vitest";
import { extractConsoles, resolveHomeTarget, initialTab } from "./ui-state";

describe("XJAUS dashboard", () => {
  it("unwraps SmartGlass result without pretending it is a streaming server", () => {
    expect(extractConsoles({ result: [{ id: "smartglass-id", name: "ExampleConsole" }] })).toEqual([{ id: "smartglass-id", name: "ExampleConsole" }]);
  });
  it("uses the /v6 streaming server id for remote play", () => {
    expect(resolveHomeTarget({ name: "ExampleConsole", id: "smartglass-id" }, { servers: [{ name: "ExampleConsole", serverId: "stream-id" }] })).toBe("stream-id");
  });
  it("never sends SmartGlass id to streaming when server matching fails", () => {
    expect(resolveHomeTarget({ name: "ExampleConsole", id: "smartglass-id" }, { results: [{ name: "OTHER", serverId: "stream-id" }] })).toBeUndefined();
  });
  it("matches streaming server by device name ignoring case", () => {
    expect(resolveHomeTarget({ deviceName: "ExampleConsole" }, { results: [{ deviceName: "exampleconsole", serverId: "stream-id" }] })).toBe("stream-id");
  });
  it("pairs a sole SmartGlass console with the sole streaming server", () => {
    expect(resolveHomeTarget({ name: "ExampleConsole", id: "smartglass-id" }, { results: [{ serverId: "home-server" }] }, 1)).toBe("home-server");
  });
  it("never guesses a streaming server when there are multiple consoles", () => {
    expect(resolveHomeTarget({ name: "ExampleConsole", id: "smartglass-id" }, { results: [{ serverId: "home-server" }] }, 2)).toBeUndefined();
  });
  it("shows consoles by default after login", () => {
    expect(initialTab(true)).toBe("consoles");
  });
});
