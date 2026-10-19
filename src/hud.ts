export const HUD_HIDE_MS = 300;
/** Inactividad (ms) antes de ocultar el cursor. */
export const CURSOR_IDLE_MS = 2500;

/** Zona superior (px) que muestra HUD y cursor inmediatamente. */
export const HUD_TOP_ZONE_PX = 60;

export type HudElement = {
  contains?(node: Node | null): boolean;
  matches?(selector: string): boolean;
  addEventListener?(type: string, handler: () => void): void;
  removeEventListener?(type: string, handler: () => void): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  classList?: { add(...names: string[]): void; remove(...names: string[]): void };
};

export type HudVideoSource = {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
};

export type HudWindow = {
  document: {
    activeElement?: unknown;
    documentElement: { classList?: { add(...names: string[]): void; remove(...names: string[]): void } };
    createElement(tag: string): { textContent: string };
  };
  localStorage?: HudStorage;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  addEventListener?(type: string, handler: (event: unknown) => void): void;
  removeEventListener?(type: string, handler: (event: unknown) => void): void;
  matchMedia?(query: string): { matches: boolean };
  xjausCursorStyle?: { textContent: string };
};

export type HudStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type HudOptions = {
  hud: HudElement;
  cursor: HudElement;
  video: HudVideoSource;
  window: HudWindow;
  storage?: HudStorage;
};

/** Clave de preferencia opcional; "off" desactiva el autohide. */
export const HUD_STORAGE_KEY = "xjaus:hudAutohide";

export type PlayerHudController = {
  reveal(): void;
  /** true cuando HUD y cursor están ocultos. */
  peek(): boolean;
  dispose(): void;
};

/**
 * Fuente de verdad del CSS del HUD, verificada por los tests.
 * La copia estática vive en src/styles.css: el CSP de la app (style-src 'self')
 * bloquea <style> inline, así que el módulo NO inyecta estilos en runtime.
 */
export const HUD_CSS = [
  "#xjaus-cursor { position: fixed; top: 0; left: 0; z-index: 90; width: 14px; height: 14px;",
  "  border-radius: 50%; background: rgba(212, 175, 55, 0.92); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.6);",
  "  pointer-events: none; opacity: 0; transform: translate(var(--xjaus-cursor-x, -40px), -28px);",
  `  transition: opacity ${HUD_HIDE_MS}ms ease, transform ${HUD_HIDE_MS}ms ease; }`,
  "#xjaus-cursor[data-hud='visible'] { opacity: 1; transform: translate(var(--xjaus-cursor-x, -40px), 0); }",
  "#xjaus-cursor[data-hud='hidden'] { opacity: 0; transform: translate(var(--xjaus-cursor-x, -40px), -28px); }",
  "html.cursor-none, html.cursor-none * { cursor: none !important; }",
  ".player-toolbar[data-hud='hidden'] { opacity: 0; transform: translateY(-28px); pointer-events: none; }",
  ".player-toolbar[data-hud='visible'] { opacity: 1; transform: translateY(0); pointer-events: auto; }",
].join("\n");

export function createPlayerHudController(options: HudOptions): PlayerHudController {
  const { hud, cursor, video, window: win, storage } = options;
  let hidden = false;
  let disposed = false;
  const disabled = (() => {
    try {
      return (storage ?? win.localStorage)?.getItem(HUD_STORAGE_KEY) === "off";
    } catch {
      return false;
    }
  })();
  if (disabled) cursor.setAttribute("data-hud", "visible");

  const html = win.document.documentElement;
  const blurToolbarFocus = () => {
    if (hud.contains?.(win.document.activeElement as Node|null) || hud.matches?.(':focus-within'))
      (win.document.activeElement as {blur?():void}|null)?.blur?.();
  };
  const setCursor = (value: boolean) => {
    cursor.setAttribute("data-hud", value ? "hidden" : "visible");
    if (value) {
      html.classList?.add("cursor-none");
      html.classList?.remove("hud-cursor-default");
    } else {
      html.classList?.remove("cursor-none");
      html.classList?.add("hud-cursor-default");
    }
  };
  const setState = (value: boolean) => {
    hidden = value;
    if(value) blurToolbarFocus();
    if (value) {
      hud.setAttribute("data-hud", "hidden");
      hud.classList?.add("hud-hidden");
    } else {
      hud.removeAttribute("data-hud");
      hud.classList?.remove("hud-hidden");
    }
    setCursor(value);
  };

  const onPlaying = () => {
    blurToolbarFocus();
    if (!disabled) { setState(false); scheduleRehide(); }
  };
  let cursorTimer: unknown;

  const clearTimers = () => {
    if (cursorTimer !== undefined) win.clearTimeout(cursorTimer);

    cursorTimer = undefined;

  };
  const scheduleRehide = () => {
    if(disabled || disposed)return;
    clearTimers();
    cursorTimer = win.setTimeout(() => {
      cursorTimer = undefined;
      setState(true);
    }, CURSOR_IDLE_MS);
  };
  const onPointerActivity = (event: unknown) => {
    const mouse = event as { clientX?: number; clientY?: number };
    if (typeof mouse.clientX === "number") cursor.setAttribute("data-cursor-x", `${Math.round(mouse.clientX)}px`);
    if (disabled || disposed || typeof mouse.clientY !== 'number' || mouse.clientY < 0 || mouse.clientY >= HUD_TOP_ZONE_PX) return;
    setState(false);
    setCursor(false);
    scheduleRehide();
  };
  video.addEventListener("playing", onPlaying);
  const onFocus = () => { setState(false); scheduleRehide(); };
  const onFocusOut = () => { if(!hidden) scheduleRehide(); };
  hud.addEventListener?.('focusin',onFocus);
  hud.addEventListener?.('focusout',onFocusOut);
  win.addEventListener?.("mousemove", onPointerActivity);
  return {
    reveal: () => { if (!disabled && !disposed) { setState(false); scheduleRehide(); } },
    peek: () => hidden,
    dispose: () => {
      disposed=true;
      hud.removeEventListener?.('focusin',onFocus);
      hud.removeEventListener?.('focusout',onFocusOut);
      video.removeEventListener("playing", onPlaying);
      win.removeEventListener?.("mousemove", onPointerActivity);
      clearTimers();
      setState(false);
      html.classList?.remove("hud-cursor-default");
    },
  };
}
