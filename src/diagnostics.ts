/** Remove credential-like values before a report can reach the clipboard. */
export function sanitizeDiagnostics(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|access_token|refresh_token|lpt|gsToken)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
}
