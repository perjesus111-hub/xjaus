import { gameFeatures } from "./catalog-features";
type JsonRecord = Record<string, unknown>;
export type CloudTitle = { titleId: string; productId?: string; features?: {series?: boolean; action?: boolean; multiplayer?: boolean; controller?: boolean}; name: string; description?: string; boxArt?: string; heroArt?: string; playable?: boolean; fallbackLabel?: boolean };
const object = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
// Membership in the fresh /v2/titles response is streaming availability evidence.
// Store metadata (including cache) is NEVER entitlement evidence.
const streamingTitles = (raw: unknown) => array(object(raw).results ?? raw).map(object).filter((title) => {
  const details = object(title.details);
  return details.hasEntitlement === true && ![title.isAvailable, details.isAvailable, title.available, details.available, details.isAvailableForStreaming].some((value) => value === false || (value !== undefined && value !== true));
});

export function productIds(titles: unknown): string[] {
  return [...new Set(streamingTitles(titles).map((title) => text(object(title.details).productId)).filter((id): id is string => !!id && /^[A-Z0-9]{12,20}$/i.test(id)))];
}
function coverUri(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const full = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(full);
    return url.protocol === "https:" && url.hostname === "store-images.s-microsoft.com" ? url.toString() : undefined;
  } catch { return undefined; }
}
export function normalizeCloudTitles(raw: unknown, metadata: unknown): CloudTitle[] {
  const products = new Map(array(object(metadata).Products).map(object).map((product) => [text(product.ProductId)?.toUpperCase(), product]));
  return streamingTitles(raw).flatMap((title) => {
    const titleId = text(title.titleId);
    if (!titleId) return [];
    const product = products.get(text(object(title.details).productId)?.toUpperCase());
    const localized = object(array(object(product).LocalizedProperties)[0]);
    const images = array(localized.Images).map(object);
    const image = images.find((img) => img.ImagePurpose === "Poster") ?? images.find((img) => img.ImagePurpose === "BoxArt");
    const commercialName = [localized.ProductTitle, title.name, object(title.details).title, object(title.details).name, title.title].map(text).find(name => name && name !== titleId);
    const result: CloudTitle = { titleId, name: commercialName ?? titleId };
    const productId = text(object(title.details).productId);
    if (productId) result.productId = productId;
    const features=gameFeatures(object(product).Properties);
    if(Object.keys(features).length)result.features=features;
    const entitlement = object(title.details).hasEntitlement;
    if (typeof entitlement === "boolean") result.playable = entitlement;
    const boxArt = coverUri(image?.Uri);
    if (boxArt) result.boxArt = boxArt;
    const horizontal = images.filter(img => ['Hero', 'SuperHeroArt', 'TitledHeroArt', 'FeaturePromo', 'FeaturePromotionalArt'].includes(String(img.ImagePurpose)) && typeof img.Width === 'number' && typeof img.Height === 'number' && img.Width >= 1280 && img.Height >= 600 && img.Width / img.Height >= 1.5 && img.Width / img.Height <= 2.6 && coverUri(img.Uri))
      .sort((a, b) => Number(b.Width) * Number(b.Height) - Number(a.Width) * Number(a.Height));
    const heroArt = coverUri(horizontal[0]?.Uri);
    if (heroArt) result.heroArt = heroArt;
    // The name fell back to the raw titleId slug: mark it so renderers can derive
    // a human label without inventing brands. DisplayCatalog ProductTitle wins.
    if (result.name === titleId) result.fallbackLabel = true;
    return [result];
  });
}
