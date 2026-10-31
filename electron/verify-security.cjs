const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frontend = path.resolve('/app/electron', '../dist/index.html');
const frontendUrl = pathToFileURL(frontend).href;
const { trustedFrame, externalLoginUrl, allowedCommand, allowedClipboardText } = require('./security.cjs');
const { systemLocaleFromEnvironment } = require('./locale.cjs');

test('system locale mapping preserves the configured regional preference and precedence', () => {
  assert.equal(systemLocaleFromEnvironment({ LC_ALL: '', LC_MESSAGES: 'es_ES.UTF-8', LANG: 'en_US.UTF-8' }), 'es-ES');
  assert.equal(systemLocaleFromEnvironment({ LC_ALL: 'en_GB.UTF-8', LC_MESSAGES: 'es_MX.UTF-8', LANG: 'es_MX.UTF-8' }), 'en-GB');
  assert.equal(systemLocaleFromEnvironment({ LC_ALL: 'C.UTF-8', LANG: 'es_MX.UTF-8' }), 'en-US');
  assert.equal(systemLocaleFromEnvironment({ LANG: 'fr_FR.UTF-8' }), 'fr-FR');
});

test('IPC rejects subframes, remote pages and arbitrary commands', () => {
  assert.equal(trustedFrame(frontendUrl, frontendUrl, frontend), true);
  assert.equal(trustedFrame('https://evil.invalid/', frontendUrl, frontend), false);
  assert.equal(trustedFrame(pathToFileURL(path.join(path.dirname(frontend), 'login.html')).href, frontendUrl, frontend), false);
  assert.equal(allowedCommand('auth_status'), true);
  assert.equal(allowedCommand('cancel_login'), true);
  assert.equal(allowedCommand('get_token'), false);
});
test('external link admits only exact donation/repository URLs in addition to device sign-in', () => {
  const { externalUrl } = require('./security.cjs');
  assert.equal(externalUrl('https://paypal.me/Comicoon'), true);
  assert.equal(externalUrl('https://github.com/perjesus111-hub/xjaus'), true);
  for(const value of ['https://github.com/perjesus111-hub/xjaus/','https://github.com/perjesus111-hub/xjaus?x=1','https://github.com/perjesus111-hub/other','http://github.com/perjesus111-hub/xjaus','https://github.com.evil.invalid/perjesus111-hub/xjaus','https://user@github.com/perjesus111-hub/xjaus','https://paypal.me/Comicoon/','https://paypal.me/comicoon','http://paypal.me/Comicoon','https://paypal.me:443/Comicoon','https://paypal.me/Comicoon?amount=1','https://paypal.me/Comicoon#x','https://paypal.me.evil.invalid/Comicoon','https://evil.invalid/?https://paypal.me/Comicoon','https://user@paypal.me/Comicoon',' https://paypal.me/Comicoon',null,{}]) assert.equal(externalUrl(value), false, String(value));
  assert.equal(externalUrl('https://microsoft.com/devicelogin'), true);
  assert.equal(externalLoginUrl('https://microsoft.com/devicelogin'), true);
  assert.equal(externalLoginUrl('https://www.microsoft.com/link'), true);
  for (const value of ['http://microsoft.com/devicelogin','https://microsoft.com.evil.invalid/devicelogin','https://user@microsoft.com/devicelogin','https://microsoft.com:443/devicelogin','https://microsoft.com/devicelogin?otc=fixture','https://microsoft.com/devicelogin#fragment','https://microsoft.com/other']) assert.equal(externalLoginUrl(value), false, value);
  assert.equal(allowedClipboardText('FIXTURE-CODE'), true);
  assert.equal(allowedClipboardText('https://microsoft.com/devicelogin'), true);
  assert.equal(allowedClipboardText('https://evil.invalid/'), false);
  assert.equal(allowedClipboardText('x'.repeat(513)), false);
});
test('support preload dispatch reaches only authorized external shell, never app navigation', async () => {
  const handlers=new Map(), opened=[], navigations=[];
  const url=frontendUrl;
  const wc={getURL:()=>url,setWindowOpenHandler:()=>{},on:()=>{}};
  const win={webContents:wc,loadFile:value=>navigations.push(value)};
  const backend={on:()=>{},stdout:{on:()=>{}},stderr:{on:()=>{}}};
  const app={getPath:()=>'/isolated-app-data',setPath:()=>{},setName:()=>{},setAppUserModelId:()=>{},setDesktopName:()=>{},getAppPath:()=>'/app',commandLine:{appendSwitch:()=>{}},whenReady:()=>({then:fn=>fn()}),on:()=>{}};
  runInNewContext(readFileSync(require.resolve('./main.cjs'),'utf8'),{
    process,require:name=>name==='electron'?{app,BrowserWindow:function(){return win;},shell:{openExternal:async value=>opened.push(value)},ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},session:{defaultSession:{setPermissionRequestHandler:()=>{}}}}:name==='node:child_process'?{spawn:()=>backend}:require(name),__dirname:'/app/electron'});
  const frame={url};frame.top=frame;const event={sender:wc,senderFrame:frame};
  let bridge;
  runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},ipcRenderer:{invoke:(channel,...args)=>handlers.get(channel)(event,...args)}})});
  const baseline=[...navigations];
  await bridge.openExternal('https://paypal.me/Comicoon');
  assert.deepEqual(opened,['https://paypal.me/Comicoon']);
  for(const value of ['https://paypal.me/Comicoon/','https://paypal.me/Comicoon?amount=1','https://evil.invalid/'])await assert.rejects(bridge.openExternal(value));
  const handler=handlers.get('xjaus:open-external');
  for(const invalid of [{...event,sender:{}},{...event,senderFrame:{url,top:frame}},{...event,senderFrame:undefined}])await assert.rejects(handler(invalid,'https://paypal.me/Comicoon'));
  assert.deepEqual(opened,['https://paypal.me/Comicoon']);assert.deepEqual(navigations,baseline);
});
test('external link is restricted to device sign-in', () => {
  assert.equal(externalLoginUrl('https://microsoft.com/devicelogin'), true);
  assert.equal(externalLoginUrl('https://evil.invalid/'), false);
});
test('verification and clipboard bridges validate at preload and Electron main', async () => {
  const handlers = new Map(); const opened = []; const copied = []; const logs = []; let stderrData;
  const url = frontendUrl;
  const wc = { getURL: () => url, setWindowOpenHandler: () => {}, on: () => {} };
  const win = { webContents: wc, loadFile: () => {} };
  const backend = { on: () => {}, stdout: { on: () => {} }, stderr: { on: (_event, listener) => stderrData = listener }, exitCode: null, stdin: { writable: true, write: () => {} } };
  const app = { getPath: () => '/isolated-app-data', setPath: () => {}, setName: () => {}, setAppUserModelId: () => {}, setDesktopName: () => {}, getAppPath: () => '/app', commandLine: { appendSwitch: () => {} }, whenReady: () => ({ then: fn => fn() }), on: () => {} };
  runInNewContext(readFileSync(require.resolve('./main.cjs'),'utf8'), {
    process,
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    require: name => name === 'electron'
      ? { app, BrowserWindow: function(){ return win; }, shell: { openExternal: async value => opened.push(value) }, clipboard: { writeText: value => copied.push(value) }, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, session: { defaultSession: { setPermissionRequestHandler: () => {} } } }
      : name === 'node:child_process' ? { spawn: () => backend } : require(name),
    __dirname: '/app/electron',
  });
  const frame = { url }; frame.top = frame;
  const event = { sender: wc, senderFrame: frame };
  let bridge;
  runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => bridge = value }, ipcRenderer: { invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)(event, ...args)) } }),
  });
  await bridge.openMicrosoftVerification('https://microsoft.com/devicelogin');
  await assert.rejects(bridge.openMicrosoftVerification('https://microsoft.com/devicelogin?code=fixture'));
  await bridge.copyText('FIXTURE-CODE');
  await assert.rejects(bridge.copyText('https://evil.invalid/'));
  assert.deepEqual(opened, ['https://microsoft.com/devicelogin']);
  assert.deepEqual(copied, ['FIXTURE-CODE']);
  stderrData(Buffer.from('[XJAUS_AUTH] device_code_response_received status=200 duration_ms=12' + String.fromCharCode(10) + '[XJAUS_AUTH] device_code_request_failed category=oauth user_code=PRIVATE-FIXTURE-CODE' + String.fromCharCode(10)));
  assert.ok(logs.some(entry => entry[0] === '[XJAUS_AUTH] device_code_response_received status=200 duration_ms=12'));
  assert.ok(!logs.some(entry => JSON.stringify(entry).includes('PRIVATE-FIXTURE-CODE')));
});
test('autoplay switch is applied before ready without overriding feature switches', () => {
  const calls=[];
  const source=readFileSync(require.resolve('./main.cjs'),'utf8');
  const app={getPath:()=>'/isolated-app-data',setPath:()=>{},setName:()=>{},setAppUserModelId:()=>{},setDesktopName:()=>{},getAppPath:()=>'/app',commandLine:{appendSwitch:(...args)=>calls.push(args)},whenReady:()=>{calls.push(['ready']);return {then:()=>{}}},on:()=>{}};
  const testProcess = { ...process, env: { ...process.env, LC_ALL: '', LC_MESSAGES: '', LANG: 'es_ES.UTF-8' } };
  runInNewContext(source,{process:testProcess,require:(name)=>name==='electron'?{app,ipcMain:{handle:()=>{}}}:require(name),__dirname});
  assert.deepEqual(calls[0],['lang','es-ES']);
  assert.ok(calls.findIndex(c=>c[0]==='autoplay-policy') < calls.findIndex(c=>c[0]==='ready'));
  if(process.platform==='linux') assert.deepEqual(calls.find(c=>c[0]==='enable-features'),['enable-features','VaapiVideoDecoder,VaapiIgnoreDriverChecks']);
});
test('only an authorized start_stream focuses the player window and renderer', () => {
  const handlers = new Map(); let focused=0; let rendererFocused=0; let shown=0; let quits=0;
  const url=frontendUrl;
  const wc={getURL:()=>url,focus:()=>rendererFocused++,setWindowOpenHandler:()=>{},on:()=>{}};
  const win={webContents:wc,show:()=>shown++,focus:()=>focused++,loadFile:()=>{}};
  const backend={on:()=>{},stdout:{on:()=>{}},stderr:{on:()=>{}},exitCode:null,stdin:{writable:true,write:()=>{}}};
  const app={getPath:()=>'/isolated-app-data',setPath:()=>{},setName:()=>{},setAppUserModelId:()=>{},setDesktopName:()=>{},getAppPath:()=>'/app',commandLine:{appendSwitch:()=>{}},whenReady:()=>({then:fn=>fn()}),on:()=>{},quit:()=>quits++};
  runInNewContext(readFileSync(require.resolve('./main.cjs'),'utf8'),{
    process,require:name=>name==='electron'?{app,BrowserWindow:function(){return win;},ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},session:{defaultSession:{setPermissionRequestHandler:()=>{}}}}:name==='node:child_process'?{spawn:()=>backend}:name==='./security.cjs'?{allowedCommand,externalLoginUrl,trustedFrame:(frame)=>frame===url}:require(name),__dirname:'/app/electron'});
  const frame={url};frame.top=frame;
  const event={sender:wc,senderFrame:frame};
  assert.throws(()=>handlers.get('xjaus:invoke')({...event,sender:{}},'start_stream',{}));
  assert.equal(focused,0);
  handlers.get('xjaus:invoke')(event,'auth_status',{}); assert.equal(focused,0);
  handlers.get('xjaus:invoke')(event,'start_stream',{});
  assert.equal(focused,1);assert.equal(rendererFocused,1);assert.equal(shown,1);
  assert.throws(()=>handlers.get('xjaus:invoke')({...event,sender:{}},'app_exit',{}));
  assert.throws(()=>handlers.get('xjaus:invoke')(event,'app_exit',{force:true}));
  assert.equal(quits,0);handlers.get('xjaus:invoke')(event,'app_exit',{});assert.equal(quits,1);
});

