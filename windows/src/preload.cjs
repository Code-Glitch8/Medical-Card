'use strict';
// Runs with context isolation + sandbox. Exposes three narrow capabilities and nothing else: a synchronous prompt()
// replacement (Electron removed window.prompt), the Edge-Function invoker, and window-state notifications.
// No filesystem, no shell, no generic IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mcDesktop', Object.freeze({
  prompt: (message, defaultValue) =>
    ipcRenderer.sendSync('mc:prompt', String(message).slice(0, 2000), String(defaultValue).slice(0, 500)),
  edge: (fn, body, apikey, timeoutMs) => ipcRenderer.invoke('mc:edge', String(fn), String(body), String(apikey), Number(timeoutMs) || 25000),
  onWindowState: (cb) => { if (typeof cb === 'function') ipcRenderer.on('mc:window-state', (_e, st) => cb({ maximized: !!(st && st.maximized), fullscreen: !!(st && st.fullscreen) })); },
}));
