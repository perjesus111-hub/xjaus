const path = require('node:path');
// getAppPath points inside app.asar when packaged; keep resources in the app.
function iconPath(app) {
  return path.resolve(app.getAppPath(), 'resources', 'icons', '512x512.png');
}
module.exports = { iconPath };
