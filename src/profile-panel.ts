import { t, bindText, clearTextBinding } from './i18n';
// Perfil Xbox en Ajustes (XJAUS). Render desde xbox_profile del backend,
// tema negro/dorado, gamertag + avatar + gamerscore + tier + Cerrar sesión.
// Contrato del backend (Rust): { gamertag, gameDisplayName, gamerscore,
// gameDisplayPicRaw, accountTier, accountScope, telemetry }.

export type XboxProfile = {
  gamertag: string;
  gameDisplayName: string;
  gamerscore: string;
  gameDisplayPicRaw: string;
  accountTier: string;
  subscription?: { plan: string | null; cloudAccess: boolean; label: string; source: string };
  accountScope?: string;
};

export type ProfilePanelDeps = {
  fetchProfile: () => Promise<XboxProfile>;
  onLogout?: () => void | Promise<void>;
  /** Fábrica de nodos DOM inyectada para tests con mocks etiquetados. */
  createElement?: (tag: string) => HTMLElement;
};

const PIC_PARAMS = "format=png&w=208&h=208";
// Presentation policy only: this must never turn cloud access into billing/SKU evidence.
export function subscriptionPresentation(profile: XboxProfile): { label: string; source: 'explicit' | 'inferred' | 'unknown' } {
  const subscription = profile.subscription;
  const plans = new Set(['Xbox Game Pass Ultimate', 'Xbox Game Pass Core', 'Xbox Game Pass Standard', 'Xbox Game Pass Premium', 'Xbox Game Pass Essential', 'PC Game Pass', 'Xbox Game Pass (Starter Edition)', 'Xbox Game Pass for Console']);
  if (subscription?.source === 'explicit-subscription-product' && subscription.plan && plans.has(subscription.plan)) return { label: subscription.plan === 'Xbox Game Pass Ultimate' ? 'Ultimate' : subscription.plan, source: 'explicit' };
  return subscription?.cloudAccess === true ? { label: 'Ultimate', source: 'inferred' } : { label: '', source: 'unknown' };
}
export function subscriptionLabel(profile: XboxProfile): string { return subscriptionPresentation(profile).label; }

/** URL de avatar con tamaño pedido explícitamente. La imagen devuelta es la
 *  que el backend ya validó (https + images-eds.xboxlive.com); aquí sólo se
 *  pide un tamaño render conocido — nunca se afirma resolución nativa. */
export function avatarUrl(pic: string, params: string = PIC_PARAMS): string {
  if (!pic) return "";
  const separator = pic.includes("?") ? "&" : "?";
  return `${pic}${separator}${params}`;
}

/** replaceChildren acepta strings (se convierten en text nodes); así el
 *  contenido del backend jamás pasa por innerHTML y los mocks no necesitan document. */
function textNode(value: string): string {
  return value || "";
}

export type ProfilePanelElements = {
  root: HTMLElement;
  avatar: HTMLImageElement;
  gamertag: HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
  logout: HTMLButtonElement;
};

