'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mcDialog', Object.freeze({
  init: () => ipcRenderer.invoke('dialog:init'),
  done: (value) => ipcRenderer.send('dialog:done', value),
}));
