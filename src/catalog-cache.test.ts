import { expect, it } from "vitest";
import { readMetadata, writeMetadata, missingMetadataIds } from "./catalog-cache";
it("does not fetch metadata already cached on second opening", () => {
  expect(missingMetadataIds(["9N2Z748SPMTM", "9N2Z748SPMTN"], { Products: [{ ProductId: "9N2Z748SPMTM", Properties: {} }] })).toEqual(["9N2Z748SPMTN"]);
  expect(missingMetadataIds(["9N2Z748SPMTM"], {Products:[{ProductId:"9N2Z748SPMTM"}]})).toEqual(["9N2Z748SPMTM"]);
});
it("stores only allowlisted metadata, scoped by account and version; corrupt/quota fail closed", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeMetadata(storage, "account-a", { Products: [{ ProductId: "9N2Z748SPMTM", token: "SECRET", hasEntitlement: true, LocalizedProperties: [{ ProductTitle: "Demo", Images: [] }] }] });
  expect(JSON.stringify([...values])).not.toContain("SECRET");
  expect(JSON.stringify([...values])).not.toContain("hasEntitlement");
  expect(readMetadata(storage, "account-a").Products).toHaveLength(1);
  expect(readMetadata(storage, "account-b").Products).toEqual([]);
  expect(readMetadata({ getItem: () => "{bad" }, "account-a").Products).toEqual([]);
  expect(() => writeMetadata({ setItem: () => { throw Error("quota"); } }, "account-a", {})).not.toThrow();
});
