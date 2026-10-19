// Narrow capability: no renderer-supplied geometry or method names.
exports.createFullscreenController = (window) => {
  let previous;
  let pendingRestore;
  const capture = () => {
    previous ??= { fullscreen: window.isFullScreen(), bounds: window.getNormalBounds(), maximized: window.isMaximized(), menu: window.isMenuBarVisible() };
  };
  return (action) => {
    if (!['enter', 'exit', 'toggle', 'restore'].includes(action)) throw new Error('Acción fullscreen no permitida');
    if (window.isDestroyed()) return;
    // Finish an older exit before a new session can capture its baseline.
    if (pendingRestore) { window.removeListener('leave-full-screen', pendingRestore); pendingRestore(); }
    if (action !== 'restore') {
      capture();
      window.setMenuBarVisibility(false);
      window.setFullScreen(action === 'enter' || (action === 'toggle' && !window.isFullScreen()));
      return;
    }
    if (!previous) return;
    const saved = previous;
    previous = undefined;
    const apply = () => {
      pendingRestore = undefined;
      if (window.isDestroyed()) return;
      if (!saved.fullscreen) {
        if (saved.maximized) window.maximize();
        else { window.unmaximize(); window.setBounds(saved.bounds); }
      }
      window.setMenuBarVisibility(saved.menu);
    };
    if (window.isFullScreen() && !saved.fullscreen) {
      pendingRestore = apply;
      window.once('leave-full-screen', apply);
      window.setFullScreen(false);
    } else { window.setFullScreen(saved.fullscreen); apply(); }
  };
};
