const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chumiShell', {
  postMessage: (message) => ipcRenderer.send('chumi-shell', message),
});

window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.shell = 'windows'; });
