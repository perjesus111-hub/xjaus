const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
test('backend path selects a real Windows executable without changing Linux',()=>{
 const {backendPath}=require('./backend-path.cjs');
 assert.equal(backendPath({isPackaged:true,resourcesPath:'/app/resources',platform:'win32',dirname:'/dev/electron'}),path.join('/app/resources','bin','xjaus_backend.exe'));
 assert.equal(backendPath({isPackaged:true,resourcesPath:'/app/resources',platform:'linux',dirname:'/dev/electron'}),path.join('/app/resources','bin','xjaus_backend'));
 assert.equal(backendPath({isPackaged:false,platform:'linux',dirname:'/dev/electron'}),path.resolve('/dev/electron','../src-tauri/target/debug/xjaus_backend'));
});
