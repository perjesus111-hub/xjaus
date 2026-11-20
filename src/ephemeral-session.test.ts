import { expect, it } from 'vitest';
import html from '../index.html?raw';
import main from './main.ts?raw';

it('offers interactive login without saved-session entry points', () => {
  expect(html).toContain('id="btn-login"');
  expect(html).not.toContain('id="manual-login"');
  expect(main).not.toMatch(/invoke(?:<[^>]+>)?\(['"](?:load_session|persist_session)['"]/);
});
