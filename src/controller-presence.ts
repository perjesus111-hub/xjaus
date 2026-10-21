/** Presence only: USB and Bluetooth both use the same browser API. */
export function createControllerPresence(){
 let disposed=false;
 const update=()=>{if(disposed)return;let present=false;try{present=Array.from(navigator.getGamepads?.()??[]).some(pad=>pad?.connected===true);}catch{/* unavailable */}
 for(const hint of document.querySelectorAll<HTMLElement>('.shoulder-hint'))if(hint.hidden===present)hint.hidden=!present;
 // Authentic header state: the pill mirrors the same Gamepad API presence.
 const pill=document.getElementById('controller-status');if(pill)pill.hidden=!present;};
 window.addEventListener('gamepadconnected',update);window.addEventListener('gamepaddisconnected',update);update();
 return {sync:update,dispose(){disposed=true;window.removeEventListener('gamepadconnected',update);window.removeEventListener('gamepaddisconnected',update);}};
}
