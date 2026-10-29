const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chumiShell', {
  postMessage: (message) => ipcRenderer.send('chumi-shell', message),
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.shell = 'windows';
  const languageChanged = () => {
    const lang = document.documentElement.lang;
    if (lang) ipcRenderer.send('chumi-shell', { type: 'language', language: lang.toLowerCase().startsWith('zh') ? 'zh' : 'en' });
  };
  new MutationObserver(languageChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  languageChanged();
});
