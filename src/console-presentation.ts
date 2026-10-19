// Exact service model keys, never substring guesses. Assets are bundled by
// Vite (relative hashed URLs that resolve under file:// in Electron), so no
// absolute /hardware/... paths that break outside a web root.
import seriesXImage from './assets/consoles/xbox-series-x-user-front.png';
import seriesSImage from './assets/hardware/series-s.svg';
import oneImage from './assets/hardware/one.svg';
import oneSImage from './assets/hardware/one-s.svg';
import oneXImage from './assets/hardware/one-x.svg';
import xboxImage from './assets/hardware/xbox.svg';

type Presentation = { name: string; image: string };

const models: Record<string, [string, string]> = {
  XboxSeriesX: ['Xbox Series X', seriesXImage],
  XboxSeriesS: ['Xbox Series S', seriesSImage],
  XboxOne: ['Xbox One', oneImage],
  XboxOneS: ['Xbox One S Digital', oneSImage],
  XboxOneSDigital: ['Xbox One S Digital', oneSImage],
  XboxOneX: ['Xbox One X', oneXImage],
};

export function consolePresentation(model?: string): Presentation {
  const [name, image] = models[model ?? ''] ?? ['Xbox', xboxImage];
  return { name, image };
}