export function createProfilePanel(
  target: HTMLElement,
  deps: ProfilePanelDeps,
): {
  refresh: () => Promise<void>;
  clear: () => void;
  elements: ProfilePanelElements;
} {
  const createElement = deps.createElement ?? ((tag: string) => document.createElement(tag) as HTMLElement);
  // Estructura (tema negro/dorado existente vía clases .setting / .profile-*):
  // <div class="setting profile-card">
  //   <img class="profile-avatar" alt="">
  //   <div class="profile-info">
  //     <strong class="profile-gamertag"></strong>
  //     <span class="profile-meta muted"></span>
  //     <span class="status small" data-state="off"></span>
  //   </div>
  //   <button class="btn-danger profile-logout">Cerrar sesión</button>
  // </div>
  const root = createElement("div");
  root.className = "setting profile-card";
  root.dataset.profileScope = "";
  const avatar = createElement("img") as unknown as HTMLImageElement;
  avatar.className = "profile-avatar";
  avatar.alt = "";
  avatar.width = 64;
  avatar.height = 64;
  avatar.loading = "lazy";
  const info = createElement("div");
  info.className = "profile-info";
  const gamertag = createElement("strong");
  gamertag.className = "profile-gamertag";
  const meta = createElement("span");
  meta.className = "profile-meta muted";
  const status = createElement("span");
  status.className = "status small";
  status.dataset.state = "off";
  bindText(status,()=>t('noProfile'));
  const logout = createElement("button") as unknown as HTMLButtonElement;
  logout.type = "button";
  logout.className = "btn-danger profile-logout";
  bindText(logout,()=>t('signOut'));
  info.append(gamertag, meta, status);
  root.append(avatar, info, logout);
  target.append(root);

  const elements: ProfilePanelElements = { root, avatar, gamertag, meta, status, logout };
  logout.addEventListener("click", () => { void deps.onLogout?.(); });

  const identity = typeof document !== "undefined" ? document.getElementById("profile-chip") : null;
  let generation = 0;
  function clear(): void {
    generation++;
    if (identity) { identity.hidden = true; identity.replaceChildren(); }
    root.dataset.profileScope = '';
    root.dataset.subscriptionSource = 'unknown'; root.dataset.subscriptionEvidence = 'none';
    clearTextBinding(gamertag); gamertag.replaceChildren(''); meta.replaceChildren(''); avatar.src = ''; avatar.alt = '';
    status.dataset.state = 'off'; bindText(status,()=>t('noProfile'));
  }
  async function refresh(): Promise<void> {
    const request = ++generation;
    status.dataset.state = "off";
    bindText(status,()=>t('loadingProfile'));
    try {
      const profile = await deps.fetchProfile();
      if (request !== generation) return;
      if (identity) {
        const placeholder = document.createElement('span');
        placeholder.className = 'profile-chip-placeholder'; placeholder.setAttribute('aria-hidden', 'true');
        const portrait = document.createElement('img');
        portrait.className = 'profile-chip-avatar'; portrait.alt = ''; portrait.hidden = true;
        portrait.addEventListener('load', () => { portrait.hidden = false; placeholder.hidden = true; });
        portrait.addEventListener('error', () => { portrait.hidden = true; placeholder.hidden = false; });
        if (profile.gameDisplayPicRaw) portrait.src = avatarUrl(profile.gameDisplayPicRaw);
        const name = document.createElement('strong'); name.className = 'profile-chip-name'; name.textContent = profile.gamertag;
        const detail = document.createElement('span'); detail.className = 'profile-chip-meta';
        const plan = subscriptionPresentation(profile);
        detail.textContent = `${profile.gamerscore} G${plan.label ? ` · ${plan.label}` : ''}`;
        identity.dataset.subscriptionSource = plan.source;
        identity.replaceChildren(placeholder, portrait, name, detail); identity.hidden = !profile.gamertag;
      }
      // El avatar sólo cambia si la URL base cambia (evita parpadeo por recarga).
      if (avatar.src !== avatarUrl(profile.gameDisplayPicRaw)) {
        avatar.src = avatarUrl(profile.gameDisplayPicRaw);
        avatar.alt = profile.gamertag;
      }
      avatar.hidden = !profile.gameDisplayPicRaw;
      clearTextBinding(gamertag); gamertag.replaceChildren(textNode(profile.gamertag));
      const presentation = subscriptionPresentation(profile);
      root.dataset.subscriptionSource = presentation.source;
      root.dataset.subscriptionEvidence = profile.subscription?.source ?? 'none';
      meta.replaceChildren(
        textNode(`${profile.gameDisplayName || profile.gamertag} ·${profile.gamerscore}G${presentation.label ? `·${presentation.label}` : ''}`),
      );
      status.dataset.state = "ok";
      bindText(status,()=>t('verifiedProfile'));
      root.dataset.profileScope = profile.accountScope ?? "";
    } catch (error) {
      if (request !== generation) return;
      if (identity) { identity.hidden = true; identity.replaceChildren(); }
      // La UI nunca muestra errores crudos del backend en Ajustes.
      bindText(status,()=>t('profileUnavailable'));
      bindText(gamertag,()=>t('xboxAccount'));
      meta.replaceChildren(textNode(""));
      root.dataset.profileScope = "";
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Sign in first") || message.includes("Inicia sesión")) {
        bindText(status,()=>t('noSession'));
      }
    }
  }

  return { refresh, clear, elements };
}
