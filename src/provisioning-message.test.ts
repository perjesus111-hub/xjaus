import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { provisioningMessage } from "./provisioning-message";

let previousPreference: typeof i18n.preference;
beforeEach(() => { previousPreference = i18n.preference; i18n.setPreference("es"); });
afterEach(() => { i18n.setPreference(previousPreference); });

describe("provisioningMessage", () => {
  it("shows the cloud-friendly startup copy with game name", () => {
    expect(provisioningMessage("home", "ExampleConsole")).toBe("Conectando a ExampleConsole…");
    expect(provisioningMessage("cloud", "Age of Empires II: Definitive Edition")).toBe(
      "Iniciando servidor en la nube para Age of Empires II: Definitive Edition… Esto puede demorar hasta un minuto.",
    );
  });
});
