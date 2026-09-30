'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The renderer gets a narrow, explicit surface — no node, no ipcRenderer,
// no filesystem. Everything it can do is listed here.
contextBridge.exposeInMainWorld('meter', {
  onUpdate: handler => {
    ipcRenderer.on('usage:update', (_event, payload) => handler(payload))
  },
  ready: () => ipcRenderer.send('ui:ready'),
  close: () => ipcRenderer.send('ui:close'),
  minimize: () => ipcRenderer.send('ui:minimize'),
  refresh: () => ipcRenderer.send('ui:refresh'),
  setMini: mini => ipcRenderer.send('ui:mini', Boolean(mini)),
  setModel: value => ipcRenderer.invoke('ui:model', String(value)),
  unlock: vendorId => ipcRenderer.invoke('ui:unlock', String(vendorId)),
  lock: () => ipcRenderer.send('ui:lock'),
  openVendor: vendorId => ipcRenderer.invoke('ui:open-vendor', String(vendorId)),
  setSetting: (key, value) => ipcRenderer.invoke('ui:setting', String(key), value),
  resetSettings: () => ipcRenderer.invoke('ui:settings-reset'),
  installStreamDeck: () => ipcRenderer.invoke('ui:streamdeck-install'),
  // gear is a number or the string 'R'; main resolves both against the catalogue
  setGear: (providerId, gear) => ipcRenderer.invoke('ui:gear', String(providerId), gear)
})