test('profile IPC traverses both whitelists and CSP allows gamerpic host', async () => {
  assert.equal(allowedCommand('xbox_profile'), true);
  let bridge; const calls=[];
  runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve();}}})});
  await bridge.invoke('xbox_profile');
  assert.equal(calls[0][1], 'xbox_profile');
  assert.match(readFileSync(require.resolve('../index.html'),'utf8'), /img-src[^;]*https:\/\/images-eds\.xboxlive\.com/);
});
require('./verify-fullscreen.cjs');
require('./verify-window-drag.cjs');
test('settings IPC traverses both allowlists, rejecting arbitrary filesystem operations', async () => {
  let bridge;const calls=[];
  runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve();}}})});
  for(const command of ['load_settings','save_settings']) {
    assert.equal(allowedCommand(command),true);await bridge.invoke(command,{});
  }
  assert.equal(calls.length,2);
  await assert.rejects(bridge.invoke('write_file',{path:'/anywhere'}));assert.equal(allowedCommand('write_file'),false);
});

test('fullscreen IPC rejects foreign senders, subframes, remote documents and invalid actions', () => {
  const handlers=new Map();let mutations=0;const url=frontendUrl;
  const wc={getURL:()=>url,setWindowOpenHandler:()=>{},on:()=>{}};
  const win={webContents:wc,loadFile:()=>{},isDestroyed:()=>false,isFullScreen:()=>false,
    getNormalBounds:()=>({x:10,y:20,width:900,height:600}),isMaximized:()=>false,isMenuBarVisible:()=>true,
    setMenuBarVisibility:()=>mutations++,setFullScreen:()=>mutations++};
  const backend={on:()=>{},stdout:{on:()=>{}},stderr:{on:()=>{}}};
  const app={getPath:()=>'/isolated-app-data',setPath:()=>{},setName:()=>{},setAppUserModelId:()=>{},setDesktopName:()=>{},getAppPath:()=>'/app',commandLine:{appendSwitch:()=>{}},whenReady:()=>({then:fn=>fn()}),on:()=>{}};
  runInNewContext(readFileSync(require.resolve('./main.cjs'),'utf8'),{
    process,require:name=>name==='electron'?{app,BrowserWindow:function(){return win;},ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},session:{defaultSession:{setPermissionRequestHandler:()=>{}}}}:name==='node:child_process'?{spawn:()=>backend}:require(name),__dirname:'/app/electron'});
  const frame={url};frame.top=frame;const event={sender:wc,senderFrame:frame};const handler=handlers.get('xjaus:fullscreen');
  for(const invalid of [{...event,sender:{}},{...event,senderFrame:{url,top:frame}},{...event,senderFrame:undefined}]) assert.throws(()=>handler(invalid,'enter'));
  const remote={url:'https://evil.invalid/'};remote.top=remote;
  assert.throws(()=>handler({...event,senderFrame:remote},'enter'));
  for(const action of ['setBounds',{},null,true]) assert.throws(()=>handler(event,action));
  assert.equal(mutations,0);handler(event,'enter');assert.equal(mutations,2);
});

