'use strict';

function systemLocaleFromEnvironment(env = process.env) {
  let configured;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) {
      configured = value.trim();
      break;
    }
  }
  if (!configured) return undefined;
  const posixTag = configured.split(/[.@]/, 1)[0].replace(/_/g, '-');
  if (/^(?:c|posix)$/i.test(posixTag)) return 'en-US';
  try {
    const locale = new Intl.Locale(posixTag).baseName;
    return locale && new Intl.Locale(locale).language !== 'und' ? locale : 'en-US';
  } catch {
    return 'en-US';
  }
}

module.exports = { systemLocaleFromEnvironment };
