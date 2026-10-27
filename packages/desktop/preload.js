'use strict';

// The one thing the page needs from the desktop shell that a browser won't give it: where a
// dropped file lives. A page is handed a dropped file's name, size and bytes but never its path;
// Electron knows it, and this hands it over - and nothing else, since the page runs user code.

const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('poptartDesktop', {
  /** A dropped File's absolute path, or '' when it has none (a file from another app's memory). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
});
