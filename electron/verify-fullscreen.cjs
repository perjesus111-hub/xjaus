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

test('restores maximized baseline without overwriting normal geometry',()=>{
 let full=false,max=true,menu=false,restores=0;const listeners=new Map();
 const win={isDestroyed:()=>false,isFullScreen:()=>full,isMenuBarVisible:()=>menu,isMaximized:()=>max,getNormalBounds:()=>({x:10,y:20,width:900,height:600}),setFullScreen:v=>full=v,setMenuBarVisibility:v=>menu=v,maximize:()=>{max=true;restores++;},once:(e,f)=>listeners.set(e,f),removeListener:e=>listeners.delete(e)};
 const c=createFullscreenController(win);c('enter');max=false;c('restore');listeners.get('leave-full-screen')();assert.equal(max,true);assert.equal(restores,1);assert.equal(menu,false);c('restore');assert.equal(restores,1);
});
