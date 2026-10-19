import { expect, it, vi } from "vitest";
import { createCloudGridController } from "./cloud-grid";

type AnyRecord = Record<string, unknown>;

// --- mock DOM fakes (label: mock DOM) ---
function fakeCard(titleId: string): HTMLElement {
  return { className: "game-card", dataset: { titleId }, childNodes: [] } as unknown as HTMLElement;
}
function makeGrid(): HTMLElement & { children: HTMLElement[]; append: (node: Node) => void } {
  const children: HTMLElement[] = [];
  return {
    children,
    append(node: Node) { children.push(node as HTMLElement); },
    replaceChildren(...nodes: Node[]) { children.length = 0; children.push(...(nodes as HTMLElement[])); },
    removeChild(node: Node) { const index = children.indexOf(node as HTMLElement); if (index >= 0) children.splice(index, 1); return node; },
    replaceChild(next: Node, prev: Node) { const index = children.indexOf(prev as HTMLElement); if (index >= 0) { children[index] = next as HTMLElement; return prev; } children.push(next as HTMLElement); return prev; },
    removeAttribute() { /* mock DOM */ },
  } as unknown as HTMLElement & { children: HTMLElement[]; append: (node: Node) => void };
}
function makeSearch(): HTMLInputElement {
  return { focus: vi.fn() } as unknown as HTMLInputElement;
}
function makeScroller(initialTop: number) {
  return { scrollTop: initialTop, scrollTo: vi.fn() }; // mock DOM
}
function stubWindowWithoutFocus(): unknown {
  return { scrollTop: 800 }; // mock DOM: sin scrollTo ni focus
}
function scrollerAsWindow(scroller: { scrollTop: number; scrollTo?: unknown }): Window {
  return scroller as unknown as Window; // mock DOM cast
}
// --- end mock DOM fakes ---

