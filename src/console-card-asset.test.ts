import { expect, it } from 'vitest';
import userFrontImage from './assets/consoles/xbox-series-x-user-front.png';
import seriesSImage from './assets/hardware/series-s.svg';
import { consolePresentation } from './console-presentation';
it('Series X cards use the user front photograph, not loading artwork; other models stay unchanged',()=>{
 const image=consolePresentation('XboxSeriesX').image;
 expect(image).toBe(userFrontImage);
 expect(image).toContain('xbox-series-x-user-front');
 expect(image).not.toMatch(/chassis|remote-reference/);
 expect(consolePresentation('XboxSeriesS').image).toBe(seriesSImage);
});
