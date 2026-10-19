import { sanitizeGameProperties } from "./catalog-features";
type Metadata = { Products: unknown[] };
export function missingMetadataIds(ids: string[], metadata: Metadata): string[] {
  const cached = new Set(metadata.Products.map(record).filter(item=>item.Properties !== null && typeof item.Properties === "object").map(item=>item.ProductId));
  return ids.filter((id) => !cached.has(id));
}
const key = (account: string) => `xjaus:catalog:metadata:v2:${encodeURIComponent(account)}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sanitize(value: unknown): Metadata {
  const products = record(value).Products;
  return { Products: (Array.isArray(products) ? products : []).slice(0, 5000).flatMap((item) => {
    const product = record(item);
    if (typeof product.ProductId !== "string" || !/^[a-z0-9]{12,20}$/i.test(product.ProductId)) return [];
    const localized = record(Array.isArray(product.LocalizedProperties) ? product.LocalizedProperties[0] : null);
    return [{ ProductId: product.ProductId, ...(product.Properties && typeof product.Properties === "object" ? {Properties: sanitizeGameProperties(product.Properties)} : {}), LocalizedProperties: [{ ProductTitle: typeof localized.ProductTitle === "string" ? localized.ProductTitle.slice(0, 300) : "", Images: (Array.isArray(localized.Images) ? localized.Images : []).slice(0, 10).flatMap((image) => {
      const img = record(image);
      if (img.ImagePurpose !== "Poster" && img.ImagePurpose !== "BoxArt") return [];
      if (typeof img.Uri !== "string") return [];
      try {
        const url = new URL(img.Uri.startsWith("//") ? `https:${img.Uri}` : img.Uri);
        return url.protocol === "https:" && url.hostname === "store-images.s-microsoft.com" && !url.username && !url.password ? [{ ImagePurpose: img.ImagePurpose, Uri: url.toString() }] : [];
      } catch { return []; }
    }) }] }];
  }) };
}
export function readMetadata(storage: Pick<Storage, "getItem">, account: string): Metadata {
  if (!account) return { Products: [] };
  try {
    const value = JSON.parse(storage.getItem(key(account)) ?? "null");
    return record(value).version === 1 ? sanitize(value) : { Products: [] };
  } catch { return { Products: [] }; }
}
export function writeMetadata(storage: Pick<Storage, "setItem">, account: string, metadata: unknown): void {
  if (!account) return;
  try { storage.setItem(key(account), JSON.stringify({ version: 1, ...sanitize(metadata) })); } catch { /* Quota/private storage: continue in memory. */ }
}
