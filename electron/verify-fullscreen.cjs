const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFullscreenController}=require('./fullscreen.cjs');
test('fullscreen captures once and restores bounds, maximization and menu after asynchronous exit',()=>{
 let full=false,menu=true,max=false,bounds={x:20,y:30,width:1000,height:700}; const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({...bounds}),setFullScreen:v=>{full=v;},setMenuBarVisibility:v=>menu=v,setBounds:v=>bounds=v,maximize:()=>max=true,unmaximize:()=>max=false,once:(e,f)=>listeners.set(e,f),removeListener:(e)=>listeners.delete(e)};
 const c=createFullscreenController(win);c('enter');c('enter');assert.equal(full,true);assert.equal(menu,false);bounds={x:0,y:0,width:1920,height:1080};c('restore');assert.equal(full,false);listeners.get('leave-full-screen')();assert.deepEqual(bounds,{x:20,y:30,width:1000,height:700});assert.equal(menu,true);assert.equal(max,false);
 assert.throws(()=>c('setBounds'));
});

test('manual exit during playback still restores original fullscreen on session end',()=>{
 let full=true,menu=true;const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>false,getNormalBounds:()=>({}),setFullScreen:v=>full=v,setMenuBarVisibility:v=>menu=v};
 const c=createFullscreenController(win);c('enter');c('exit');assert.equal(full,false);assert.equal(menu,false);c('restore');assert.equal(full,true);assert.equal(menu,true);
});

test('manual F11 toggle restores its own baseline and clears it for the next cycle',()=>{
 let full=false,menu=true,max=false,bounds={x:20,y:30,width:1000,height:700}; const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({...bounds}),setFullScreen:v=>{full=v;},setMenuBarVisibility:v=>menu=v,setBounds:v=>bounds=v,maximize:()=>max=true,unmaximize:()=>max=false,once:(e,f)=>listeners.set(e,f),removeListener:(e)=>listeners.delete(e)};
 const c=createFullscreenController(win);c('toggle');assert.equal(full,true);bounds={x:0,y:0,width:1920,height:1080};c('toggle');listeners.get('leave-full-screen')();assert.equal(full,false);assert.equal(menu,true);assert.deepEqual(bounds,{x:20,y:30,width:1000,height:700});
 bounds={x:70,y:80,width:1100,height:750};c('toggle');c('toggle');listeners.get('leave-full-screen')();assert.deepEqual(bounds,{x:70,y:80,width:1100,height:750});
});

test('manual dashboard fullscreen survives a stream session that never owned fullscreen',()=>{
 let full=false,menu=true,max=false,bounds={x:20,y:30,width:1000,height:700}; const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({...bounds}),setFullScreen:v=>{full=v;},setMenuBarVisibility:v=>menu=v,setBounds:v=>bounds=v,maximize:()=>max=true,unmaximize:()=>max=false,once:(e,f)=>listeners.set(e,f),removeListener:(e)=>listeners.delete(e)};
 const c=createFullscreenController(win);c('toggle');assert.equal(full,true);c('session-enter');c('session-restore');assert.equal(full,true);assert.equal(menu,false);
});

test('leaving an automatic session fullscreen manually cannot poison the next dashboard F11 cycle',()=>{
 let full=false,menu=true,max=false,bounds={x:20,y:30,width:1000,height:700}; const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({...bounds}),setFullScreen:v=>{full=v;},setMenuBarVisibility:v=>menu=v,setBounds:v=>bounds=v,maximize:()=>max=true,unmaximize:()=>max=false,once:(e,f)=>listeners.set(e,f),removeListener:(e)=>listeners.delete(e)};
 const c=createFullscreenController(win);c('session-enter');c('toggle');c('session-restore');assert.equal(full,false);c('toggle');assert.equal(full,true);c('toggle');listeners.get('leave-full-screen')();assert.equal(full,false);
});

test('session restore returns only an automatic fullscreen session to its normal window',()=>{
 let full=false,menu=true,max=false,bounds={x:20,y:30,width:1000,height:700}; const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({...bounds}),setFullScreen:v=>{full=v;},setMenuBarVisibility:v=>menu=v,setBounds:v=>bounds=v,maximize:()=>max=true,unmaximize:()=>max=false,once:(e,f)=>listeners.set(e,f),removeListener:(e)=>listeners.delete(e)};
 const c=createFullscreenController(win);c('session-enter');assert.equal(full,true);c('session-restore');listeners.get('leave-full-screen')();assert.equal(full,false);assert.equal(menu,true);
});
