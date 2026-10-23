import { describe, expect, it } from 'vitest';
import { resolveCloudStreamingLocale } from './streaming-locale';

describe('Cloud Gaming locale selection', () => {
  it('uses en-US for a manual English preference even on a Spanish system', () => {
    expect(resolveCloudStreamingLocale('en', ['es-MX'], 'es-MX')).toBe('en-US');
  });

  it('uses es-MX for a manual Spanish preference even on an English system', () => {
    expect(resolveCloudStreamingLocale('es', ['en-US'], 'en-US')).toBe('es-MX');
  });

  it('uses the system locale in auto mode without converting it into an account region', () => {
    expect(resolveCloudStreamingLocale('auto', ['en-GB', 'en'], 'en-GB')).toBe('en-GB');
    expect(resolveCloudStreamingLocale('auto', ['es-MX', 'es'], 'es-MX')).toBe('es-MX');
  });

  it('normalizes POSIX locale names and uses documented Spanish fallback for generic Latin American Spanish', () => {
    expect(resolveCloudStreamingLocale('auto', ['es_MX.UTF-8'], '')).toBe('es-MX');
    expect(resolveCloudStreamingLocale('auto', ['es-419'], '')).toBe('es-MX');
  });

  it('keeps other valid system locales and safely falls back for unusable values', () => {
    expect(resolveCloudStreamingLocale('auto', ['fr_FR.UTF-8'], '')).toBe('fr-FR');
    expect(resolveCloudStreamingLocale('auto', ['C.UTF-8', 'POSIX'], '')).toBe('en-US');
  });
});
