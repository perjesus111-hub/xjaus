import { expect, it, vi } from "vitest";
import { createI18n } from "./i18n";
import { watchCatalogLocale } from "./catalog-locale";

it("refreshes a loaded catalog once per resolved-language change and unsubscribes cleanly", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const i18n = createI18n(storage, ["es-MX"], "es-MX");
  let catalogLoaded = false;
  const refresh = vi.fn();
  const stop = watchCatalogLocale(i18n, () => catalogLoaded, refresh);

  i18n.setPreference("en");
  expect(refresh).not.toHaveBeenCalled();
  catalogLoaded = true;
  i18n.setPreference("en");
  expect(refresh).not.toHaveBeenCalled();
  i18n.setPreference("es");
  expect(refresh).toHaveBeenCalledTimes(1);
  i18n.setPreference("en");
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  i18n.setPreference("es");
  expect(refresh).toHaveBeenCalledTimes(2);
});
