const MIN_WIDTH=860;
const MIN_HEIGHT=600;
function normalBounds(bounds){
  if(!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return undefined;
  return {x:Number.isFinite(bounds.x)?Math.round(bounds.x):0,y:Number.isFinite(bounds.y)?Math.round(bounds.y):0,width:Math.max(MIN_WIDTH,Math.round(bounds.width)),height:Math.max(MIN_HEIGHT,Math.round(bounds.height))};
}
function intersects(bounds,area){
  return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
}
function overlap(bounds,area){
  return Math.max(0,Math.min(bounds.x+bounds.width,area.x+area.width)-Math.max(bounds.x,area.x))*Math.max(0,Math.min(bounds.y+bounds.height,area.y+area.height)-Math.max(bounds.y,area.y));
}
function restoreWindowState(state,displays,fallback){
  const bounds=normalBounds(state?.bounds);
  if(!bounds || !Array.isArray(displays)) return {...fallback};
  const candidates=displays.filter(display=>display?.workArea && intersects(bounds,display.workArea));
  if(!candidates.length) return {...fallback};
  const area=candidates.sort((a,b)=>overlap(bounds,b.workArea)-overlap(bounds,a.workArea))[0].workArea;
  const width=Math.min(bounds.width,area.width);
  const height=Math.min(bounds.height,area.height);
  return {width,height,x:Math.min(Math.max(bounds.x,area.x),area.x+area.width-width),y:Math.min(Math.max(bounds.y,area.y),area.y+area.height-height)};
}
function persistWindowState(store,window){
  if(window.isDestroyed?.()) return;
  const bounds=normalBounds(window.getNormalBounds?.());
  if(!bounds) return;
  store.set('windowState',{bounds,maximized:Boolean(window.isMaximized?.())});
}
module.exports={restoreWindowState,persistWindowState,MIN_WIDTH,MIN_HEIGHT};
