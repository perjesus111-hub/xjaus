'use strict';

const DARK_BACKGROUND = '#090a0b';
const LIGHT_BACKGROUND = '#f4f2ec';

function windowBackgroundColor(shouldUseDarkColors) {
  return shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

function bindNativeTheme(nativeTheme, getWindow) {
  nativeTheme.themeSource = 'system';
  const apply = () => {
    const window = getWindow();
    if (window && !window.isDestroyed?.()) {
      window.setBackgroundColor(windowBackgroundColor(nativeTheme.shouldUseDarkColors));
    }
  };
  nativeTheme.on('updated', apply);
  apply();
  return () => nativeTheme.removeListener('updated', apply);
}

module.exports = { bindNativeTheme, windowBackgroundColor };
