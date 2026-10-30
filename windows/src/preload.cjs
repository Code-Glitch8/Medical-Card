'use strict';
// Runs with context isolation + sandbox. Exposes ONE narrow capability to the page: a synchronous prompt()
// replacement (Electron removed window.prompt). No filesystem, no shell, no generic IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mcDesktop', Object.freeze({
  prompt: (message, defaultValue) =>
    ipcRenderer.sendSync('mc:prompt', String(message).slice(0, 2000), String(defaultValue).slice(0, 500)),
}));
