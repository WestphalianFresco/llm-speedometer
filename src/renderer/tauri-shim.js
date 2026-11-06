// Under Tauri this stands in for Electron's preload: the same `window.meter`
// surface, over invoke/listen. Under Electron the contextBridge has already
// defined `window.meter`, and this file does nothing.
;(function () {
  if (window.meter || !window.__TAURI__) return
  const { invoke } = window.__TAURI__.core
  const { listen } = window.__TAURI__.event
  const { getCurrentWindow } = window.__TAURI__.window
  const call = (cmd, args) => invoke(cmd, args).catch(e => ({ ok: false, reason: String(e) }))
  // A webview has no terminal: page errors go to the process log instead.
  const report = text => invoke('ui_log', { text: String(text) }).catch(() => {})
  window.addEventListener('error', e => report('error: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno))
  window.addEventListener('unhandledrejection', e => report('rejection: ' + (e.reason && e.reason.message || e.reason)))

  window.meter = {
    onUpdate: handler => {
      listen('usage:update', event => {
        // Electron faded the whole window; a webview fades its page instead.
        const opacity = event.payload && event.payload.settings && event.payload.settings.opacity
        document.documentElement.style.opacity = typeof opacity === 'number' ? String(opacity) : ''
        handler(event.payload)
      })
    },
    ready: () => invoke('ready'),
    close: () => invoke('close'),
    minimize: () => invoke('minimize'),
    refresh: () => invoke('refresh'),
    setMini: mini => invoke('set_mini', { mini: Boolean(mini) }),
    setModel: value => call('set_model', { value: String(value) }),
    unlock: vendorId => call('unlock', { vendorId: String(vendorId) }),
    lock: () => invoke('lock'),
    openVendor: vendorId => call('open_vendor', { vendorId: String(vendorId) }),
    setSetting: (key, value) => call('set_setting', { key: String(key), value }),
    resetSettings: () => call('reset_settings'),
    installStreamDeck: () => call('install_streamdeck'),
    setGear: (providerId, gear) => call('set_gear', { providerId: String(providerId), gear })
  }

  // `-webkit-app-region: drag` is Electron's; a webview ignores it. The card
  // drags the window, and the controls inside it that opt out in the CSS opt
  // out here by the same class names.
  const NO_DRAG = '.fob, .lock-open, .acct, .chip-model, button, input, select, a, textarea'
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || !event.target.closest('.card')) return
    if (event.target.closest(NO_DRAG)) return
    getCurrentWindow().startDragging().catch(() => {})
  })
})()
