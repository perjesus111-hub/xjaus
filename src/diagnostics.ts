/** Remove credential-like values before a report can reach the clipboard. */
export function sanitizeDiagnostics(value: string): string {
  const sensitive = '(?:authorization|token|access_token|refresh_token|lpt|gstoken|password|cookie|set-cookie|sessionid|xbl3\\.0|x-ms-refreshtoken|code)';
  return value
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^\s]+(?:\s+[^\s]+)?/gi, '$1[redacted]')
    .replace(new RegExp(`("${sensitive}"\\s*:\\s*")[^"]*"`, 'gi'), '$1[redacted]"')
    .replace(new RegExp(`(${sensitive}\\s*[:=]\\s*)([^\\s,;]+)`, 'gi'), '$1[redacted]')
    .replace(/([?&](?:code|token|access_token|refresh_token|lpt|gsToken)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]');
}
