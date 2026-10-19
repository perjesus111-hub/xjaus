// Disposable Chromium fixture, never loads the app, account or sidecar.
// Run: xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/verify-slider-geometry.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const out=path.join(process.env.TMPDIR||path.join(require('node:os').homedir(),'.hermes/cache/scratch'),'xjaus-slider-fixture');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('ozone-platform','x11');
const wait=()=>new Promise(r=>setTimeout(r,100));
function goldXs(image,y0,y1){
 const {width,height}=image.getSize(),pixels=image.toBitmap(),xs=[];
 for(let y=y0;y<Math.min(height,y1);y++)for(let x=0;x<width;x++){
  const p=(y*width+x)*4;if(pixels[p]===55&&pixels[p+1]===175&&pixels[p+2]===212)xs.push(x);
 }
 assert(xs.length,'fixture must actually paint gold pixels');return xs;
}
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:500,height:220,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 try{
  const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
  const source=fs.readFileSync(path.join(root,'src/range-fill.ts'),'utf8');
  const ts=require(path.join(root,'node_modules/typescript'));const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const label=html.match(/<label class="setting" data-i18n="bitrate">[\s\S]*?<\/label>/)[0];
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html class="i18n-ready"><style>'+css+'\nbody{margin:0;padding:40px;background:#090b10}.setting{width:320px;display:block}</style>'+label));
  const results=[];
  for(const value of [15000,30000,45000]){
   const row=await win.webContents.executeJavaScript(`(()=>{const exports={};${compiled};const input=document.getElementById('stream-bitrate');input.value='${value}';exports.syncRangeFill(input);const r=input.getBoundingClientRect(),p=input.parentElement.getBoundingClientRect(),s=getComputedStyle(input);const f=(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min));return {value:input.value,min:input.min,max:input.max,left:r.left,right:r.right,top:r.top,width:r.width,height:r.height,parentLeft:p.left,parentRight:p.right,padding:s.padding,margin:s.margin,border:s.borderWidth,fill:s.getPropertyValue('--range-fill'),expectedCenter:r.left+9+(r.width-18)*f};})()`);
   assert.equal(row.value,String(value));assert.equal(row.min,'15000');assert.equal(row.max,'45000');assert.equal(row.padding,'0px');assert.equal(row.margin,'0px');assert.equal(row.border,'0px');assert(row.left>=row.parentLeft&&row.right<=row.parentRight);
   await wait();const image=await win.webContents.capturePage();assert(!image.isEmpty());fs.writeFileSync(path.join(out,value+'.png'),image.toPNG());
   const xs=goldXs(image,row.top,row.top+8);row.renderedThumbCenter=(Math.min(...xs)+Math.max(...xs)+1)/2;
   assert(Math.abs(row.renderedThumbCenter-row.expectedCenter)<=1);assert(Math.min(...xs)>=row.left&&Math.max(...xs)<row.right);
   // Isolate the track to measure the otherwise occluded fill endpoint.
   await win.webContents.executeJavaScript(`document.head.insertAdjacentHTML('beforeend','<style id="hide-thumb">#stream-bitrate::-webkit-slider-thumb{opacity:0}</style>')`);
   await wait();const track=await win.webContents.capturePage();fs.writeFileSync(path.join(out,value+'-track.png'),track.toPNG());
   const trackXs=goldXs(track,row.top+12,row.top+13);row.renderedFillEnd=Math.max(...trackXs)+1;
   assert(Math.abs(row.renderedFillEnd-row.renderedThumbCenter)<=1);assert(Math.min(...trackXs)>=row.left&&Math.max(...trackXs)<row.right);
   await win.webContents.executeJavaScript(`document.getElementById('hide-thumb').remove()`);results.push(row);
  }
  fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({fixture:true,results,out},null,2));
 }finally{win.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1);});
