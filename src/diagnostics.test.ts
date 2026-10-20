import { expect, it } from 'vitest';
import { sanitizeDiagnostics } from './diagnostics';

it('retains useful diagnostics while redacting credential-like values', () => {
  const report = sanitizeDiagnostics('RTT: 21 ms\nAuthorization: Bearer secret-value\ntoken=abc123\nFPS: 60');
  expect(report).toContain('RTT: 21 ms');
  expect(report).toContain('FPS: 60');
  expect(report).not.toContain('secret-value');
  expect(report).not.toContain('abc123');
  expect(report).toContain('[redacted]');
});
