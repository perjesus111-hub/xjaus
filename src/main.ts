import { createLoginCode } from './login-code';
import { settleRemoteStop } from './stream-stop';
import { createConsolePolling } from './console-polling';
import { createInfiniteCatalog } from './infinite-catalog';
import { t, bindText, bindProperty, i18n, localizeDocument, clearTextBinding, LocalizedError, errorMessage } from './i18n';
import { createControllerPresence } from './controller-presence';
import { removeUnfavoritedCards } from './favorite-focus';
import { ViewFocusIntent } from './ten-foot';
localizeDocument();
document.documentElement.classList.add("i18n-ready");
// UI-only preferences (density/focus/cover titles/stats autoplay): applied at
// startup, before panels paint; localStorage-only, never streamed to the engine.
let uiStorage: Pick<Storage, "getItem" | "setItem"> | undefined;
try { uiStorage = typeof localStorage !== "undefined" ? localStorage : undefined; } catch { uiStorage = undefined; }
const uiPreferences = createUiPreferencesStore(uiStorage);
applyUiPreferences(uiPreferences.load());
const controllerPresence=createControllerPresence();
window.addEventListener('pagehide',()=>controllerPresence.dispose());
import { CloudLibrary, LIBRARY_FILTERS, filterLibrary, bindSuccessfulCloudPlayback, type LibraryFilter } from './cloud-library';
import './console-wake';
import { mountLoadingControls } from './loading-controls';
import { invokeBackend as invoke, openExternalUrl as openUrl } from "./backend";
import { normalizeCloudTitles, productIds, type CloudTitle } from "./catalog";
import { createMetadataQueue } from "./metadata-queue";
import { gameDisplayName } from './game-name';
import { createCatalogSearch, filterCatalog, normalizeSearch } from "./catalog-search";
import { createCatalogNavigation } from "./catalog-navigation";
import { createCloudGridController } from "./cloud-grid";
import { readMetadata, writeMetadata, missingMetadataIds } from "./catalog-cache";
import { watchCatalogLocale } from "./catalog-locale";
import { recommendedBitrate } from "./stream-options";
import { createSettingsStore, engineSettings, type StreamSettings } from "./settings";
import { applyUiPreferences, createUiPreferencesStore, type UiPreferences } from "./ui-preferences";
import { initSettingsNavigation } from "./settings-nav";
import { initCloudContext } from "./cloud-context";
import { testVibration } from "./haptics-test";
import { captureVideoFrame } from "./video-frame";
import { featuredForDay } from './featured-games';
import { createToastManager } from './toast-manager';
import { version as appVersion } from "../package.json";
import { microsoftSessionExpired, appendMicrosoftReauth } from "./stream-auth";
import { consolePresentation } from "./console-presentation";
import { showStreamLoading, bindLoadingPlayback, disposeStreamLoading } from "./loading-presentation";
import { XboxSessionCoordinator, XboxWebRtcController } from "./webrtc";
import { extractConsoles, resolveHomeTarget, type ConsoleItem } from "./ui-state";

import { bindPlayerFullscreen } from "./fullscreen";
import { createProfilePanel, type XboxProfile } from "./profile-panel";
import { sanitizeDiagnostics } from './diagnostics';
import { mountStreamMenu } from "./stream-menu";
import { createStreamTelemetry, ConnectionGrace } from "./stream-telemetry";
import { createPlayerHudController } from "./hud";
import { syncRangeFill } from './range-fill';

let cleanupFullscreen: (() => void) | undefined;
let cleanupHud: (() => void) | undefined;
let cleanupLoadingControls: (() => void) | undefined;
let currentProfile: XboxProfile | undefined;
let connectionAttempt: { id: string; abort: AbortController; tab: Tab; origin: HTMLElement | null } | undefined;
let connectionGeneration = 0;

