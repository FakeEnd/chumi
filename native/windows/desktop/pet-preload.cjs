const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chumiPetNative', {
  postMessage: (message) => ipcRenderer.send('chumi-pet', message),
  onEvent: (callback) => ipcRenderer.on('chumi-pet-event', (_event, message) => callback(message)),
});
