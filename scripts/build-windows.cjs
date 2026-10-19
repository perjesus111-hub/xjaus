const {spawnSync}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const result=spawnSync('cargo',['build','--locked','--manifest-path','backend-windows/Cargo.toml','--bin','xjaus_backend','--target','x86_64-pc-windows-gnu','--release','-j','8'],{cwd:root,stdio:'inherit',env:{...process.env,CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER:process.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER||'x86_64-w64-mingw32-gcc'}});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
const source=path.join(root,'backend-windows/target/x86_64-pc-windows-gnu/release/xjaus_backend.exe');
const bytes=fs.readFileSync(source);const pe=bytes.readUInt32LE(0x3c);
if(bytes.toString('ascii',0,2)!=='MZ'||bytes.toString('ascii',pe,pe+4)!=='PE\0\0'||bytes.readUInt16LE(pe+4)!==0x8664)throw Error('Backend is not a Windows x64 PE');
const dest=path.join(root,'build/windows/bin');fs.mkdirSync(dest,{recursive:true});
fs.copyFileSync(source,path.join(dest,'xjaus_backend.exe'));
// GNU runtime DLLs, when required, are explicit resources; never copy a host directory.
const knownRuntime=['libgcc_s_seh-1.dll','libwinpthread-1.dll','libstdc++-6.dll'];
const imports=spawnSync('x86_64-w64-mingw32-objdump',['-p',source],{encoding:'utf8',maxBuffer:64*1024*1024});
if(imports.status!==0)throw Error('Cannot audit Windows backend imports');
const dlls=[...imports.stdout.matchAll(/DLL Name:\s*(\S+)/g)].map(m=>m[1]);
for(const dll of knownRuntime){const dst=path.join(dest,dll);if(fs.existsSync(dst))fs.unlinkSync(dst);if(!dlls.some(d=>d.toLowerCase()===dll))continue;
 const locate=spawnSync('x86_64-w64-mingw32-gcc',[`-print-file-name=${dll}`],{encoding:'utf8'});let src=locate.stdout.trim();
 if(!path.isAbsolute(src)||!fs.existsSync(src))src=path.join('/usr/x86_64-w64-mingw32/sys-root/mingw/bin',dll);
 if(!fs.existsSync(src))throw Error(`Missing required Windows runtime ${dll}`);fs.copyFileSync(src,dst);
}
console.log('Windows backend PE x64; imports:',dlls.join(', '));
fs.writeFileSync(path.join(root,'build/windows/backend-imports.json'),JSON.stringify({architecture:'x64',imports:dlls},null,2));
