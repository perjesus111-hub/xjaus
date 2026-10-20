// @ts-expect-error Node types intentionally excluded from the renderer tsconfig.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

it('provides the black-and-gold application shell with a semantic sidebar', () => {
  expect(html).toContain('<aside class="sidebar"');
  expect(html).toContain('class="sidebar-nav"');
  expect(html).toContain('data-action="consoles"');
  expect(html).toContain('data-action="cloud"');
  expect(html).toContain('data-action="settings"');
  expect(css).toContain('--bg-sidebar: #0d0e10');
  expect(css).toContain('--gold-bright: #e8c56a');
  expect(css).toContain('.app-shell');
  expect(css).toContain('.sidebar-nav .tab.active');
});
