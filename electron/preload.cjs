const { contextBridge, ipcRenderer } = require('electron');

/* The renderer sees exactly this and nothing else — no ipcRenderer, no Node. */
contextBridge.exposeInMainWorld('midori', {
  data: {
    datasets: () => ipcRenderer.invoke('data:datasets'),
    meta: (symbol) => ipcRenderer.invoke('data:meta', symbol),
    symbols: () => ipcRenderer.invoke('data:symbols'),
    bars: (query) => ipcRenderer.invoke('data:bars', query),
    volumeProfile: (query) => ipcRenderer.invoke('data:volume-profile', query),
    download: (query) => ipcRenderer.invoke('data:download', query),

    /** Returns an unsubscribe function — callers must call it on unmount. */
    onDownloadProgress: (fn) => {
      const listener = (_e, payload) => fn(payload);
      ipcRenderer.on('data:download-progress', listener);
      return () => ipcRenderer.off('data:download-progress', listener);
    },
  },

  drawings: {
    load: (symbol) => ipcRenderer.invoke('drawings:load', symbol),
    save: (symbol, drawings) => ipcRenderer.invoke('drawings:save', { symbol, drawings }),
  },
});
