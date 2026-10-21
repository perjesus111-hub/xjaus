import { expect, it } from "vitest";
import { readMetadata, writeMetadata, missingMetadataIds } from "./catalog-cache";
it("does not fetch metadata already cached on second opening", () => {
  expect(missingMetadataIds(["9N2Z748SPMTM", "9N2Z748SPMTN"], { Products: [{ ProductId: "9N2Z748SPMTM", Properties: {} }] })).toEqual(["9N2Z748SPMTN"]);
  expect(missingMetadataIds(["9N2Z748SPMTM"], {Products:[{ProductId:"9N2Z748SPMTM"}]})).toEqual(["9N2Z748SPMTM"]);
});
it("stores only allowlisted metadata, scoped by account and version; corrupt/quota fail closed", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeMetadata(storage, "account-a", "es", { Products: [{ ProductId: "9N2Z748SPMTM", token: "SECRET", hasEntitlement: true, LocalizedProperties: [{ ProductTitle: "Demo", Images: [] }] }] });
  expect(JSON.stringify([...values])).not.toContain("SECRET");
  expect(JSON.stringify([...values])).not.toContain("hasEntitlement");
  expect(readMetadata(storage, "account-a", "es").Products).toHaveLength(1);
  expect(readMetadata(storage, "account-b", "es").Products).toEqual([]);
  expect(readMetadata({ getItem: () => "{bad" }, "account-a", "es").Products).toEqual([]);
  expect(() => writeMetadata({ setItem: () => { throw Error("quota"); } }, "account-a", "es", {})).not.toThrow();
});
it("keeps localized catalog metadata separate for English and Spanish under the same account", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeMetadata(storage, "account-a", "en", { Products: [{ ProductId: "9N2Z748SPMTM", LocalizedProperties: [{ ProductTitle: "English title", Images: [] }] }] });
  writeMetadata(storage, "account-a", "es", { Products: [{ ProductId: "9N2Z748SPMTM", LocalizedProperties: [{ ProductTitle: "Título en español", Images: [] }] }] });
  expect(readMetadata(storage, "account-a", "en").Products[0]).toMatchObject({ LocalizedProperties: [{ ProductTitle: "English title" }] });
  expect(readMetadata(storage, "account-a", "es").Products[0]).toMatchObject({ LocalizedProperties: [{ ProductTitle: "Título en español" }] });
  expect(readMetadata(storage, "account-b", "en").Products).toEqual([]);
});
