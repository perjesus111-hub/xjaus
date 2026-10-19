// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import html from '../index.html?raw';
it('cloud search advertises one X action, not a duplicate B Search action', () => {
 document.body.innerHTML = html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const hints = document.querySelector('.search-shortcuts')!;
 expect([...hints.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['X']);
 expect(hints.querySelector('kbd')!.parentElement!.hasAttribute('data-i18n')).toBe(false);
 expect(hints.querySelectorAll('[data-i18n="search"]')).toHaveLength(1);
});
