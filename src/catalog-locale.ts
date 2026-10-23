import type { CatalogLanguage } from "./catalog-cache";
type LocaleSource = {
  readonly locale: CatalogLanguage;
  subscribe: (listener: () => void) => () => void;
};

export function watchCatalogLocale(
  source: LocaleSource,
  catalogLoaded: () => boolean,
  refresh: () => void,
): () => void {
  let currentLocale = source.locale;
  return source.subscribe(() => {
    const nextLocale = source.locale;
    if (nextLocale === currentLocale) return;
    currentLocale = nextLocale;
    if (catalogLoaded()) refresh();
  });
}
