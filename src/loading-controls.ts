import { t, bindText, bindProperty } from './i18n';
import { avatarUrl, subscriptionLabel, type XboxProfile } from './profile-panel';
/** One loading-only B poller. The catalog loop is disabled while this is mounted.
 * Disposed on playing/cancel; gameplay and fullscreen own input afterwards. */
export function mountLoadingControls(root: HTMLElement, cancel: () => void, profile?: XboxProfile): () => void {
 const header=document.createElement('div'); header.className='loading-header-actions';
 if(profile?.gamertag) {
  const identity=document.createElement('div'); identity.className='loading-profile';
  if(profile.gameDisplayPicRaw) {const avatar=document.createElement('img'); avatar.src=avatarUrl(profile.gameDisplayPicRaw);avatar.alt='';avatar.width=36;avatar.height=36;identity.append(avatar);}
  const info=document.createElement('div'), tag=document.createElement('strong'), meta=document.createElement('span');
  tag.textContent=profile.gamertag;meta.textContent=[profile.gamerscore ? `${profile.gamerscore} G` : '',subscriptionLabel(profile)].filter(Boolean).join(' · ');
  info.append(tag,meta);identity.append(info);header.append(identity);
 }
 const button=document.createElement('button');button.type='button';button.className='loading-exit-btn';
 bindProperty(button,'ariaLabel',()=>t('cancelConnectionLabel'));
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const [k,v] of Object.entries({width:'14',height:'14',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','aria-hidden':'true'}))svg.setAttribute(k,v);
 const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M18 6L6 18M6 6l12 12');svg.append(path);
 const label=document.createElement('span');bindText(label,()=>t('cancelConnection'));
 const badge=document.createElement('span');badge.className='loading-cancel-badge';badge.textContent='B';badge.setAttribute('aria-hidden','true');
 button.append(svg,label,badge);button.addEventListener('click',cancel);header.append(button);root.append(header);
 let disposed=false,frame=0,wasPressed=false;
 const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.repeat){event.preventDefault();event.stopImmediatePropagation();cancel();}};
 window.addEventListener('keydown',key,true);
 const poll=()=>{
  if(disposed)return;
  const pressed=Array.from(navigator.getGamepads?.()??[]).some(pad=>pad?.buttons[1]?.pressed);
  if(pressed&&!wasPressed)cancel();wasPressed=pressed;
  if(!disposed)frame=requestAnimationFrame(poll);
 };
 frame=requestAnimationFrame(poll);
 return ()=>{disposed=true;cancelAnimationFrame(frame);window.removeEventListener('keydown',key,true);button.removeEventListener('click',cancel);header.remove();};
}
