'use strict'
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { UsageStore } = require('./store')
const { writeModel } = require('./providers/settings')
const { detectVendors } = require('./providers/vendors')
const { CodexStore } = require('./providers/codex')

const NORMAL_SIZE = { width: 470, height: 396 }
const MINI_SIZE = { width: 232, height: 54 }
const SCREEN_MARGIN = 24

// Local transcripts are cheap to re-read incrementally, so the widget can feel
// live off them alone. The official endpoint schedules itself (see
// providers/official.js) and is only consulted when it says it is ready.
const LOCAL_TICK_MS = 20 * 1000

let win = null
let store = null
let mountedVendor = null
let ticker = null
let uiState = { mini: false, x: null, y: null, unlocked: false, vendor: null }

const userDataPath = () => app.getPath('userData')
const statePath = () => path.join(userDataPath(), 'state.json')
const uiStatePath = () => path.join(userDataPath(), 'ui.json')

function loadUiState () {
  try {
    uiState = { ...uiState, ...JSON.parse(fs.readFileSync(uiStatePath(), 'utf8')) }
  } catch { /* first run */ }
}

function saveUiState () {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true })
    fs.writeFileSync(uiStatePath(), JSON.stringify(uiState, null, 2))
  } catch { /* never fail over a cache write */ }
}

function defaultPosition (size) {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - size.width - SCREEN_MARGIN,
    y: workArea.y + workArea.height - size.height - SCREEN_MARGIN
  }
}

/** Keep the saved position usable after a monitor change or resolution swap. */
function clampToScreen (x, y, size) {
  const displays = screen.getAllDisplays()
  const fits = displays.some(d => {
    const a = d.workArea
    return x + size.width > a.x && x < a.x + a.width &&
           y + size.height > a.y && y < a.y + a.height
  })
  return fits ? { x, y } : defaultPosition(size)
}

function createWindow () {
  const size = uiState.mini ? MINI_SIZE : NORMAL_SIZE
  const pos = uiState.x === null
    ? defaultPosition(size)
    : clampToScreen(uiState.x, uiState.y, size)

  win = new BrowserWindow({
    ...size,
    ...pos,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Float above normal windows without stealing focus from the editor.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // Transparent frameless windows do not reliably emit 'ready-to-show' on
  // Windows — the app ends up running but permanently invisible. Reveal on
  // whichever signal lands first, with a timer as the final backstop.
  // showInactive keeps focus in the editor where it belongs.
  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive()
  }
  win.once('ready-to-show', reveal)
  win.webContents.once('did-finish-load', reveal)
  setTimeout(reveal, 2500)

  win.on('moved', () => {
    const [x, y] = win.getPosition()
    uiState.x = x
    uiState.y = y
    saveUiState()
  })

  // Nothing in this widget should ever navigate or spawn a window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', event => event.preventDefault())

  // Renderer errors are invisible from the terminal otherwise.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log('[renderer] ' + message + '  (' + source + ':' + line + ')')
  })
}

/**
 * Mount the store for a vendor. UsageStore reads Claude Code's JSONL
 * transcripts and polls Anthropic's usage endpoint; CodexStore reads Codex
 * rollouts, which already carry their own rate-limit block and so need no
 * polling at all.
 */
function makeStore (vendorId) {
  if (vendorId === 'openai') return new CodexStore()
  return new UsageStore({ statePath: statePath() })
}

function mountStore (vendorId) {
  if (store && mountedVendor === vendorId) return
  if (store && store.save) { try { store.save() } catch { /* ignore */ } }
  store = makeStore(vendorId)
  mountedVendor = vendorId
  store.refreshLocal()
}

function push () {
  if (!win || win.isDestroyed()) return
  const payload = store.read()
  win.webContents.send('usage:update', {
    ...payload,
    vendors: payload.vendors || detectVendors(),
    appVersion: app.getVersion(),
    unlocked: Boolean(uiState.unlocked),
    vendor: uiState.vendor
  })
}

async function tick () {
  store.refreshLocal()
  // The provider owns its own cadence and backoff; asking every tick is free
  // because it short-circuits on cooldown without touching the network.
  if (Date.now() >= store.official.nextPollAt()) {
    await store.pollOfficial()
  }
  push()
}

function startTicker () {
  if (ticker) clearInterval(ticker)
  ticker = setInterval(() => { tick().catch(() => {}) }, LOCAL_TICK_MS)
}

// ---------- IPC ----------

ipcMain.on('ui:ready', () => { tick().catch(() => {}) })

// Writing another program's config is a real mutation, so it answers with a
// result the UI can surface rather than failing silently.
ipcMain.handle('ui:model', (_event, value) => {
  const result = writeModel(value)
  if (result.ok) push()
  return result
})

// Unlocking only records which provider the dashboard is pointed at. There is
// no credential exchange here — a provider is "unlocked" when its CLI is
// already signed in on this machine, which vendors.js reads, nothing more.
ipcMain.handle('ui:unlock', (_event, vendorId) => {
  const vendor = detectVendors().find(v => v.id === vendorId)
  if (!vendor) return { ok: false, reason: 'unknown_vendor' }
  if (!vendor.usable) return { ok: false, reason: 'not_usable', vendor }
  uiState.unlocked = true
  uiState.vendor = vendor.id
  saveUiState()
  mountStore(vendor.id)
  push()
  return { ok: true, vendor }
})

ipcMain.on('ui:lock', () => {
  uiState.unlocked = false
  saveUiState()
  push()
})

// Hands off to the provider's real site in the user's own browser rather than
// rendering any sign-in form inside this app.
ipcMain.handle('ui:open-vendor', async (_event, vendorId) => {
  const vendor = detectVendors().find(v => v.id === vendorId)
  if (!vendor) return { ok: false, reason: 'unknown_vendor' }
  try {
    await shell.openExternal(vendor.url)
    return { ok: true, url: vendor.url }
  } catch {
    return { ok: false, reason: 'open_failed', url: vendor.url }
  }
})

ipcMain.on('ui:close', () => app.quit())

ipcMain.on('ui:mini', (_event, mini) => {
  if (!win || win.isDestroyed()) return
  uiState.mini = mini
  const size = mini ? MINI_SIZE : NORMAL_SIZE
  const [x, y] = win.getPosition()
  win.setBounds({ ...clampToScreen(x, y, size), ...size }, true)
  saveUiState()
})

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    loadUiState()
    // an unlocked session resumes on its own vendor; otherwise default to Claude
    mountStore(uiState.unlocked && uiState.vendor ? uiState.vendor : 'anthropic')
    createWindow()
    startTicker()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    if (ticker) clearInterval(ticker)
    if (store) store.save()
    saveUiState()
  })
}