test('preload exposes only validated fullscreen actions and no generic IPC transport', async()=>{
 let bridge;const calls=[];
 runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve();}}})});
 await assert.rejects(bridge.fullscreen('setBounds'));assert.equal(calls.length,0);
 await bridge.fullscreen('enter');assert.deepEqual(calls,[['xjaus:fullscreen','enter']]);
 assert.deepEqual(Object.keys(bridge).sort(),['copyText','fullscreen','invoke','openExternal','openMicrosoftVerification']);
});

test('authorized quit command is in both allowlists but arbitrary commands remain denied', async()=>{
 assert.equal(allowedCommand('app_exit'),true);
 let bridge;const calls=[];
 runInNewContext(readFileSync(require.resolve('./preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_n,b)=>bridge=b},ipcRenderer:{invoke:(...a)=>{calls.push(a);return Promise.resolve();}}})});
 await bridge.invoke('app_exit');assert.deepEqual(calls,[['xjaus:invoke','app_exit',undefined]]);
});
test('Linux decoder features merge existing values exactly once without deleting others',()=>{
 const {mergeDecoderFeatures}=require('./features.cjs');
 assert.equal(mergeDecoderFeatures('Existing,VaapiVideoDecoder'), 'Existing,VaapiVideoDecoder,VaapiIgnoreDriverChecks');
});
