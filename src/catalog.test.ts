import { describe, expect, it } from "vitest";
import { normalizeCloudTitles, productIds } from "./catalog";
const title = (details: Record<string, unknown> = {}) => ({ titleId: "REAL", details: { productId: "9N2Z748SPMTM", ...details } });
const products = { Products: [{ ProductId: "9N2Z748SPMTM", LocalizedProperties: [{ ProductTitle: "Juego", Images: [{ ImagePurpose: "Poster", Uri: "//store-images.s-microsoft.com/image/demo" }] }] }] };
const slugProducts = { Products: [] };
describe("strict account streaming catalog", () => {
  it("never exposes false or unknown entitlement, or explicit unavailable streaming", () => {
    const results = [title(), title({ hasEntitlement: false }), title({ hasEntitlement: true, isAvailable: false })];
    expect(normalizeCloudTitles({ results }, products)).toEqual([]);
    expect(productIds({ results })).toEqual([]);
  });
  it("uses current streaming endpoint membership and explicit entitlement, not Store metadata rights", () => {
    expect(normalizeCloudTitles({ results: [title({ hasEntitlement: true })] }, products)).toEqual([{ titleId: "REAL", productId: "9N2Z748SPMTM", name: "Juego", playable: true, boxArt: "https://store-images.s-microsoft.com/image/demo" }]);
  });
  it("keeps the original object reference when Store metadata only fills gaps, never rebuilding the name from titleId", () => {
    const slugTitle = { titleId: "FORZAHORIZON5", details: { productId: "9N2Z748SPMTM", hasEntitlement: true } };
    const raw = { results: [slugTitle] };
    const unhydrated = normalizeCloudTitles(raw, slugProducts);
    expect(unhydrated[0].titleId).toBe("FORZAHORIZON5");
    expect(unhydrated[0].boxArt).toBeUndefined();
    expect(unhydrated[0].playable).toBe(true);
    expect(unhydrated[0]).not.toEqual(normalizeCloudTitles(raw, products)[0]);
    expect(Object.is(unhydrated[0], normalizeCloudTitles(raw, slugProducts)[0])).toBe(false);
  });
});
