import { describe, expect, it } from 'vitest';
import { consolePresentation } from './console-presentation';

describe('exact Xbox hardware presentation', () => {
  it.each([
    ['XboxSeriesX', 'Xbox Series X'],
    ['XboxSeriesS', 'Xbox Series S'],
    ['XboxOne', 'Xbox One'],
    ['XboxOneS', 'Xbox One S Digital'],
    ['XboxOneSDigital', 'Xbox One S Digital'],
    ['XboxOneX', 'Xbox One X'],
  ])('%s has a readable exact name', (raw, name) => {
    const presentation = consolePresentation(raw);
    expect(presentation.name).toBe(name);
  });

  it('every model resolves a bundled relative asset URL, never an absolute /hardware path', () => {
    for (const raw of ['XboxSeriesX', 'XboxSeriesS', 'XboxOne', 'XboxOneS', 'XboxOneSDigital', 'XboxOneX', 'Unknown']) {
      const { image } = consolePresentation(raw);
      expect(image.startsWith('/hardware/')).toBe(false);
      expect(image.length).toBeGreaterThan(0);
    }
  });

  it('does not guess unknown model from a substring', () => {
    expect(consolePresentation('NotXboxSeriesX').name).toBe('Xbox');
  });
});
