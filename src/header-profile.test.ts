// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { createProfilePanel } from './profile-panel';
it('header renders real circular avatar with neutral loading/error fallback and dynamic plan', async()=>{
 document.body.innerHTML='<span id="profile-chip" hidden></span><div id="target"></div>';
 const profile={gamertag:'Synthetic Player',gamerscore:'42',gameDisplayName:'',gameDisplayPicRaw:'https://images-eds.xboxlive.com/avatar',accountTier:'',subscription:{plan:'Xbox Game Pass Core',cloudAccess:true,label:'',source:'explicit-subscription-product'}};
 const panel=createProfilePanel(document.querySelector('#target')!,{fetchProfile:async()=>profile});await panel.refresh();
 const chip=document.querySelector('#profile-chip')!;const img=chip.querySelector('img')!;
 expect(img).not.toBeNull();expect(img.hidden).toBe(true);expect(chip.textContent).toContain('42 G');expect(chip.textContent).toContain('Xbox Game Pass Core');
 img.dispatchEvent(new Event('load'));expect(img.hidden).toBe(false);
 img.dispatchEvent(new Event('error'));expect(img.hidden).toBe(true);expect(chip.querySelector('.profile-chip-placeholder')).not.toBeNull();
 profile.subscription.plan='Xbox Game Pass Standard';await panel.refresh();expect(chip.textContent).toContain('Xbox Game Pass Standard');expect(chip.textContent).not.toContain('Ultimate');panel.clear();expect(chip.children.length).toBe(0);
});
