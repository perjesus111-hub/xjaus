const path = require('node:path');
function backendPath({isPackaged, resourcesPath, platform, dirname}) {
 const name = platform === 'win32' ? 'xjaus_backend.exe' : 'xjaus_backend';
 if (isPackaged) return path.join(resourcesPath, 'bin', name);
 return platform === 'win32'
   ? path.resolve(dirname, '../backend-windows/target/x86_64-pc-windows-gnu/release', name)
   : path.resolve(dirname, '../src-tauri/target/debug', name);
}
module.exports = {backendPath};
