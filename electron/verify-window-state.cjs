const {test}=require('node:test');
const assert=require('node:assert/strict');
const {restoreWindowState,persistWindowState}=require('./window-state.cjs');

test('restores a persisted normal window only when it intersects a current display work area',()=>{
 const displays=[{workArea:{x:0,y:0,width:1920,height:1080}}];
 assert.deepEqual(restoreWindowState({bounds:{x:120,y:80,width:1500,height:900},maximized:false},displays,{width:1240,height:800}),{x:120,y:80,width:1500,height:900});
 assert.deepEqual(restoreWindowState({bounds:{x:9000,y:80,width:1500,height:900},maximized:false},displays,{width:1240,height:800}),{width:1240,height:800});
 assert.deepEqual(restoreWindowState({bounds:{x:120,y:80,width:200,height:100},maximized:false},displays,{width:1240,height:800}),{x:120,y:80,width:860,height:600});
 assert.deepEqual(restoreWindowState({bounds:{x:1880,y:1040,width:9000,height:9000},maximized:false},displays,{width:1240,height:800}),{x:0,y:0,width:1920,height:1080});
});

test('persists normal bounds and maximized state but never fullscreen state',()=>{
 let saved;
 const store={set:(key,value)=>{saved=[key,value];}};
 const win={isDestroyed:()=>false,isFullScreen:()=>true,isMaximized:()=>true,getNormalBounds:()=>({x:10,y:20,width:1600,height:900})};
 persistWindowState(store,win);
 assert.deepEqual(saved,['windowState',{bounds:{x:10,y:20,width:1600,height:900},maximized:true}]);
});
