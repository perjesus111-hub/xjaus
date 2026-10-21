import {bindText,t} from './i18n';
import {focusGamepad} from './ten-foot';
export type StreamMenuActions={setModal:(value:boolean)=>void;toggleTelemetry:()=>void;disconnect:()=>Promise<void>;exit:()=>Promise<void>;screenshot?:()=>void;vibration?:()=>Promise<void>};
export function mountStreamMenu(parent:HTMLElement,actions:StreamMenuActions) {
 const dialog=document.createElement('dialog');dialog.className='stream-menu';dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','stream-menu-title');
 const head=document.createElement('div');head.className='stream-menu-head';
 const badge=document.createElement('span');badge.className='stream-menu-badge';badge.setAttribute('aria-hidden','true');badge.textContent='✕';
 const heading=document.createElement('h2');heading.id='stream-menu-title';bindText(heading,()=>t('streamMenu'));
 const clock=document.createElement('span');clock.className='stream-menu-clock';
 head.append(badge,heading,clock);dialog.append(head);
 let opened=false,disposed=false,busy=false,previous:HTMLElement|null=null,clockTimer:ReturnType<typeof setInterval>|undefined;
 const tickClock=()=>{clock.textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});};
 const startClock=()=>{tickClock();clockTimer??=setInterval(tickClock,15000);};
 const stopClock=()=>{if(clockTimer!==undefined){clearInterval(clockTimer);clockTimer=undefined;}};
 const buttons:HTMLButtonElement[]=[];
 const clearPadFocus=()=>{dialog.querySelectorAll('.gamepad-focus').forEach(el=>el.classList.remove('gamepad-focus'));};
 const close=()=>{if(!opened)return;opened=false;stopClock();clearPadFocus();dialog.close();document.documentElement.classList.remove('stream-menu-open');if(previous?.isConnected)previous.focus();actions.setModal(false);};
 const run=async(action:string)=>{
  if(busy||disposed)return;
  if(action==='resume'){close();return;}
  if(action==='telemetry'){actions.toggleTelemetry();return;}
  if(action==='screenshot'){actions.screenshot?.();return;}
  if(action==='vibration'){await actions.vibration?.();return;}
  busy=true;buttons.forEach(b=>b.disabled=true);
  try{await actions.disconnect();if(action==='exit')await actions.exit();}
  finally{busy=false;if(!disposed){buttons.forEach(b=>b.disabled=false);close();}}
 };
 for(const [action,key] of [['resume','resumeStream'],['screenshot','screenshotItem'],['vibration','testVibration'],['telemetry','telemetry'],['disconnect','disconnectStream'],['exit','exitApp']] as const){
  const button=document.createElement('button');button.type='button';button.dataset.action=action;bindText(button,()=>t(key));button.addEventListener('click',()=>{void run(action).catch(()=>{});});buttons.push(button);dialog.append(button);
 }
 const hints=document.createElement('div');hints.className='stream-menu-hints';
 for(const [buttonLabel,hintClass,key] of [['A','hint-a','menuHintSelect'],['B','hint-b','menuHintBack']] as const){
  const hint=document.createElement('span');hint.classList.add(hintClass);
  const keyLabel=document.createElement('kbd');keyLabel.textContent=buttonLabel;hint.append(keyLabel);
  const label=document.createElement('span');bindText(label,()=>t(key));hint.append(label);
  hints.append(hint);
 }
 dialog.append(hints);
 parent.append(dialog);
 const states=new Map<number,{pressed:Set<number>;direction?:number;repeatAt:number}>();
 const open=()=>{if(disposed||opened)return;previous=document.activeElement as HTMLElement|null;opened=true;states.clear();actions.setModal(true);document.exitPointerLock?.();document.documentElement.classList.add('stream-menu-open');dialog.showModal();startClock();focusGamepad(buttons[0]);};
 const toggle=()=>opened?close():open();
 const focus=(delta:number)=>{const index=buttons.indexOf(document.activeElement as HTMLButtonElement);focusGamepad(buttons[(Math.max(0,index)+delta+buttons.length)%buttons.length]);};
 // Mouse/keyboard focus inside the dialog supersedes the pad marker.
 const onDialogFocusIn=(event:Event)=>{const target=event.target as HTMLElement;if(buttons.includes(target as HTMLButtonElement)&&!target.classList.contains('gamepad-focus'))clearPadFocus();};
 const onDialogFocusOut=(event:FocusEvent)=>{const target=event.target as HTMLElement;if(target.classList?.contains('gamepad-focus')&&!dialog.contains(event.relatedTarget as Node|null))clearPadFocus();};
 const keydown=(event:KeyboardEvent)=>{
  if(!opened)return;
  if(event.ctrlKey&&event.key==='F11')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.repeat)return;
  if(event.key==='Escape'){close();return;}
  if(event.key==='Tab'){focus(event.shiftKey?-1:1);return;}
  if(['ArrowUp','ArrowLeft'].includes(event.key))focus(-1);
  if(['ArrowDown','ArrowRight'].includes(event.key))focus(1);
  if(event.key==='Enter'||event.key===' ') (document.activeElement as HTMLButtonElement)?.click();
 };
 const cancel=(event:Event)=>{event.preventDefault();close();};
 // Keep local controls interactive, but never bubble their input into the player.
 const pointerEvents=['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','click','dblclick','contextmenu','wheel'] as const;
 const contain=(event:Event)=>{event.stopPropagation();};
 const outside=(event:Event)=>{if(opened&&!dialog.contains(event.target as Node)){event.preventDefault();event.stopImmediatePropagation();}};
 const backdrop=(event:MouseEvent)=>{
  if(event.target!==dialog)return;
  const rect=dialog.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();
 };
 const keyup=(event:KeyboardEvent)=>{if(opened){event.preventDefault();event.stopImmediatePropagation();}};
 pointerEvents.forEach(type=>{dialog.addEventListener(type,contain);window.addEventListener(type,outside,{capture:true,passive:false});});
 dialog.addEventListener('click',backdrop);
 dialog.addEventListener('focusin',onDialogFocusIn);
 dialog.addEventListener('focusout',onDialogFocusOut);
 window.addEventListener('keyup',keyup,true);
 window.addEventListener('keydown',keydown,true);dialog.addEventListener('cancel',cancel);
 return {get open(){return opened;},toggle,poll(pads:readonly Gamepad[],now=performance.now()){
  if(!opened||disposed||busy)return;
  const present=new Set<number>();
  for(const pad of pads){
   present.add(pad.index);const pressed=new Set(pad.buttons.flatMap((b,i)=>b.pressed||b.value>.5?[i]:[]));
   const old=states.get(pad.index);if(!old){states.set(pad.index,{pressed,repeatAt:0});continue;}
   if(pressed.has(1)&&!old.pressed.has(1)){close();return;}
   let direction=pressed.has(12)||pressed.has(14)?-1:pressed.has(13)||pressed.has(15)?1:undefined;
   const axis= Math.abs(pad.axes[1]??0)>.5?pad.axes[1]:Math.abs(pad.axes[3]??0)>.5?pad.axes[3]:Math.abs(pad.axes[0]??0)>.5?pad.axes[0]:pad.axes[2];
   if(direction===undefined&&Math.abs(axis??0)>.5)direction=axis<0?-1:1;
   if(direction!==undefined&&(direction!==old.direction||now>=old.repeatAt)){focus(direction);old.repeatAt=now+200;}
   old.direction=direction;
   if(pressed.has(0)&&!old.pressed.has(0))(document.activeElement as HTMLButtonElement)?.click();
   old.pressed=pressed;
  }
  for(const index of states.keys())if(!present.has(index))states.delete(index);
 },dispose(){if(disposed)return;close();stopClock();disposed=true;pointerEvents.forEach(type=>{dialog.removeEventListener(type,contain);window.removeEventListener(type,outside,true);});dialog.removeEventListener('click',backdrop);dialog.removeEventListener('focusin',onDialogFocusIn);dialog.removeEventListener('focusout',onDialogFocusOut);window.removeEventListener('keyup',keyup,true);window.removeEventListener('keydown',keydown,true);dialog.removeEventListener('cancel',cancel);states.clear();dialog.remove();}};
}
