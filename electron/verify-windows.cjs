const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
test('backend path selects a real Windows executable without changing Linux',()=>{
 const {backendPath}=require('./backend-path.cjs');
 assert.equal(backendPath({isPackaged:true,resourcesPath:'/app/resources',platform:'win32',dirname:'/dev/electron'}),path.join('/app/resources','bin','xjaus_backend.exe'));
 assert.equal(backendPath({isPackaged:true,resourcesPath:'/app/resources',platform:'linux',dirname:'/dev/electron'}),path.join('/app/resources','bin','xjaus_backend'));
 assert.equal(backendPath({isPackaged:false,platform:'linux',dirname:'/dev/electron'}),path.resolve('/dev/electron','../src-tauri/target/debug/xjaus_backend'));
});

test('Windows release declares NSIS and per-user MSI x64 installers with stable identity',()=>{
 const pkg=require('../package.json');
 const targets=pkg.build.win.target.map(({target,arch})=>({target,arch}));
 assert.deepEqual(targets,[{target:'nsis',arch:['x64']},{target:'msi',arch:['x64']}]);
 assert.equal(pkg.scripts['build:win'],'electron-builder --win --x64 --publish never');
 assert.equal(pkg.build.msi.oneClick,false);
 assert.equal(pkg.build.msi.perMachine,false);
 assert.match(pkg.build.msi.upgradeCode,/^\{[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}\}$/i);
 assert.equal(pkg.build.msi.artifactName,'XJAUS-${version}-win-x64-setup.${ext}');
});
