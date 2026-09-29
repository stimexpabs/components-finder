const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  search: (query, page) => ipcRenderer.invoke('search', { query, page }),
  addExtracted: (items) => ipcRenderer.invoke('add-extracted', items),
  searchStore: (store, query) => ipcRenderer.invoke('search-store', store, query),
  captchaDone: (solved) => ipcRenderer.invoke('captcha:done', solved),
  onSearchEvent: (cb) => ipcRenderer.on('search:event', (_e, ev) => cb(ev)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  cart: {
    get: () => ipcRenderer.invoke('cart:get'),
    add: (listing) => ipcRenderer.invoke('cart:add', listing),
    remove: (id) => ipcRenderer.invoke('cart:remove', id),
    setQty: (id, qty) => ipcRenderer.invoke('cart:qty', id, qty),
    check: (id) => ipcRenderer.invoke('cart:check', id),
    onChange: (cb) => ipcRenderer.on('cart:changed', (_e, c) => cb(c)),
    onFocus: (cb) => ipcRenderer.on('cart:focus', (_e, id) => cb(id)),
  },
  exportCsv: (csv) => ipcRenderer.invoke('export-csv', csv),
});
