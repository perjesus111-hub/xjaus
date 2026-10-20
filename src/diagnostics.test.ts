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

it('redacts sensitive JSON, URLs, cookies, headers and multiline values case-insensitively', () => {
  const report = sanitizeDiagnostics(`{
    "access_token": "json-secret",
    "cookie": "sessionid=cookie-secret; xbl3.0=header-secret",
    "url": "https://example.test/?code=query-secret&lpt=encoded%2Dsecret",
    "password": "line-one\nline-two"
  }\nSET-COOKIE: refresh_token=refresh-secret\nX-MS-RefreshToken: header-token`);
  for (const value of ['json-secret', 'cookie-secret', 'header-secret', 'query-secret', 'encoded%2Dsecret', 'line-one', 'line-two', 'refresh-secret', 'header-token']) expect(report).not.toContain(value);
  expect(report).toContain('[redacted]');
});
