import {bindText,t} from './i18n';
export function mountStreamMenu(parent:HTMLElement,actions:{setModal:(value:boolean)=>void;toggleTelemetry:()=>void;disconnect:()=>Promise<void>;exit:()=>Promise<void>}) {
 const dialog=document.createElement('dialog');dialog.className='stream-menu';dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','stream-menu-title');
 const heading=document.createElement('h2');heading.id='stream-menu-title';bindText(heading,()=>t('streamMenu'));dialog.append(heading);
 let opened=false,disposed=false,busy=false,previous:HTMLElement|null=null;
 const buttons:HTMLButtonElement[]=[];
 const close=()=>{if(!opened)return;opened=false;dialog.close();document.documentElement.classList.remove('stream-menu-open');if(previous?.isConnected)previous.focus();actions.setModal(false);};
 const run=async(action:string)=>{
  if(busy||disposed)return;
  if(action==='resume'){close();return;}
  if(action==='telemetry'){actions.toggleTelemetry();return;}
  busy=true;buttons.forEach(b=>b.disabled=true);
  try{await actions.disconnect();if(action==='exit')await actions.exit();}
  finally{busy=false;if(!disposed){buttons.forEach(b=>b.disabled=false);close();}}
 };
 for(const [action,key] of [['resume','resumeStream'],['telemetry','telemetry'],['disconnect','disconnectStream'],['exit','exitApp']] as const){
  const button=document.createElement('button');button.type='button';button.dataset.action=action;bindText(button,()=>t(key));button.addEventListener('click',()=>{void run(action).catch(()=>{});});buttons.push(button);dialog.append(button);
 }
 parent.append(dialog);
 const states=new Map<number,{pressed:Set<number>;direction?:number;repeatAt:number}>();
 const open=()=>{if(disposed||opened)return;previous=document.activeElement as HTMLElement|null;opened=true;states.clear();actions.setModal(true);document.exitPointerLock?.();document.documentElement.classList.add('stream-menu-open');dialog.showModal();buttons[0].focus();};
 const toggle=()=>opened?close():open();
 const focus=(delta:number)=>{const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(Math.max(0,index)+delta+buttons.length)%buttons.length].focus();};
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
 },dispose(){if(disposed)return;close();disposed=true;pointerEvents.forEach(type=>{dialog.removeEventListener(type,contain);window.removeEventListener(type,outside,true);});dialog.removeEventListener('click',backdrop);window.removeEventListener('keyup',keyup,true);window.removeEventListener('keydown',keydown,true);dialog.removeEventListener('cancel',cancel);states.clear();dialog.remove();}};
}
