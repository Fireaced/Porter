'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('porter', {
  getLibrary: call('library:get'),
  addFolder: call('folder:add'),
  addFolderPath: call('folder:addPath'),
  removeFolder: call('folder:remove'),
  rescan: call('library:rescan'),
  openBook: call('book:open'),
  setPages: call('book:pages'),
  setProgress: call('progress:set'),
  resetProgress: call('progress:reset'),
  removeHistory: call('history:remove'),
  clearHistory: call('history:clear'),
  hasCover: call('cover:has'),
  saveCover: call('cover:save'),
  setSettings: call('settings:set'),
  reveal: call('book:reveal'),
  fullscreen: call('win:fullscreen'),
  reportInfo: call('report:info'),
  sendReport: call('report:send'),
  reportAvailable: call('report:available'),
  logError: (msg) => ipcRenderer.send('log:error', String(msg)),
  syncDevices: call('sync:devices'),
  openPairing: call('sync:openPairing'),
  closePairing: call('sync:closePairing'),
  answerPairing: call('sync:answer'),
  removeDevice: call('sync:remove'),
  sendToPhone: call('sync:send'),
  onPairRequest: (fn) => ipcRenderer.on('sync:pair-request', (_e, d) => fn(d)),
  onPaired: (fn) => ipcRenderer.on('sync:paired', (_e, d) => fn(d)),
  platform: 'desktop',
  pathForFile: (f) => webUtils.getPathForFile(f),
  onLibrary: (fn) => ipcRenderer.on('library:changed', (_e, d) => fn(d)),
  onFullscreen: (fn) => ipcRenderer.on('fullscreen', (_e, v) => fn(v)),
});
