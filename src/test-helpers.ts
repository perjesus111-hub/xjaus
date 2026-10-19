// Mocks DOM etiquetados (tag "hud-<name>") para trazabilidad en reportes.
export const styleElement: { textContent: string } = { textContent: "" };

const REGISTRY: string[] = [];

export function taggedNames(): string[] {
  return [...REGISTRY];
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function makeClassList(): { add: (...names: string[]) => void; remove: (...names: string[]) => void; contains: (name: string) => boolean; __classes: Set<string> } {
  const classes = new Set<string>();
  return {
    add: (...names) => {
      for (const n of names) classes.add(n);
    },
    remove: (...names) => {
      for (const n of names) classes.delete(n);
    },
    contains: (n) => classes.has(n),
    __classes: classes,
  };
}

export const host = {
  ownerWindow: {
    localStorage: makeStorage(),
    document: {
      documentElement: { tag: "html", classList: makeClassList() },
      createElement: (tag: string): { textContent: string } => (tag === "style" ? styleElement : { textContent: "" }),
    },
    // Delegan en globalThis para que vi.useFakeTimers() los intercepte.
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
  },
};

export type MockElement = {
  tag: string;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  addEventListener: (type: string, handler: (e: unknown) => void) => void;
  removeEventListener: (type: string, handler: (e: unknown) => void) => void;
  dispatchEvent: (event: { type: string }) => void;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
  };
  __classes: Set<string>;
};

export function createElement(name: string): MockElement {
  REGISTRY.push(`hud-${name}`);
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    tag: name,
    setAttribute: (attr, value) => {
      attributes.set(attr, value);
    },
    getAttribute: (attr) => (attributes.has(attr) ? (attributes.get(attr) as string) : null),
    removeAttribute: (attr) => {
      attributes.delete(attr);
    },
    addEventListener: (type, handler) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent: (evt) => {
      for (const handler of [...(listeners.get(evt.type) ?? [])]) handler(evt);
    },
    classList: {
      add: (...names) => {
        for (const n of names) classes.add(n);
      },
      remove: (...names) => {
        for (const n of names) classes.delete(n);
      },
      contains: (n) => classes.has(n),
    },
    __classes: classes,
  };
}

export function classListOf(element: MockElement): string[] {
  return [...element.__classes];
}

type VideoHandlers = Map<string, Set<(e: unknown) => void>>;

export function playerVideo(): {
  video: {
    addEventListener: (type: string, handler: (e: unknown) => void) => void;
    removeEventListener: (type: string, handler: (e: unknown) => void) => void;
  };
  dispatch: (type: string) => void;
  handlers: VideoHandlers;
} {
  const handlers: VideoHandlers = new Map();
  const video = {
    addEventListener: (type: string, handler: (e: unknown) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener: (type: string, handler: (e: unknown) => void) => {
      handlers.get(type)?.delete(handler);
    },
  };
  return {
    video,
    dispatch: (type: string) => {
      for (const handler of [...(handlers.get(type) ?? [])]) handler({ type });
    },
    handlers,
  };
}

export function resetTestState(): void {
  REGISTRY.length = 0;
  styleElement.textContent = "";
}
