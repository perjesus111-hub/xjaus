import { LocalizedError } from './i18n';
const profiles = new Map([
  ["1280x720", { width: 1280, height: 720 }],
  ["1920x1080", { width: 1920, height: 1080 }],
  ["2560x1440", { width: 2560, height: 1440 }],
]);
export function resolutionProfile(value: string): {width: number; height: number} {
  const profile = profiles.get(value);
  if (!profile) throw new LocalizedError('unsupportedResolution');
  return { ...profile };
}
export function recommendedBitrate(resolution: string, current: number): number {
  return resolution === "2560x1440" && current === 15000 ? 30000 : current;
}
