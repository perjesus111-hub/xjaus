import type { LanguagePreference } from './i18n';

function canonicalSystemLocale(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || /^(?:c|posix|und)$/i.test(raw)) return undefined;
  const posixTag = raw.split(/[.@]/, 1)[0].replace(/_/g, '-');
  try {
    const tag = new Intl.Locale(posixTag).baseName;
    const language = new Intl.Locale(tag).language.toLowerCase();
    if (language === 'und') return undefined;
    if (tag.toLowerCase() === 'es' || tag.toLowerCase() === 'es-419') return 'es-MX';
    if (tag.toLowerCase() === 'en') return 'en-US';
    return tag;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the language sent for a Cloud Gaming session independently of the
 * translated UI and the Xbox market. Manual choices use the app's supported
 * locales; Auto uses Chromium's OS-derived locale without changing its region.
 */
export function resolveCloudStreamingLocale(
  preference: LanguagePreference,
  systemLanguages: readonly string[] = [],
  systemLanguage = '',
): string {
  if (preference === 'en') return 'en-US';
  if (preference === 'es') return 'es-MX';
  for (const candidate of [...systemLanguages, systemLanguage]) {
    const locale = canonicalSystemLocale(candidate);
    if (locale) return locale;
  }
  return 'en-US';
}
