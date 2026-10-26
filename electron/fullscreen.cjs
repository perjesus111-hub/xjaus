// Narrow capability: no renderer-supplied geometry or method names.
exports.createFullscreenController = (window) => {
  let previous;
  let sessionPrevious;
  let pendingRestore;
  const snapshot = () => ({ fullscreen: window.isFullScreen(), bounds: window.getNormalBounds(), maximized: window.isMaximized(), menu: window.isMenuBarVisible() });
  const finishPending = () => {
    if (pendingRestore) { window.removeListener('leave-full-screen', pendingRestore); pendingRestore(); }
  };
  const restore = (saved) => {
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
  return (action) => {
    if (!['enter', 'exit', 'toggle', 'restore', 'session-enter', 'session-restore'].includes(action)) throw new Error('Acción fullscreen no permitida');
    if (window.isDestroyed()) return;
    finishPending();
    if (action === 'session-enter') {
      if (!window.isFullScreen()) {
        sessionPrevious = snapshot();
        window.setMenuBarVisibility(false);
        window.setFullScreen(true);
      }
      return;
    }
    if (action === 'session-restore') {
      const saved = sessionPrevious;
      sessionPrevious = undefined;
      if (!saved) return;
      // A user's F11 exit during play wins over the automatic session policy.
      if (!window.isFullScreen()) { previous = undefined; window.setMenuBarVisibility(saved.menu); return; }
      restore(saved);
      return;
    }
    if (action === 'toggle' && window.isFullScreen() && previous) {
      const saved = previous;
      previous = undefined;
      restore(saved);
      return;
    }
    if (action !== 'restore') {
      previous ??= snapshot();
      window.setMenuBarVisibility(false);
      window.setFullScreen(action === 'enter' || (action === 'toggle' && !window.isFullScreen()));
      return;
    }
    if (!previous) return;
    const saved = previous;
    previous = undefined;
    restore(saved);
  };
};