it("Cargar más: conserva scrollTop con append al final (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  const scroller = makeScroller(3200);
  (globalThis as AnyRecord).window = scroller;
  let renders = 0;
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => { renders++; return [] as HTMLElement[]; },
    { scroller: () => scrollerAsWindow(scroller) },
  );
  try {
    const seed = ["t1", "t2", "t3", "t4"].map(fakeCard);
    controller.renderCards(seed);
    expect(grid.children.length).toBe(4);
    expect(renders).toBe(1);

    controller.appendBatch(["t5", "t6"].map(fakeCard));
    // No se reconstruyó el grid: los 4 nodos previos siguen siendo los mismos objetos.
    expect(grid.children.length).toBe(6);
    expect(grid.children[0]).toBe(seed[0]);
    // scrollTop se leyó antes de mutar y se restauró tras el append.
    expect(scroller.scrollTo).toHaveBeenCalledWith(0, 3200);
    expect(renders).toBe(1); // sin re-render completo
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("Cargar más: sin window.scrollTo en DOM sin API de scroll; nada de scrollTo(0,0) (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  const scroller = scrollerAsWindow({ scrollTop: 800 }); // mock DOM: sin scrollTo
  (globalThis as AnyRecord).window = scroller;
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => [] as HTMLElement[],
    { scroller: () => scroller },
  );
  try {
    controller.renderCards(["t1", "t2"].map(fakeCard));
    expect(() => controller.appendBatch(["t3"].map(fakeCard))).not.toThrow();
    expect(grid.children.length).toBe(3);
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("Render con query activa reconstruye y devuelve null (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  (globalThis as AnyRecord).window = stubWindowWithoutFocus();
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => ["t1", "t2", "t3", "t4", "t5"].map(fakeCard),
  );
  try {
    const restored = controller.renderCards(["a1", "a2", "a3"].map(fakeCard));
    expect(grid.children.length).toBe(3);
    expect(restored).toBeNull();
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("appendBatch: focus natural en la primera tarjeta NUEVA sin tocar window.scrollTo(0,0) (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  const scroller = makeScroller(1200);
  (globalThis as AnyRecord).window = scroller;
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => [] as HTMLElement[],
    { scroller: () => scrollerAsWindow(scroller) },
  );
  try {
    controller.renderCards(["t1", "t2", "t3"].map(fakeCard));
    const firstNew = controller.appendBatch(["t4", "t5"].map(fakeCard));
    // La devolución apunta a la primera tarjeta nueva (focus natural lo maneja catalog-navigation).
    expect(firstNew).not.toBeNull();
    expect((firstNew as unknown as AnyRecord).dataset).toEqual({ titleId: "t4" });
    // Restauración de scroll: mismo scrollTop en cada restauración, nunca (0, 0).
    expect(scroller.scrollTo.mock.calls.length).toBe(2);
    for (const call of scroller.scrollTo.mock.calls) expect(call).toEqual([0, 1200]);
    // El foco no fue robado hacia search ni hacia una tarjeta vieja por el append.
    expect(search.focus).not.toHaveBeenCalled();
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("restoreFocus: prioriza la tarjeta restaurada sobre search (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  (globalThis as AnyRecord).window = stubWindowWithoutFocus();
  const button = { focus: vi.fn() }; // mock DOM
  const card = {
    dataset: { titleId: "t9" },
    querySelector: () => button,
  } as unknown as HTMLElement;
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => [] as HTMLElement[],
  );
  try {
    (grid as unknown as { children: HTMLElement[] }).children.push(card);
    controller.restoreFocus("t9");
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(search.focus).not.toHaveBeenCalled();
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("integración: searchController.more() hace append sin reconstruir y conserva scrollTop (mock DOM)", async () => {
  const { createCatalogSearch } = await import("./catalog-search");
  const scroller = makeScroller(2400);
  (globalThis as AnyRecord).window = scroller;
  const grid = makeGrid();
  let pending: "more" | "hydrate" | null = null;
  const controller = createCloudGridController(
    grid as HTMLElement,
    makeSearch(),
    () => [] as HTMLElement[],
    { scroller: () => scrollerAsWindow(scroller) },
  );
  // Cableado como en main.ts: onAppend marca el modo ANTES del render; el render hace append.
  const render = (query: string, visible: number) => {
    if (pending === "more") {
      controller.appendBatch([fakeCard(`new-${query}-${visible}`)]);
      pending = null;
      return;
    }
    grid.replaceChildren(fakeCard("seed"));
  };
  const search = createCatalogSearch(render, {
    onAppend: (batch) => { pending = batch; return null; },
  });
  try {
    render("", 24); // render inicial completo (seed)
    expect(grid.children.length).toBe(1);
    search.more();
    // Seed intacto (mismo objeto, sin rebuild) + tarjeta nueva al final.
    expect(grid.children.length).toBe(2);
    expect((grid.children[0] as unknown as AnyRecord).dataset).toEqual({ titleId: "seed" });
    expect((grid.children[1] as unknown as AnyRecord).dataset).toEqual({ titleId: "new--48" });
    // Scroll restaurado tras el append, nunca (0, 0).
    expect(scroller.scrollTo.mock.calls[scroller.scrollTo.mock.calls.length - 1]).toEqual([0, 2400]);
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});

it("syncCards: agrega nuevas al final, refresca existentes in-place y conserva scrollTop (mock DOM)", () => {
  const grid = makeGrid();
  const search = makeSearch();
  const scroller = makeScroller(1500);
  (globalThis as AnyRecord).window = scroller;
  const controller = createCloudGridController(
    grid as HTMLElement,
    search,
    () => [] as HTMLElement[],
    { scroller: () => scrollerAsWindow(scroller) },
  );
  try {
    const seed = ["t1", "t2", "t3"].map(fakeCard);
    controller.renderCards(seed);
    const refreshed = fakeCard("t2"); // misma tarjeta, metadata nueva (hydrated)
    controller.syncCards([seed[0], refreshed, seed[2], fakeCard("t4"), fakeCard("t5")]);
    // 5 tarjetas: 3 previas intactas (mismos objetos) + 2 nuevas al final.
    expect(grid.children.length).toBe(5);
    expect(grid.children[0]).toBe(seed[0]);
    expect(grid.children[2]).toBe(seed[2]);
    expect(grid.children[3]).not.toBe(seed[1]);
    expect((grid.children[3] as unknown as AnyRecord).dataset).toEqual({ titleId: "t4" });
    // Scroll conservado, nunca (0, 0).
    expect(scroller.scrollTo).toHaveBeenCalledWith(0, 1500);
    // Primera NUEVA para focus natural.
    expect(controller.appendBatch([])).toBeNull();
    expect(controller.syncCards([seed[0], refreshed, seed[2]])).toBeNull();
    const firstNew = controller.syncCards([seed[0], refreshed, seed[2], fakeCard("t6")]);
    expect((firstNew as unknown as AnyRecord).dataset).toEqual({ titleId: "t6" });
  } finally {
    delete (globalThis as AnyRecord).window;
  }
});
