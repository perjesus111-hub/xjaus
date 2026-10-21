import { expect, it } from 'vitest';
// @ts-expect-error Node types intentionally excluded from renderer tsconfig.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

it('anchors carousel arrows in a stable full-hero overlay', () => {
  expect(html).toContain('class="featured-controls"');
  expect(html).toContain('<button id="featured-prev"');
  expect(html).toContain('<button id="featured-next"');
  expect(css).toContain('.featured-controls { position: absolute; z-index: 3; inset: 0; pointer-events: none; }');
  expect(css).toContain('.featured-controls .featured-arrow { position: absolute; top: 50%; pointer-events: auto; }');
  expect(css).toContain('transform: translateY(-50%)');
  expect(css).toContain('#featured-prev { left: clamp(');
  expect(css).toContain('#featured-next { right: clamp(');
});
