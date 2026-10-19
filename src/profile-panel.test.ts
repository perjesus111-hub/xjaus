import {i18n} from './i18n';
i18n.setPreference('es');
import { describe, expect, it, vi } from "vitest";
import { avatarUrl, createProfilePanel, subscriptionLabel, subscriptionPresentation, type XboxProfile } from "./profile-panel";

// --- mocks DOM etiquetados (profile-) ---
function fakeNode(tag: string): Record<string, unknown> & HTMLElement {
  const node: Record<string, unknown> = {
    tag: `profile-${tag}`,
    className: "",
    textContent: "",
    dataset: {},
    append: vi.fn(),
    replaceChildren: vi.fn(),
    addEventListener: vi.fn(),
  };
  return node as unknown as Record<string, unknown> & HTMLElement;
}

function fakeTarget(): HTMLElement {
  return fakeNode("target") as unknown as HTMLElement;
}


function captureStructure(target: HTMLElement): Record<string, unknown> {
  const calls = (target.append as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const root = calls[0]?.[0] as Record<string, unknown> | undefined;
  if (!root) return {};
  return {
    className: root.className,
    childCount: (root.append as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.length,
    logoutLabel: (((root.append as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as unknown[])
      .find((n) => (n as { className?: string }).className === "btn-danger profile-logout") as { textContent?: string } | undefined)?.textContent,
  };
}

const profile: XboxProfile = {
  gamertag: "ExampleConsole",
  gameDisplayName: "Example Player",
  gamerscore: "12345",
  gameDisplayPicRaw: "https://images-eds.xboxlive.com/image?url=abc",
  accountTier: "Gold",
  accountScope: "a".repeat(64),
};

describe("avatarUrl", () => {
  it('displays a dynamic exact plan only from explicit product evidence, never legacy tiers or untrusted labels', () => {
    expect(subscriptionLabel({...profile,accountTier:'Ultimate'})).toBe('');
    const inferred = {...profile,subscription:{plan:null,cloudAccess:true,label:'Gold',source:'streaming-login'}};
    expect(subscriptionLabel(inferred)).toBe('Ultimate');
    expect(subscriptionPresentation(inferred)).toEqual({label:'Ultimate',source:'inferred'});
    expect(subscriptionPresentation({...inferred,subscription:{...inferred.subscription,plan:'Xbox Game Pass Premium',source:'explicit-subscription-product'}})).toEqual({label:'Xbox Game Pass Premium',source:'explicit'});
    expect(inferred.subscription.plan).toBeNull();
    expect(inferred.subscription.source).toBe('streaming-login');
    for(const plan of ['Xbox Game Pass Ultimate','Xbox Game Pass Essential','Xbox Game Pass Premium','PC Game Pass']) expect(subscriptionLabel({...profile,subscription:{plan,cloudAccess:false,label:'ignored',source:'explicit-subscription-product'}})).toBe(plan === 'Xbox Game Pass Ultimate' ? 'Ultimate' : plan);
    expect(subscriptionLabel({...profile,subscription:{plan:'Gold',cloudAccess:false,label:'Gold',source:'explicit-subscription-product'}})).toBe('');
  });
  it("appends explicit render size without claiming native resolution", () => {
    expect(avatarUrl("https://images-eds.xboxlive.com/image?url=abc")).toBe(
      "https://images-eds.xboxlive.com/image?url=abc&format=png&w=208&h=208",
    );
    expect(avatarUrl("https://images-eds.xboxlive.com/image")).toBe(
      "https://images-eds.xboxlive.com/image?format=png&w=208&h=208",
    );
    expect(avatarUrl("")).toBe("");
  });
});

describe("createProfilePanel", () => {
  it('renders compact actual profile values but retains inferred presentation and real evidence source', async () => {
    const value={...profile,gameDisplayName:'Different player',gamerscore:'9876',subscription:{plan:null,cloudAccess:true,label:'ignored',source:'streaming-login'}};
    const panel=createProfilePanel(fakeTarget(),{fetchProfile:async()=>value,createElement:fakeNode});await panel.refresh();
    expect(panel.elements.root.dataset.subscriptionSource).toBe('inferred');
    expect(panel.elements.root.dataset.subscriptionEvidence).toBe('streaming-login');
    expect((panel.elements.meta.replaceChildren as unknown as {mock:{calls:unknown[][]}}).mock.calls[0][0]).toBe('Different player ·9876G·Ultimate');
    expect(value.subscription.plan).toBeNull();panel.clear();expect(panel.elements.root.dataset.subscriptionSource).toBe('unknown');
  });
  it('invalidates pending account responses before logout or account replacement', async () => {
    let resolve!:(value:XboxProfile)=>void;
    const panel=createProfilePanel(fakeTarget(),{fetchProfile:()=>new Promise(r=>{resolve=r;}),createElement:fakeNode});
    const pending=panel.refresh(); panel.clear(); resolve(profile); await pending;
    expect(panel.elements.root.dataset.profileScope).toBe('');
    expect(panel.elements.status.textContent).toBe('Sin perfil');
  });
  it("builds black/gold settings card with logout button wired", () => {
    const target = fakeTarget();
    const onLogout = vi.fn(async () => {});
    const panel = createProfilePanel(target, { fetchProfile: vi.fn(async () => profile), onLogout, createElement: fakeNode });
    const structure = captureStructure(target);
    expect(structure.className).toBe("setting profile-card");
    expect(structure.childCount).toBe(3);
    expect(structure.logoutLabel).toBe("Cerrar sesión");
    // Wiring del botón: el callback de logout quedó registrado.
    const root = ((target.append as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]) as unknown as {
      append: { mock: { calls: unknown[][] } };
    };
    const logout = (root.append.mock.calls[0] as unknown[]).find(
      (n) => (n as { className?: string }).className === "btn-danger profile-logout",
    ) as { addEventListener: { mock: { calls: unknown[][] } } };
    const clickHandler = logout.addEventListener.mock.calls.find(([type]) => type === "click")?.[1] as () => void;
    clickHandler();
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(panel.elements.gamertag).toBeDefined();
  });

  it("refresh renders gamertag, meta, verified state and scoped cache key", async () => {
    const target = fakeTarget();
    const panel = createProfilePanel(target, { fetchProfile: vi.fn(async () => profile), createElement: fakeNode });
    await panel.refresh();
    const { avatar, gamertag, meta, status, root } = panel.elements;
    expect(avatar.src).toBe("https://images-eds.xboxlive.com/image?url=abc&format=png&w=208&h=208");
    expect(avatar.alt).toBe("ExampleConsole");
    expect((gamertag as unknown as { replaceChildren: { mock: { calls: unknown[][] } } }).replaceChildren.mock.calls[0][0]).toBe("ExampleConsole");
    expect((meta as unknown as { replaceChildren: { mock: { calls: unknown[][] } } }).replaceChildren.mock.calls[0][0]).toBe("Example Player ·12345G");
    expect((status as unknown as { dataset: Record<string, string> }).dataset.state).toBe("ok");
    expect((status as unknown as { textContent: string }).textContent).toBe("● Perfil verificado");
    expect((root as unknown as { dataset: Record<string, string> }).dataset.profileScope).toBe("a".repeat(64));
  });

  it("second refresh within same backend reuses avatar and does not reset src", async () => {
    const target = fakeTarget();
    const panel = createProfilePanel(target, { fetchProfile: vi.fn(async () => profile), createElement: fakeNode });
    await panel.refresh();
    const before = panel.elements.avatar.src;
    await panel.refresh();
    expect(panel.elements.avatar.src).toBe(before);
  });

  it("failure shows fallback without leaking backend errors into Settings", async () => {
    const target = fakeTarget();
    const panel = createProfilePanel(target, {
      fetchProfile: vi.fn(async () => {
        throw new Error("Xbox API HTTP 500 (XErr 2148916233)");
      }),
      createElement: fakeNode,
    });
    await panel.refresh();
    const { status, gamertag, root } = panel.elements;
    expect((status as unknown as { dataset: Record<string, string> }).dataset.state).toBe("off");
    expect((status as unknown as { textContent: string }).textContent).toBe("Perfil no disponible");
    expect(gamertag.textContent).toBe("Cuenta Xbox");
    expect((root as unknown as { dataset: Record<string, string> }).dataset.profileScope).toBe("");
    const rendered = JSON.stringify(
      (status as unknown as { textContent: string }).textContent +
      (root as unknown as { className: string }).className,
    );
    expect(rendered).not.toContain("XErr");
    expect(rendered).not.toContain("500");
  });
});
