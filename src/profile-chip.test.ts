// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { createProfilePanel } from './profile-panel';
it('keeps an identified Core product ahead of cloud fallback and hides absent avatars', async () => {
 const value={gamertag:'Mock profile',gameDisplayName:'',gamerscore:'0',gameDisplayPicRaw:'',accountTier:'',subscription:{plan:'Xbox Game Pass Core',cloudAccess:true,label:'',source:'explicit-subscription-product'}};
 const panel=createProfilePanel(document.createElement('div'),{fetchProfile:async()=>value});
 await panel.refresh(); expect(panel.elements.meta.textContent).toContain('Xbox Game Pass Core');expect(panel.elements.avatar.hidden).toBe(true);
});
it('updates compact identity from verified backend profile and clears on logout', async () => {
 document.body.innerHTML='<div id="profile-chip" hidden></div><div id="target"></div>';
 const panel=createProfilePanel(document.getElementById('target')!,{fetchProfile:async()=>({gamertag:'Mock Player · UI fixture',gameDisplayName:'Mock',gamerscore:'1234',gameDisplayPicRaw:'',accountTier:'',subscription:{plan:null,cloudAccess:true,label:'',source:'cloud'}})});
 await panel.refresh(); const chip=document.getElementById('profile-chip')!;
 expect(chip.hidden).toBe(false);expect(chip.textContent).toContain('Mock Player · UI fixture');expect(chip.textContent).toContain('1234 G');
 panel.clear();expect(chip.hidden).toBe(true);expect(chip.textContent).toBe('');
});