type Status = { authenticated: boolean; account: string; storage: string; catalogAccountScope?: string };
type Tab = "home" | "consoles" | "cloud" | "settings";
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screenTitleKeys = { home: 'homeTab', consoles: 'myConsolesTab', cloud: 'cloudTab', settings: 'settings' } as const;
const screenTitle = get<HTMLElement>('screen-title');
const loginScreen = get<HTMLElement>("login-screen");
const dashboard = get<HTMLElement>("dashboard");
const playerScreen = get<HTMLElement>("player-screen");
const loginFeedback = get<HTMLElement>("login-feedback");
const diagnostics = get<HTMLElement>("output");
const toast = get<HTMLElement>("toast");
const toastManager = createToastManager(() => { toast.hidden = false; }, () => { clearTextBinding(toast); toast.replaceChildren(); toast.hidden = true; });
const consoleGrid = get<HTMLElement>("consoles-container");
const remoteStatus = get<HTMLElement>('remote-status');
const cloudGrid = get<HTMLElement>("cloud-container");
const video = get<HTMLVideoElement>("stream-video");
const overlay = get<HTMLElement>("stream-overlay");
let message = get<HTMLElement>("stream-message");
const playerToolbar = document.querySelector<HTMLElement>(".player-toolbar");
let session: XboxSessionCoordinator | undefined;
let homeServers: unknown;
let currentConsoles:ConsoleItem[]=[];
let cloudTitles: CloudTitle[] = [];
let catalogGeneration = 0;
let catalogScope = "";
let catalogRaw: unknown;
let catalogMetadata: { Products: unknown[] } = { Products: [] };
let catalogVisible = 24;
let catalogHydrated = 0;
let catalogSearchPending = false;
let loginGeneration = 0;
let cleanupLoginCode: (() => void) | undefined;
function disposeLoginCode(): void { cleanupLoginCode?.(); cleanupLoginCode = undefined; }
window.addEventListener('pagehide', () => { loginGeneration++; disposeLoginCode(); });
let activeTab: Tab = "consoles";
let loadingCatalog = false;
let starting = false;
let validatingLaunch = false;
let catalogQuery = "";
let libraryFilter: LibraryFilter = 'all';
const viewFocus = new ViewFocusIntent();
const tabs: Tab[] = ['consoles','cloud','settings'];
const library = () => new CloudLibrary(localStorage,catalogScope);
const featuredHero = get<HTMLElement>('featured-hero');
const featuredTitle = get<HTMLElement>('featured-title');
const featuredMeta = get<HTMLElement>('featured-meta');
const featuredOpen = get<HTMLButtonElement>('featured-open');
const featuredIndicators = get<HTMLElement>('featured-indicators');
const homeFavorites = get<HTMLElement>('home-favorites');
const homeFavoritesGrid = get<HTMLElement>('home-favorites-grid');
let featuredGames: CloudTitle[] = [];
let featuredIndex = 0;
let featuredTimer: ReturnType<typeof setInterval> | undefined;
let featuredPaused = false;
function dayKey() { return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
function renderHomeFeatured() {
  featuredGames = featuredForDay(cloudTitles, dayKey());
  if (!featuredGames.length) { featuredOpen.disabled=true; bindText(featuredTitle,()=>t(loadingCatalog?'loadingFeatured':'noFeaturedGames')); bindText(featuredMeta,()=>loadingCatalog?t('verifyingGames'):t('retryFromCloud')); featuredHero.style.backgroundImage='linear-gradient(90deg, rgba(5,7,9,.94), rgba(18,20,23,.78))'; featuredIndicators.replaceChildren(); return; }
  featuredIndex %= featuredGames.length;
  const game=featuredGames[featuredIndex]!;
  clearTextBinding(featuredTitle); clearTextBinding(featuredMeta);
  featuredTitle.textContent=gameDisplayName(game);
  featuredMeta.textContent=game.description || (game.features?.multiplayer ? t('multiplayer') : t('availableOnCloud'));
  featuredHero.style.backgroundImage=`linear-gradient(90deg, rgba(5,7,9,.94) 0%, rgba(5,7,9,.64) 42%, rgba(5,7,9,.12) 78%), url("${game.heroArt || game.boxArt}")`;
  featuredOpen.disabled=false; featuredOpen.dataset.titleId=game.titleId;
  featuredIndicators.replaceChildren(...featuredGames.map((_item,index)=>{const b=document.createElement('button');b.type='button';b.className='featured-indicator';b.setAttribute('aria-label',`${index+1}/${featuredGames.length}`);b.setAttribute('aria-current',String(index===featuredIndex));b.addEventListener('click',()=>{featuredIndex=index;renderHomeFeatured();});return b;}));
  const favorites=cloudTitles.filter(game=>library().favorites().includes(game.titleId));
  homeFavorites.hidden=!favorites.length; homeFavoritesGrid.replaceChildren(...favorites.map(makeGameCard));
}
function rotateFeatured(delta=1){if(!featuredGames.length)return;featuredIndex=(featuredIndex+delta+featuredGames.length)%featuredGames.length;renderHomeFeatured();}
function syncFeaturedTimer(){if(featuredTimer!==undefined){clearInterval(featuredTimer);featuredTimer=undefined;}if(!featuredPaused && !document.hidden && activeTab==='home' && !featuredHero.closest('[hidden]') && !matchMedia('(prefers-reduced-motion: reduce)').matches)featuredTimer=setInterval(()=>rotateFeatured(),10000);}
featuredHero.addEventListener('focusin',()=>{featuredPaused=true;syncFeaturedTimer();});
featuredHero.addEventListener('focusout',()=>{featuredPaused=false;syncFeaturedTimer();});
get<HTMLButtonElement>('featured-prev').addEventListener('click',()=>rotateFeatured(-1));
get<HTMLButtonElement>('featured-next').addEventListener('click',()=>rotateFeatured(1));
featuredHero.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'){event.preventDefault();rotateFeatured(-1);}if(event.key==='ArrowRight'){event.preventDefault();rotateFeatured(1);}});
let featuredDialog: HTMLDialogElement | undefined;
let featuredPadFrame: number | undefined;
let featuredPadButtons = new Set<number>();
function snapshotFeaturedPadButtons(): Set<number> {
  return new Set(Array.from(navigator.getGamepads?.() ?? []).flatMap(pad => pad?.connected && pad.mapping==='standard' ? pad.buttons.flatMap((button,index)=>button.pressed?[index]:[]) : []));
}
function pollFeaturedDialog() {
  if (!featuredDialog?.open) { featuredPadFrame=undefined; return; }
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad?.connected || pad.mapping!=='standard') continue;
    const pressed=new Set(pad.buttons.flatMap((button,index)=>button.pressed?[index]:[]));
    const edge=(button:number)=>pressed.has(button)&&!featuredPadButtons.has(button);
    const items=[...featuredDialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current=items.indexOf(document.activeElement as HTMLButtonElement);
    if(edge(1)){featuredDialog.querySelector<HTMLButtonElement>('[data-featured-cancel]')?.click();break;}
    if(edge(0)){(document.activeElement as HTMLButtonElement)?.click();break;}
    if(edge(12)||edge(14))items[(Math.max(0,current)-1+items.length)%items.length]?.focus();
    if(edge(13)||edge(15))items[(Math.max(0,current)+1)%items.length]?.focus();
    featuredPadButtons=pressed;
  }
  featuredPadFrame=requestAnimationFrame(pollFeaturedDialog);
}
function openFeaturedDialog(game: CloudTitle): void {
  featuredPaused=true; syncFeaturedTimer();
  const origin=document.activeElement as HTMLElement | null;
  featuredDialog?.remove();
  const dialog=document.createElement('dialog'); dialog.className='featured-dialog'; dialog.setAttribute('aria-modal','true');
  const title=document.createElement('h2'); title.id='featured-dialog-title'; title.textContent=gameDisplayName(game); dialog.setAttribute('aria-labelledby',title.id);
  const art=document.createElement('img'); art.alt=''; art.src=game.boxArt || game.heroArt || ''; art.hidden=!art.src;
  const actions=document.createElement('div'); actions.className='featured-dialog-actions';
  const play=document.createElement('button'); play.type='button'; play.className='featured-dialog-play'; bindText(play,()=>t('playNow'));
  const favorite=document.createElement('button'); favorite.type='button';
  let isFavorite=library().favorites().includes(game.titleId);
  const refreshFavorite=()=>{isFavorite=library().favorites().includes(game.titleId);bindText(favorite,()=>t(isFavorite?'removeFavorite':'addFavorite'));};refreshFavorite();
  const cancel=document.createElement('button'); cancel.type='button'; cancel.dataset.featuredCancel='true'; bindText(cancel,()=>t('cancel'));
  const close=()=>{featuredDialog=undefined;if(featuredPadFrame!==undefined)cancelAnimationFrame(featuredPadFrame);featuredPadFrame=undefined;featuredPadButtons.clear();dialog.close();dialog.remove();featuredPaused=false;syncFeaturedTimer();origin?.focus();};
  cancel.addEventListener('click',close); dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  favorite.addEventListener('click',()=>{library().toggle(game);refreshFavorite();renderCloud();renderHomeFeatured();});
  play.addEventListener('click',()=>{close();libraryFilter='all';catalogQuery=gameDisplayName(game);cloudSearch.value=catalogQuery;catalogVisible=24;appendBatch=null;switchTab('cloud',false);renderCloud();requestAnimationFrame(()=>{const card=document.querySelector<HTMLElement>(`#cloud-container [data-title-id="${CSS.escape(game.titleId)}"]`);const connect=card?.querySelector<HTMLButtonElement>('.connect-btn');if(!connect){notice(()=>t('unavailableGame'));return;}connect.focus();connect.click();});});
  actions.append(play,favorite,cancel); dialog.append(art,title,actions); document.body.append(dialog); featuredDialog=dialog; featuredPadButtons=snapshotFeaturedPadButtons(); dialog.showModal();play.focus(); featuredPadFrame=requestAnimationFrame(pollFeaturedDialog);
}
function openCurrentFeatured(event?: Event): void { event?.stopPropagation(); const game=featuredGames.find(item=>item.titleId===featuredOpen.dataset.titleId);if(game)openFeaturedDialog(game); }
featuredOpen.addEventListener('click',openCurrentFeatured);
featuredHero.addEventListener('click',event=>{if((event.target as Element).closest('.featured-controls, #featured-open'))return;openCurrentFeatured(event);});
function libraryTitles() { return filterLibrary(cloudTitles,libraryFilter,library().favorites(),library().recent(cloudTitles).map(g=>g.titleId)); }
const recentSection = get<HTMLElement>('cloud-recent');
const recentGrid = get<HTMLElement>('cloud-recent-grid');
const filterBar = get<HTMLElement>('cloud-filters');
for(const [value] of LIBRARY_FILTERS) {
 const pill=document.createElement('button');pill.type='button';pill.className='filter-pill';bindText(pill,()=>t(value));pill.dataset.filter=value;
 pill.setAttribute('aria-pressed',String(value==='all'));
 pill.addEventListener('click',()=>{catalogPager.reset();metadataQueue.cancelPending();libraryFilter=value;appendBatch=null;for(const item of filterBar.querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===pill));searchController.resetPage();});
 filterBar.append(pill);
}
function renderRecent() {
 const games=library().recent(cloudTitles);recentSection.hidden=!games.length;
 // Never rebuild the focused recent card just because metadata arrived.
 const active=document.activeElement as HTMLElement|null;
 if(active && recentGrid.contains(active)) return;
 recentGrid.replaceChildren(...games.map(makeGameCard));
}
const cloudSearch = get<HTMLInputElement>("cloud-search");
// Modo append marcado ANTES del render; renderCloud lo consume y lo limpia.
let appendBatch: "more" | "hydrate" | null = null;
const catalogLanguage = () => i18n.locale;
const cloudGridController = createCloudGridController(cloudGrid, cloudSearch, () => []);
let metadataQueue = newMetadataQueue();
function newMetadataQueue() {
  return createMetadataQueue(async (ids) => {
    const generation = catalogGeneration;
    const result = await invoke<{Products?: unknown[]}>("catalog_products", {productIds: ids, language: catalogLanguage()});
    if (generation !== catalogGeneration) return;
    const merged = new Map(catalogMetadata.Products.map(item => [(item as {ProductId?: string}).ProductId, item]));
    for (const item of result.Products ?? []) merged.set((item as {ProductId?: string}).ProductId, item);
    catalogMetadata = {Products: [...merged.values()]};
    try { writeMetadata(localStorage, catalogScope, catalogLanguage(), catalogMetadata); } catch { /* optional cache */ }
    cloudTitles = normalizeCloudTitles(catalogRaw, catalogMetadata);
    appendBatch = "hydrate"; renderCloud();
  });
}
function scheduleVisibleMetadata() {
  const visible = new Set(filterCatalog(libraryTitles(), catalogQuery).slice(0,catalogVisible).map(game=>game.titleId));
  const raw = catalogRaw as {results?: {titleId?:string;details?:{productId?:string}}[]} | undefined;
  const ids = (raw?.results ?? []).filter(item=>visible.has(item.titleId ?? "")).map(item=>item.details?.productId).filter((id): id is string=>!!id);
  metadataQueue.schedule(missingMetadataIds(ids,catalogMetadata));
}
const searchController = createCatalogSearch((query, visible) => {
  catalogSearchPending = false;
  catalogQuery = query;
  catalogVisible = visible;
  renderCloud();
  scheduleVisibleMetadata();
}, {
  // Se ejecuta ANTES del render: marca append mode para que renderCloud no reconstruya el grid.
  onAppend: (batch) => { appendBatch = batch; return null; },
});
const catalogPager = createInfiniteCatalog(cloudGrid, () => {
  searchController.more();
  scheduleVisibleMetadata();
});
function syncCatalogPager() {
  const total = filterCatalog(libraryTitles(),catalogQuery).length;
  catalogPager.update(Math.min(catalogVisible,total),total,!dashboard.hidden && activeTab === 'cloud' && playerScreen.hidden && !starting && !loadingCatalog && !catalogSearchPending);
}
const catalogNavigation = createCatalogNavigation(cloudSearch, cloudGrid, () => playerScreen.hidden && !starting && !session, () => !dashboard.hidden && activeTab === 'cloud', {
 enabled:()=>!dashboard.hidden && playerScreen.hidden && !starting && !session && !validatingLaunch && !featuredDialog,
 index:()=>tabs.indexOf(activeTab),switch:index=>switchTab(tabs[index],true),
}, origin => catalogPager.request(origin));
document.addEventListener('focusin', event=>{document.querySelectorAll('.gamepad-focus').forEach(el=>{if(el!==event.target)el.classList.remove('gamepad-focus');});});
const focusObserver=new MutationObserver(()=>{if(!dashboard.hidden && !starting && !session)viewFocus.flush();});
focusObserver.observe(dashboard,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
window.addEventListener("pagehide", () => { toastManager.dispose(); catalogPager.dispose(); searchController.dispose(); metadataQueue.dispose(); catalogNavigation.dispose(); focusObserver.disconnect(); });

function errorText(error: unknown): string { return errorMessage(error); }
function notice(copy: string | (() => string)): void {
  const render = typeof copy === 'function' ? copy : () => copy;
  const text = render();
  clearTextBinding(toast);
  const copyNode=document.createElement('span');
  bindText(copyNode,render);
  toast.replaceChildren(copyNode);
  const expired = microsoftSessionExpired(text);
  toastManager.show(text, expired ? 6500 : 4000);
  bindText(diagnostics,render);
  if (expired) {
    appendMicrosoftReauth(toast, () => {
      // Retain the secure store; the existing OAuth flow replaces it on success.
      setScreen("login");
      get<HTMLButtonElement>("btn-login").click();
    });
  }
}
function setScreen(screen: "login" | "dashboard" | "player"): void {
  if(screen!=="dashboard")viewFocus.cancel();
  loginScreen.hidden = screen !== "login";
  dashboard.hidden = screen !== "dashboard";
  playerScreen.hidden = screen !== "player";
  catalogNavigation.sync();
  syncCatalogPager();
  consolePolling.sync();
}
function showAuth(status: Status): void {
  profilePanel?.clear();
  currentProfile = undefined;
  const connected = status.authenticated;
  // Rights are never restored from storage. Every auth transition invalidates UI and in-flight catalog work.
  catalogGeneration++;
  consolePolling.invalidate();
  catalogPager.reset(); catalogSearchPending = false;
  homeServers=undefined;currentConsoles=[];document.getElementById('home-recent')?.remove();
  metadataQueue.dispose(); metadataQueue = newMetadataQueue();
  recentSection.hidden = true; recentGrid.replaceChildren(); viewFocus.cancel();
  libraryFilter = "all"; for(const pill of filterBar.querySelectorAll<HTMLElement>("[data-filter]"))pill.setAttribute("aria-pressed",String(pill.dataset.filter==="all"));
  catalogScope = connected ? status.catalogAccountScope || (status.account !== "Xbox account" ? status.account : "") : "";
  cloudTitles = [];
  catalogRaw = undefined;
  searchController.reset();
  cloudSearch.value = catalogQuery = "";
  catalogVisible = 24;
  loadingCatalog = false;
  consoleGrid.replaceChildren();
  cloudGrid.replaceChildren();
  catalogPager.reset();
  for (const id of ["login-status", "auth-status"]) {
    const indicator = get<HTMLElement>(id);
    indicator.dataset.state = connected ? "ok" : "off";
    bindText(indicator,()=>connected ? t('connected') : t('noSession'));
  }
  if (connected) {
    loginGeneration++;
    disposeLoginCode();
    loginFeedback.hidden = true;
    clearTextBinding(loginFeedback); loginFeedback.replaceChildren();
    setScreen("dashboard");
    switchTab("consoles");
    void profilePanel?.refresh();
  } else setScreen("login");
}
function switchTab(tab: Tab, focusView = true): void {
  viewFocus.cancel();
  activeTab = tab;
  bindText(screenTitle, () => t(screenTitleKeys[tab]));
  catalogNavigation.sync();
  for (const name of ["home", "consoles", "cloud", "settings"] as const) {
    get<HTMLElement>(`panel-${name}`).hidden = name !== tab;
    document.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`)?.classList.toggle("active", name === tab);
  }
  syncFeaturedTimer();
  controllerPresence.sync();
  consolePolling.sync();
  if ((tab === "cloud" || tab === "home") && !loadingCatalog && cloudTitles.length === 0) void loadCloud();
  syncCatalogPager();
  if (focusView) viewFocus.begin(get<HTMLElement>(`panel-${tab}`), tab==='cloud'? '#cloud-container .game-card .connect-btn' : tab==='consoles'? '.console-card button' : tab==='home' ? '.dashboard-action-card' : 'select,input,button');
}

function cardButton(label: () => string, onClick: () => void, enabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "connect-btn";
  bindText(button,label);
  button.disabled = !enabled;
  button.addEventListener("click", onClick);
  return button;
}
function renderConsoles(consoles: ConsoleItem[]): void {
  clearTextBinding(consoleGrid);
  currentConsoles=consoles;
  bindText(remoteStatus, () => consoles.length ? t('remoteConsolesFound', { count: consoles.length }) : t('noConsoles'));
  renderHomeRecent(consoles);
  if (!consoles.length) { bindText(consoleGrid,()=>t('noConsoles')); return; }
  if (!consoleGrid.querySelector('.console-card')) consoleGrid.replaceChildren();
  const retained = new Set<HTMLElement>();
  for (const item of consoles) {
    const name = item.name || item.deviceName || "Xbox";
    // SmartGlass id != streaming serverId; nunca mandar el ID equivocado a /play.
    const target = resolveHomeTarget(item, homeServers, consoles.length);
    const key = item.id || target || name;
    const existing = [...consoleGrid.querySelectorAll<HTMLElement>('.console-card')].find(node=>node.dataset.consoleKey===key);
    const card = existing ?? document.createElement("article");
    card.className = "console-card"; card.dataset.consoleKey = key; retained.add(card);
    const badge = document.createElement("span");
    badge.className = "console-badge";
    const rawPower = (item.powerState || "").toLowerCase();
    card.dataset.power = rawPower;
    bindText(badge,()=>rawPower === "on" || rawPower === "poweredon" ? t('powerOn') : ['standby','connectedstandby'].includes(rawPower) ? t('standby') : rawPower === 'off' ? t('powerOff') : t('powerUnknown'));
    const title = document.createElement("h3"); title.textContent = name;
    const model = consolePresentation(item.consoleType);
    const type = document.createElement("p"); type.className = "muted"; type.textContent = model.name;
    const body = document.createElement("div"); body.className = "console-card-body";
    const hardware = document.createElement("img"); hardware.className = "console-hardware"; hardware.src = model.image; hardware.alt = model.name; hardware.loading = "lazy";
    body.append(hardware);
    const button = existing?.querySelector<HTMLButtonElement>('button') ?? cardButton(()=>'',()=>{},true);
    bindText(button,()=>target ? t('connectPlay') : t('remoteUnavailable'));
    button.disabled=!target;
    button.onclick=()=>{if(target)void startGame('home',target,name,undefined,item);};
    if(existing){
      bindText(existing.querySelector<HTMLElement>('.console-badge')!,()=>rawPower === "on" || rawPower === "poweredon" ? t('powerOn') : ['standby','connectedstandby'].includes(rawPower) ? t('standby') : rawPower === 'off' ? t('powerOff') : t('powerUnknown'));
      existing.querySelector('h3')!.textContent=name;
      existing.querySelector('p')!.textContent=model.name;
      const img=existing.querySelector<HTMLImageElement>('img')!;
      if(img.getAttribute('src')!==model.image)img.src=model.image;img.alt=model.name;
    }else{card.append(badge,title,type,body,button);consoleGrid.append(card);}
  }
  for(const card of consoleGrid.querySelectorAll<HTMLElement>('.console-card'))if(!retained.has(card))card.remove();
}
function renderHomeRecent(consoles:ConsoleItem[]){
  const signature=JSON.stringify([catalogGeneration,library().history().filter(entry=>entry.type==='home'),consoles.map(item=>[item.id,item.name,item.deviceName,item.consoleType,resolveHomeTarget(item,homeServers,consoles.length)])]);
  const existing=document.getElementById('home-recent');
  if(existing?.dataset.signature===signature)return;
  // Do not destroy a recent-card focus target during background discovery.
  if(existing?.contains(document.activeElement))return;
  existing?.remove();
  const generation=catalogGeneration;
  const recent=library().history().filter(entry=>entry.type==='home');
  const section=document.createElement('section');section.id='home-recent';section.className='cloud-recent';section.dataset.signature=signature;
  const heading=document.createElement('h3');bindText(heading,()=>t('recentConsoles'));section.append(heading);
  const grid=document.createElement('div');grid.className='recent-grid';section.append(grid);
  for(const entry of recent){
    const item=consoles.find(item=>resolveHomeTarget(item, homeServers, consoles.length)===entry.id);
    if(!item)continue;
    const card=document.createElement('article');card.className='console-card';
    const title=document.createElement('h3');title.textContent=item.name||item.deviceName||entry.title;
    const label=document.createElement('p');label.textContent='REMOTE PLAY';
    const image=document.createElement('img');image.className='console-hardware';image.src=consolePresentation(item.consoleType).image;image.alt=consolePresentation(item.consoleType).name;
    card.append(title,label,image,cardButton(() => t('connectPlay'),()=>{
      if(generation!==catalogGeneration)return;
      const target=resolveHomeTarget(item,homeServers,consoles.length);
      if(target===entry.id)void startGame('home',target,title.textContent||entry.title,undefined,item);
    },true));grid.append(card);
  }
  if(grid.childElementCount)get<HTMLElement>('panel-home').querySelector('.dashboard-recent')?.before(section);
}
const consolePolling = createConsolePolling(async () => {
  // SmartGlass y /v6 son independientes. Si uno falla, mostrar el otro sin bloquear.
  const [smart, streaming] = await Promise.allSettled([
    invoke<unknown>("list_consoles_smartglass"),
    invoke<unknown>("list_streaming_servers"),
  ]);
  return {smart,streaming};
}, ({smart,streaming}) => {
  if(smart.status==='rejected' && streaming.status==='rejected')return;
  homeServers = streaming.status === "fulfilled" ? streaming.value : null;
  const consoles = smart.status === "fulfilled" ? extractConsoles(smart.value) : [];
  const servers = homeServers ? extractConsoles(homeServers) : [];
  const all = consoles.length ? consoles : servers;
  const unique = new Map<string, ConsoleItem>();
  for (const item of all) {
    const identity = resolveHomeTarget(item, homeServers, all.length) || item.id || item.deviceName || item.name;
    if (!identity) continue;
    // Prefer the entry that exposes a playable target; never dedupe by name alone.
    const previous = unique.get(identity);
    if (!previous || (!resolveHomeTarget(previous, homeServers, all.length) && resolveHomeTarget(item, homeServers, all.length))) unique.set(identity, item);
  }
  renderConsoles([...unique.values()]);
}, () => !document.hidden && !dashboard.hidden && playerScreen.hidden && activeTab==='consoles');
window.addEventListener('pagehide',()=>consolePolling.dispose());
function makeGameCard(game: CloudTitle): HTMLElement {
  const card = document.createElement("article"); card.className = "game-card";
  card.dataset.titleId = game.titleId;
  // DisplayCatalog ProductTitle es oficial; el slug del titleId solo se humaniza
  // léxicamente cuando no hay metadatos hydratados (fallbackLabel). Sin inventar marcas.
  const display = gameDisplayName(game);
  const title = document.createElement("h3"); title.textContent = display;
  if (game.description) card.dataset.description = game.description;
  if (game.heroArt) card.dataset.heroArt = game.heroArt;
  const artwork=document.createElement('div');artwork.className='game-artwork';card.append(artwork);
  if (game.boxArt) {
    const image = document.createElement("img"); image.className = "game-cover";
    image.alt = display;
    image.loading = "lazy";
    image.width = 300; image.height = 450;
    image.src = game.boxArt;
    artwork.append(image);
  } else {
    // Sin metadatos aún: skeleton shimmer (la hidratación in-place lo reemplaza).
    const skeleton = document.createElement("div");
    skeleton.className = "game-cover game-cover-skeleton";
    skeleton.setAttribute("aria-hidden", "true");
    artwork.append(skeleton);
  }
  const favorite=document.createElement('button');favorite.type='button';favorite.className='favorite-toggle';
  bindProperty(favorite,'ariaLabel',()=>t('favoriteLabel',{name:display}));
  favorite.setAttribute('aria-keyshortcuts','F');bindProperty(favorite,'title',()=>t('favoriteTip'));
  const updateFavorite=()=>{const selected=library().favorites().includes(game.titleId);favorite.setAttribute('aria-pressed',String(selected));favorite.textContent=selected?'★':'☆';};updateFavorite();
  favorite.addEventListener('click',event=>{
    event.stopPropagation();library().toggle(game);
    document.querySelectorAll<HTMLElement>('.game-card').forEach(node=>{
      if(node.dataset.titleId!==game.titleId)return;
      const toggle=node.querySelector<HTMLButtonElement>('.favorite-toggle');
      if(toggle){const selected=library().favorites().includes(game.titleId);toggle.setAttribute('aria-pressed',String(selected));toggle.textContent=selected?'★':'☆';}
    });
    if(libraryFilter==='favorites') {
      if(!library().favorites().includes(game.titleId))removeUnfavoritedCards(cloudGrid,game.titleId,filterBar.querySelector<HTMLButtonElement>('[data-filter="favorites"]')!);
      else {appendBatch='hydrate';renderCloud();}
      if(!cloudGrid.querySelector('.game-card'))bindText(cloudGrid,()=>t('emptyFavorites'));
      updateCatalogPagination(filterCatalog(libraryTitles(),catalogQuery).length);
    }
  });
  if(game.features?.controller===true){const icon=document.createElement('span');icon.className='controller-support';icon.textContent='🎮';bindProperty(icon,'ariaLabel',()=>t('controllerSupport'));artwork.append(icon);}
  if(game.features?.multiplayer===true){const badge=document.createElement('span');badge.className='multiplayer-badge';bindText(badge,()=>t('multiplayer'));artwork.append(badge);}
  card.append(title, cardButton(() => t('play'), () => {
    // Revalidate immediately before launch too; cached metadata never grants play rights.
    if (validatingLaunch || starting || session) return;
    validatingLaunch = true;
    const generation = catalogGeneration;
    void invoke<unknown>("list_cloud_titles").then(async (raw) => {
      if (generation !== catalogGeneration) return;
      catalogRaw=raw;cloudTitles=normalizeCloudTitles(raw,catalogMetadata);
      let fresh = cloudTitles.find(item => item.titleId === game.titleId && item.playable === true);
      if (fresh) {
        // Retained card listeners can contain provisional metadata: resolve again at launch.
        if (fresh.fallbackLabel) {
          const records = (raw as {results?: {titleId?: string; details?: {productId?: string}}[]}).results ?? [];
          const productId = records.find(item => item.titleId === game.titleId)?.details?.productId;
          if (productId && productIds(raw).includes(productId)) {
            try {
              const metadata = await invoke<{Products: unknown[]}>("catalog_products", {productIds: [productId], language: catalogLanguage()});
              fresh = normalizeCloudTitles(raw, metadata).find(item => item.titleId === game.titleId) ?? fresh;
            } catch { /* Commercial fallback is still safe for presentation. */ }
          }
        }
        if (generation === catalogGeneration) await startGame("cloud", game.titleId, gameDisplayName(fresh), fresh);
      } else { cloudTitles = normalizeCloudTitles(raw, catalogMetadata); renderCloud(); notice(() => t('unavailableGame')); }
    }).catch(() => notice(() => t('availabilityFailed'))).finally(() => { validatingLaunch = false; });
  }, true), favorite);
  return card;
}
function updateCatalogPagination(_filteredCount: number): void { syncCatalogPager(); }
function renderCloud(): void {
  renderRecent();
  renderHomeFeatured();
  if (filterCatalog(libraryTitles(),catalogQuery).length) clearTextBinding(cloudGrid);
  const filtered = filterCatalog(libraryTitles(), catalogQuery);
  if (appendBatch) {
    if(filtered.length && !cloudGrid.querySelector(".game-card"))cloudGrid.replaceChildren();
    // Append mode: NUNCA rebuild. El batch son las visibles nuevas que aún no están en el grid.
    const present = new Set([...cloudGrid.children].map((child) => (child as HTMLElement).dataset?.titleId));
    const batchCards = filtered.slice(0, catalogVisible).filter((game) => !present.has(game.titleId)).map(makeGameCard);
    const batch = appendBatch;
    appendBatch = null;
    if (batch === "more") {
      cloudGridController.appendBatch(batchCards);
      updateCatalogPagination(filtered.length);
    } else {
      cloudGridController.syncCards(filtered.slice(0, catalogVisible).map(makeGameCard));
    }
    updateCatalogPagination(filtered.length);
    return;
  }
  const focusedTitle = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".game-card")?.dataset.titleId;
  cloudGrid.replaceChildren();
  if (!filtered.length && libraryFilter!=='all' && !normalizeSearch(catalogQuery)) bindText(cloudGrid,()=>['series','action','multiplayer'].includes(libraryFilter) ? t('emptyVerifiedFilter') : libraryFilter==='favorites' ? t('emptyFavorites') : t('emptyRecent'));
  else if (!filtered.length) bindText(cloudGrid,()=>normalizeSearch(catalogQuery) ? t('noSearchResults',{query:catalogQuery.trim()}) : t('emptyCloud'));
  const cards = filtered.slice(0, catalogVisible).map(makeGameCard);
  if (cards.length) cloudGrid.replaceChildren(...cards);
  updateCatalogPagination(filtered.length);
  if (focusedTitle) {
    const restored = [...cloudGrid.querySelectorAll<HTMLElement>(".game-card")].find(card => card.dataset.titleId === focusedTitle);
    (restored?.querySelector<HTMLButtonElement>("button") ?? cloudSearch).focus();
  }
}
async function hydrateCloud(generation: number): Promise<void> {
  if (loadingCatalog) return;
  loadingCatalog = true;
  const ids = productIds(catalogRaw);
  const start = catalogHydrated;
  const end = Math.min(start + 24, ids.length);
  try {
    if (end > start) {
      const missing = missingMetadataIds(ids.slice(start, end), catalogMetadata);
      const result = missing.length ? await invoke<{ Products?: unknown[] }>("catalog_products", { productIds: missing, language: catalogLanguage() }) : { Products: [] };
      if (generation !== catalogGeneration) return;
      const merged = new Map(catalogMetadata.Products.map((item) => [(item as { ProductId?: string }).ProductId, item]));
      for (const item of result.Products ?? []) merged.set((item as { ProductId?: string }).ProductId, item);
      catalogMetadata = { Products: [...merged.values()] };
      try { writeMetadata(localStorage, catalogScope, catalogLanguage(), catalogMetadata); } catch { /* storage unavailable */ }
    }
  } catch { if (generation === catalogGeneration) notice(() => t('artUnavailable')); }
  finally {
    if (generation === catalogGeneration) {
      catalogHydrated = end;
      loadingCatalog = false;
      cloudTitles = normalizeCloudTitles(catalogRaw, catalogMetadata);
      // Marcar ANTES del render: las carátulas se refrescan in-place (sin rebuild, sin jump).
      appendBatch = "hydrate";
      renderCloud();
    }
  }
}
async function loadCloud(): Promise<void> {
  const generation = ++catalogGeneration;
  loadingCatalog = true;
  cloudTitles = [];
  catalogPager.reset();
  bindText(cloudGrid,()=>t('verifyingGames'));
  try {
    const raw = await invoke<unknown>("list_cloud_titles");
    if (generation !== catalogGeneration) return;
    catalogRaw = raw;
    catalogVisible = 24;
    catalogHydrated = 0;
    try { catalogMetadata = readMetadata(localStorage, catalogScope, catalogLanguage()); } catch { catalogMetadata = { Products: [] }; }
    cloudTitles = normalizeCloudTitles(raw, catalogMetadata);
    loadingCatalog = false;
    renderCloud();
    await hydrateCloud(generation);
  } catch {
    if (generation !== catalogGeneration) return;
    cloudTitles = [];
    bindText(cloudGrid,()=>t('cloudFailed'));
  } finally { if (generation === catalogGeneration) loadingCatalog = false; }
}
function selectedProfile(): Record<string, unknown> {
  return selectedStreamConfig().profile;
}
function selectedStreamConfig() { return engineSettings(settingsStore.current); }
function updateSettingsDiagnostics() {
  if (settingsGrid) settingsGrid.dataset.selectedStreamConfig = JSON.stringify(selectedStreamConfig());
}
async function stopGame(): Promise<void> {
  connectionGeneration++;
  const attempt = connectionAttempt;
  connectionAttempt = undefined;
  attempt?.abort.abort();
  const old = session;
  session = undefined;
  const releaseControls = cleanupLoadingControls; cleanupLoadingControls = undefined;
  const releaseHud = cleanupHud; cleanupHud = undefined;
  const releaseFullscreen = cleanupFullscreen; cleanupFullscreen = undefined;
  // Each disposer is independent: a local teardown error must not strand the UI
  // or prevent the exact backend attempt from being cancelled.
  try {
    for (const release of [releaseControls, () => disposeStreamLoading(overlay), releaseHud, releaseFullscreen]) {
      try { release?.(); } catch { /* Continue releasing the remaining owners. */ }
    }
    const stopping = old ? old.stop() : attempt ? settleRemoteStop(invoke('cancel_connection', {attemptId: attempt.id})) : Promise.resolve();
    void stopping.catch(() => { /* Cancellation/late 410 never become menu banners. */ });
  } finally {
    video.srcObject = null;
    overlay.hidden = true;
    starting = false;
    toast.hidden = true; clearTextBinding(toast); toast.textContent = '';
    setScreen("dashboard");
    renderHomeRecent(currentConsoles);
    const origin=attempt?.origin;
    switchTab(attempt?.tab ?? activeTab, !origin?.isConnected);
    if(origin?.isConnected && !origin.closest('[hidden]'))origin.focus({preventScroll:true});
  }
}
async function startGame(kind: "home" | "cloud", target: string, name: string, artwork?: CloudTitle, console?: ConsoleItem): Promise<void> {
  if (starting || connectionAttempt || session) return;
  connectionGeneration++;
  const attempt = { id: crypto.randomUUID(), abort: new AbortController(), tab: activeTab, origin: document.activeElement as HTMLElement | null };
  connectionAttempt = attempt;
  const active = () => connectionAttempt === attempt && !attempt.abort.signal.aborted;
  const check = () => { if (!active()) throw new DOMException('Connection cancelled', 'AbortError'); };
  starting = true;
  toast.hidden = true;
  clearTextBinding(toast); toast.textContent = '';
  try {
    setScreen("player");
    const selectedGame = artwork ?? (kind === "cloud" ? cloudTitles.find(game => game.titleId === target) : undefined);
    showStreamLoading(overlay, kind, { ...selectedGame, titleId: target, name, fallbackLabel: false }, console);
    cleanupLoadingControls?.();
    cleanupLoadingControls = mountLoadingControls(overlay, () => { if (active() && !overlay.hidden) void stopGame(); }, currentProfile);
    message = get<HTMLElement>("stream-message");
    // WNS belongs to this visible attempt, before any WebRTC peer exists.
    if (kind === 'home' && console?.id) {
      bindText(message,()=>t('waking'));
      try { await invoke('wake_console', {deviceId: console.id, attemptId: attempt.id}); }
      catch { check(); throw new LocalizedError('wakeHelp'); }
      check(); bindText(message,()=>t('preparingConsole'));
    }
    await settingsReady;
    check();
    await settingsStore.flush();
    check();
    const controller = new XboxWebRtcController(undefined, selectedStreamConfig().options);
    cleanupFullscreen?.();
    const releaseFullscreen = bindPlayerFullscreen(video, window);
    // HUD autohide: se activa al reproducir; el cursor se reaparece en la zona superior.
    cleanupHud?.();
    const hudToolbar = playerToolbar ?? document.createElement("div");
    const hudCursor = document.getElementById("xjaus-cursor") ?? document.createElement("div");
    hudCursor.id = "xjaus-cursor";
    if (!hudCursor.parentElement) document.body.append(hudCursor);
    const hud = createPlayerHudController({ hud: hudToolbar, cursor: hudCursor, video, window, storage: localStorage });
    cleanupHud = () => hud.dispose();
    const releaseLoading = bindLoadingPlayback(video, overlay);
    const playbackLibrary=library();
    const releaseHistory=bindSuccessfulCloudPlayback(video,active,()=>{
      if(kind==='cloud' && selectedGame)playbackLibrary.record(selectedGame);
      else if(kind==='home')playbackLibrary.recordHome(target,name);
      renderRecent();
    });
    const onPlaying = () => { if (active()) { cleanupLoadingControls?.(); cleanupLoadingControls = undefined; } };
    video.addEventListener('playing', onPlaying);
    const statsPanel=document.createElement('pre');statsPanel.className='stream-telemetry';statsPanel.hidden=true;statsPanel.setAttribute('aria-live','off');playerScreen.append(statsPanel);
    const indicator=document.createElement('div');indicator.className='stream-reconnecting';indicator.hidden=true;indicator.setAttribute('role','status');bindText(indicator,()=>t('reconnectingStream'));playerScreen.append(indicator);
    const telemetry=createStreamTelemetry(controller.peer, stats=>{
      const value=(n:number|null,digits=1)=>n===null?'—':n.toFixed(digits);
      statsPanel.textContent=`FPS ${value(stats.fps)} · ${value(stats.mbps)} Mbps\nRTT ${value(stats.rttMs)} ms · ${t('packetLoss')} ${value(stats.lossPercent)}%\n${t('decodeTime')} ${value(stats.decodeMs,2)} ms`;
    });
    let statsRequested=uiPreferences.current.statsOnStart;
    const syncStatsVisibility=()=>telemetry.setVisible(statsRequested&&!document.hidden);
    if (statsRequested) statsPanel.hidden=false;
    syncStatsVisibility();
    const toggleTelemetry=()=>{if(!active() || !overlay.hidden)return;statsRequested=!statsRequested;statsPanel.hidden=!statsRequested;syncStatsVisibility();};
    document.addEventListener('visibilitychange',syncStatsVisibility);
    const menu=mountStreamMenu(playerScreen,{setModal:value=>{controller.gamepad.setModal(value);if(!value)hud.reveal();},toggleTelemetry,disconnect:stopGame,exit:async()=>{await invoke('app_exit');},
      screenshot:()=>{const frame=captureVideoFrame(video);if(!frame){notice(()=>t('screenshotFailed'));return;}const link=document.createElement('a');link.href=frame;link.download=`xjaus-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;link.click();notice(()=>t('screenshotSaved'));},
      vibration:async()=>{const result=await testVibration(()=>[...navigator.getGamepads()]);notice(()=>t(result==='ok'?'vibrationTested':'vibrationUnavailable'));}});
    const toggleMenu=()=>{if(active() && overlay.hidden)menu.toggle();};
    const menuButton=get('stream-menu-button');menuButton.addEventListener('click',toggleMenu);
    const telemetryKey=(event:KeyboardEvent)=>{if(event.key==='F11'&&event.ctrlKey&&!event.repeat){event.preventDefault();toggleTelemetry();}};
    window.addEventListener('keydown',telemetryKey);
    const grace=new ConnectionGrace(()=>{if(active())void stopGame();},visible=>{indicator.hidden=!visible;});
    controller.onRemoteEnd=()=>{if(active())void stopGame();};
    const onConnection=()=>{if(active())grace.update(controller.peer.connectionState,controller.peer.iceConnectionState);};
    controller.peer.addEventListener('connectionstatechange',onConnection);
    controller.peer.addEventListener('iceconnectionstatechange',onConnection);
    controller.gamepad.onMenuToggle=toggleMenu;
    controller.gamepad.onTelemetryToggle=toggleTelemetry;
    controller.gamepad.onModalPoll=pads=>menu.poll(pads);
    // Guide long-press/chord owns the explicit accessible modal, never the toolbar.
    cleanupFullscreen = () => {
      document.removeEventListener('visibilitychange',syncStatsVisibility);menu.dispose();telemetry.dispose();grace.dispose();statsPanel.remove();indicator.remove();
      menuButton.removeEventListener('click',toggleMenu);window.removeEventListener('keydown',telemetryKey);
      controller.gamepad.onMenuToggle=undefined;controller.gamepad.onTelemetryToggle=undefined;controller.gamepad.onModalPoll=undefined;
      cleanupHud?.();
      cleanupHud = undefined;
      releaseFullscreen();
      releaseLoading();
      releaseHistory();
      video.removeEventListener('playing', onPlaying);
      controller.gamepad.onGuidePress = undefined;
      controller.onRemoteEnd = undefined;
      controller.peer.removeEventListener("connectionstatechange", onConnection);
      controller.peer.removeEventListener("iceconnectionstatechange", onConnection);
    };
    void hud;
    controller.attachVideoElement(video);
    const candidate = new XboxSessionCoordinator(
      controller,
      (error) => { if (active()) { const message=errorText(error); notice(()=>/streaming keepalive HTTP 401|No se pudo renovar la sesión Xbox/i.test(message) ? t('sessionRenewalFailed') : t('iceError',{error:message})); } },
      ({ state, queue }) => {
        if (!active()) return;
        if (kind === "home") return;
        if (state) bindText(message, () => {
          const parts = [queue?.estimatedTotalWaitTimeSeconds ? t('estimatedWait',{seconds:queue.estimatedTotalWaitTimeSeconds}) : '', queue?.queuePosition ? t('queuePosition',{position:queue.queuePosition}) : ''].filter(Boolean);
          return t('connectingCloud') + (parts.length ? ` (${parts.join(', ')})` : '');
        });
      },
      attempt.id,
    );
    session = candidate;
    await candidate.negotiate(kind, target, selectedProfile());
    check();
    if (kind === "cloud") bindText(message,()=>t('waitingVideo'));
  } catch (error) {
    if (!active()) return;
    const stoppedGeneration = connectionGeneration + 1;
    await stopGame();
    if (connectionGeneration === stoppedGeneration) notice(() => t('connectionFailed',{name:name,error:errorText(error)}));
  } finally { if (active()) starting = false; }
}

