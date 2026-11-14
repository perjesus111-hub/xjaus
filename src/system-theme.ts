export type ColorSchemeMedia = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
export type ThemeRoot = Pick<HTMLElement, 'dataset'>;

/** Mirror the OS color preference on <html> so the application shell can style
 *  itself before the page becomes visible and keep following live OS changes. */
export function bindSystemColorScheme(media: ColorSchemeMedia, root: ThemeRoot = document.documentElement): () => void {
  const update = () => {
    root.dataset.systemTheme = media.matches ? 'dark' : 'light';
  };
  media.addEventListener('change', update);
  update();
  return () => media.removeEventListener('change', update);
}
