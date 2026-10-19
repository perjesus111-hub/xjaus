import { describe, expect, it } from "vitest";
import { provisioningMessage } from "./provisioning-message";

describe("provisioningMessage", () => {
  it("shows the cloud-friendly startup copy with game name", () => {
    expect(provisioningMessage("home", "ExampleConsole")).toBe("Conectando a ExampleConsole…");
    expect(provisioningMessage("cloud", "Age of Empires II: Definitive Edition")).toBe(
      "Iniciando servidor en la nube para Age of Empires II: Definitive Edition… Esto puede demorar hasta un minuto.",
    );
  });
});