get<HTMLButtonElement>("btn-login").addEventListener("click", async () => {
  const generation = ++loginGeneration;
  disposeLoginCode();
  loginFeedback.hidden = false;
  bindText(loginFeedback,()=>t('requestingCode'));
  try {
    const result = await invoke<{user_code: string; verification_uri: string; verification_uri_complete: string; interval: number; expires_in: number}>("begin_login_window");
    if (generation !== loginGeneration) return;
    clearTextBinding(loginFeedback); loginFeedback.replaceChildren();
    const hint = document.createElement("p"); bindText(hint,()=>t('loginCode',{uri:result.verification_uri}));
    const code = createLoginCode(result.user_code);
    cleanupLoginCode = code.dispose;
    const browserButton = cardButton(() => t('openMicrosoft'), () => {
      void openUrl(result.verification_uri_complete).catch((error) => { notice(() => t('browserError',{error:errorText(error)})); });
    }, true);
    const progress = document.createElement("div"); progress.className = "poll-status"; bindText(progress,()=>t('waitingAuthorization'));
    loginFeedback.append(hint, code.button, code.status, browserButton, progress);
    const until = Date.now() + result.expires_in * 1000;
    let interval = Math.max(5000, result.interval * 1000);
    while (generation === loginGeneration && Date.now() < until) {
      await new Promise((resolve) => window.setTimeout(resolve, interval));
      if (generation !== loginGeneration) break;
      try {
        const status = await invoke<Status>("poll_login");
        showAuth(status);
        return;
      } catch (error) {
        const detail = errorText(error);
        if (detail.includes("slow_down")) interval += 5000;
        if (detail.includes("expired")) break;
        bindText(progress,()=>detail.includes("Waiting for user") ? t('waitingAuthorization') : t('retrying',{error:detail}));
      }
    }
    if (generation === loginGeneration) { disposeLoginCode(); code.button.disabled = true; bindText(progress,()=>t('expiredCode')); }
  } catch (error) { if (generation === loginGeneration) { disposeLoginCode(); bindText(loginFeedback,()=>t('genericError',{error:errorText(error)})); } }
});
get<HTMLButtonElement>("manual-login").addEventListener("click", async () => {
  loginGeneration++;
  disposeLoginCode();
  try { showAuth(await invoke<Status>("load_session")); }
  catch (error) { loginFeedback.hidden = false; clearTextBinding(loginFeedback); loginFeedback.textContent = errorText(error); }
});
for (const tab of ["home", "consoles", "cloud", "settings"] as const) {
  document.querySelector<HTMLButtonElement>(`button[data-action="${tab}"]`)?.addEventListener("click", () => {
    switchTab(tab);
    if (tab === "settings") void refreshProfile();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-home-action]')) {
  button.addEventListener('click', () => switchTab(button.dataset.homeAction as Extract<Tab, 'cloud' | 'consoles'>));
}

get<HTMLButtonElement>('support-us').addEventListener('click',()=>{
  void openUrl('https://paypal.me/Comicoon').catch(error=>notice(()=>t('browserError',{error:errorText(error)})));
});
// --- Perfil Xbox en Ajustes (cuenta opaca + caché por accountScope) ---
get<HTMLButtonElement>('refresh-consoles')?.addEventListener('click',()=>consolePolling.refresh());
get<HTMLButtonElement>('refresh-consoles-context').addEventListener('click',()=>consolePolling.refresh());
const settingsGrid = document.querySelector<HTMLElement>("#panel-settings .settings-grid");
const profileSlot = document.querySelector<HTMLElement>("#settings-profile-slot");
const profilePanel = profileSlot
  ? createProfilePanel(profileSlot, {
      fetchProfile: async () => {
        const generation = catalogGeneration;
        const profile = await invoke<XboxProfile>("xbox_profile");
        if (generation === catalogGeneration) {
          currentProfile = profile;
          const attempt = connectionAttempt;
          if (attempt && !overlay.hidden && !playerScreen.hidden) {
            cleanupLoadingControls?.();
            cleanupLoadingControls = mountLoadingControls(overlay, () => {
              if (connectionAttempt === attempt && !overlay.hidden) void stopGame();
            }, profile);
          }
        }
        return profile;
      },
      onLogout: async () => {
        try {
          await invoke<unknown>("logout");
          showAuth({ authenticated: false, account: "", storage: "" });
        } catch (error) { notice(() => t('signOutFailed',{error:errorText(error)})); }
      },
    })
  : undefined;
async function refreshProfile(): Promise<void> {
  if (!profilePanel || !settingsProfileVisible()) return;
  await profilePanel.refresh();
}
function settingsProfileVisible(): boolean {
  return !dashboard.hidden && activeTab === "settings";
}
const settingsStore = createSettingsStore(localStorage, command => invoke(command), settings => invoke("save_settings", { settings }));
// --- Cloud Gaming: métricas reales del catálogo + franja contextual del juego enfocado ---
const cloudContext = initCloudContext({
  grid: cloudGrid,
  meta: get('cloud-meta'),
  panel: get('cloud-context'),
  title: get('cloud-context-title'),
  art: get<HTMLImageElement>('cloud-context-art'),
  tags: get('cloud-context-tags'),
  description: get('cloud-context-description'),
  play: get<HTMLButtonElement>('cloud-context-play'),
});
const cloudMetaObserver = new MutationObserver(() => cloudContext.updateMeta());
cloudMetaObserver.observe(cloudGrid, { childList: true, attributes: true, subtree: true });
window.addEventListener('pagehide', () => cloudMetaObserver.disconnect(), { once: true });
const controls = ["resolution", "bitrate", "codec", "audio", "audioGain"] as const;
for (const key of controls) get<HTMLInputElement>(`stream-${key}`).disabled = true;
const settingsReady = settingsStore.load().then(settings => {
  for (const key of controls) {
    const control = get<HTMLInputElement>(`stream-${key}`);
    control.value = String(settings[key] ?? (key === "audioGain" ? 1 : "")); control.disabled = false;
  }
  updateSettingsDiagnostics();
  updateStreamLabels();
});
get<HTMLSelectElement>("stream-resolution").addEventListener("change", (event) => {
  const resolution = (event.currentTarget as HTMLSelectElement).value;
  const bitrate = get<HTMLInputElement>("stream-bitrate");
  bitrate.value = String(recommendedBitrate(resolution, Number(bitrate.value)));
});
for (const key of controls) get<HTMLInputElement>(`stream-${key}`).addEventListener("change", () => {
  const settings: StreamSettings = { resolution: get<HTMLInputElement>("stream-resolution").value, bitrate: Number(get<HTMLInputElement>("stream-bitrate").value), codec: get<HTMLInputElement>("stream-codec").value, audio: get<HTMLInputElement>("stream-audio").value, audioGain: Number(get<HTMLInputElement>("stream-audioGain").value) };
  updateStreamLabels();
  void settingsStore.save(settings).then(updateSettingsDiagnostics).catch(() => notice(() => t('saveSettingsFailed')));
});
// --- Subnavegación de Configuración (mockup: subnav con iconos + panel por sección) ---
initSettingsNavigation(document);
// --- Preferencias locales de interfaz (xjaus:ui:v1; nunca tocan el streaming) ---
const uiControls = { density: get<HTMLSelectElement>('ui-density'), cardTitles: get<HTMLSelectElement>('ui-card-titles'), focusIntensity: get<HTMLSelectElement>('ui-focus-intensity'), statsOnStart: get<HTMLInputElement>('ui-stats-on-start') };
function hydrateUiControls(prefs: UiPreferences): void {
  uiControls.density.value = prefs.density;
  uiControls.cardTitles.value = prefs.cardTitles;
  uiControls.focusIntensity.value = prefs.focusIntensity;
  uiControls.statsOnStart.checked = prefs.statsOnStart;
}
hydrateUiControls(uiPreferences.current);
for (const control of Object.values(uiControls)) control.addEventListener('change', () => {
  applyUiPreferences(uiPreferences.save({
    density: uiControls.density.value as UiPreferences['density'],
    cardTitles: uiControls.cardTitles.value as UiPreferences['cardTitles'],
    focusIntensity: uiControls.focusIntensity.value as UiPreferences['focusIntensity'],
    statsOnStart: uiControls.statsOnStart.checked,
  }));
});
// --- Acerca de: versión real del paquete + repositorio oficial ---
get<HTMLElement>('app-version').textContent = appVersion;
get<HTMLButtonElement>('open-repo').addEventListener('click', () => { void openUrl('https://github.com/perjesus111-hub/xjaus').catch(error => notice(() => t('browserError', { error: errorText(error) }))); });
function searchInput() { catalogSearchPending=true; catalogPager.reset(); appendBatch=null; metadataQueue.cancelPending(); searchController.input(cloudSearch.value); }
cloudSearch.addEventListener("input", searchInput);
cloudSearch.addEventListener("search", searchInput);
const languageControl = get<HTMLSelectElement>('app-language');
languageControl.value = i18n.preference;
const stopCatalogLocaleWatch = watchCatalogLocale(i18n, () => catalogRaw !== undefined, () => {
  metadataQueue.cancelPending();
  void loadCloud();
});
window.addEventListener('pagehide', stopCatalogLocaleWatch, { once: true });
languageControl.addEventListener('change', () => {
  const value = languageControl.value;
  if (value === 'auto' || value === 'es' || value === 'en') i18n.setPreference(value);
});
get<HTMLButtonElement>('copy-diagnostics').addEventListener('click', async () => {
  const report = sanitizeDiagnostics(get<HTMLElement>('output').textContent ?? '');
  try { await navigator.clipboard.writeText(report); notice(() => t('diagnosticsCopied')); }
  catch { notice(() => t('diagnosticsCopyFailed')); }
});
get<HTMLButtonElement>("stop-stream").addEventListener("click", () => { void stopGame(); });
void settingsReady.then(() => invoke<Status>("auth_status")).then(showAuth).catch((error) => notice(() => t('sessionStatus',{error:errorText(error)})));

function updateStreamLabels() {
 syncRangeFill(get<HTMLInputElement>('stream-bitrate'));
 bindText(get('stream-bitrate-value'),()=>t('bitrateValue',{value:Number(get<HTMLInputElement>('stream-bitrate').value)/1000}));
 bindText(get('stream-gain-value'),()=>t('gainValue',{value:Number(get<HTMLInputElement>('stream-audioGain').value)}));
}
get('stream-bitrate').addEventListener('input',updateStreamLabels);
get('stream-audioGain').addEventListener('input',updateStreamLabels);

window.addEventListener('pagehide',()=>{if(connectionAttempt||session)void stopGame();});
