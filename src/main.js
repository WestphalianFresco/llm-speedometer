'use strict'
const { app, BrowserWindow, ipcMain, screen, shell, nativeTheme } = require('electron')
const fs = require('fs')
const path = require('path')
const { UsageStore } = require('./store')
const { writeModel } = require('./providers/settings')
const { detectVendors } = require('./providers/vendors')
const { PROVIDERS, findGear, findProvider } = require('./providers/catalog')
const { CodexStore } = require('./providers/codex')

const NORMAL_SIZE = { width: 470, height: 396 }
// widened when the collapsed pill started carrying the live rate as well as
// the tank percentage; at 232 the two readouts wrapped and broke the pill
const MINI_SIZE = { width: 278, height: 54 }
const SCREEN_MARGIN = 24

// Local transcripts are cheap to re-read incrementally, so the widget can feel
// live off them alone. The official endpoint schedules itself (see
// providers/official.js) and is only consulted when it says it is ready.
const LOCAL_TICK_MS = 20 * 1000

let win = null
let store = null
let mountedVendor = null
let ticker = null
/**
 * Preferences the settings panel owns. They live in the same ui.json as the
 * window state because they are the same kind of thing: how this widget is set
 * up on this machine, not usage data.
 *
 * `theme` is handed to nativeTheme rather than to the stylesheet — the CSS is
 * already written against prefers-color-scheme, and themeSource drives exactly
 * that, so an explicit choice needs no second styling path.
 */
const DEFAULT_SETTINGS = {
  theme: 'system',        // system | light | dark
  opacity: 1,             // 0.55 .. 1
  alwaysOnTop: true,
  openAtLogin: false,
  sound: true,
  volume: 0.8,            // 0 .. 1
  showSessions: true,
  // the gearbox explains itself once, then stops
  gearboxHintSeen: false
}

// What the shifter is currently in, and what it was in before — Reverse drops
// back to `previous`, which is the only thing that field is for.
const DEFAULT_GEARBOX = { providerId: 'anthropic', gear: null, previous: null }

let uiState = {
  mini: false, x: null, y: null, unlocked: false, vendor: null,
  settings: { ...DEFAULT_SETTINGS },
  gearbox: { ...DEFAULT_GEARBOX }
}

const userDataPath = () => app.getPath('userData')
const statePath = () => path.join(userDataPath(), 'state.json')
const uiStatePath = () => path.join(userDataPath(), 'ui.json')

function loadUiState () {
  try {
    uiState = { ...uiState, ...JSON.parse(fs.readFileSync(uiStatePath(), 'utf8')) }
  } catch { /* first run */ }
  // A settings block saved by an older build is missing whatever has been
  // added since, so fill the gaps rather than trusting the file's shape.
  uiState.settings = { ...DEFAULT_SETTINGS, ...(uiState.settings || {}) }
  uiState.gearbox = coerceGearbox(uiState.gearbox)

  // Every launch opens on the landing screen. The remembered vendor is kept,
  // so getting in is one press of the fob rather than a fresh choice — but the
  // key ceremony is the app's front door and is not skipped.
  uiState.unlocked = false
  // ...which also means opening expanded: the landing screen is a full card,
  // and the collapsed pill has no room to draw it.
  uiState.mini = false
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * ui.json is ours, but it is a file on disk that anything running as this user
 * could have edited. Every field is re-checked against the catalogue on the way
 * in, so a hand-edited or corrupted file cannot put the shifter into a gear
 * that does not exist.
 */
function coerceGearbox (saved) {
  const raw = saved && typeof saved === 'object' ? saved : {}
  const known = findGear(String(raw.providerId), Number(raw.gear))
  const previous = raw.previous && typeof raw.previous === 'object'
    ? findGear(String(raw.previous.providerId), Number(raw.previous.gear))
    : null
  return {
    providerId: known ? known.provider.id : (findProvider(String(raw.providerId))
      ? String(raw.providerId)
      : DEFAULT_GEARBOX.providerId),
    gear: known ? known.gear.gear : null,
    previous: previous
      ? { providerId: previous.provider.id, gear: previous.gear.gear }
      : null
  }
}

/** Coerce one incoming setting, so a bad value from anywhere cannot stick. */
function coerceSetting (key, value) {
  switch (key) {
    case 'theme':
      return ['system', 'light', 'dark'].includes(value) ? value : 'system'
    // Number.isFinite rather than a truthiness test: 0 is a legitimate volume
    // and a falsy opacity should clamp to the floor, not silently become 1.
    case 'opacity':
      return Number.isFinite(Number(value)) ? clamp(Number(value), 0.55, 1) : 1
    case 'volume':
      return Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : 0
    case 'alwaysOnTop':
    case 'openAtLogin':
    case 'sound':
    case 'showSessions':
    case 'gearboxHintSeen':
      return Boolean(value)
    default:
      return undefined
  }
}

/**
 * Push every setting out to the thing that actually enforces it. Called on
 * startup and after each change, so there is one path rather than one rule at
 * write time and a different one at boot.
 */
function applySettings () {
  const s = uiState.settings
  nativeTheme.themeSource = s.theme

  if (win && !win.isDestroyed()) {
    win.setOpacity(s.opacity)
    win.setAlwaysOnTop(s.alwaysOnTop, 'floating')
  }

  // Login items are not available in a dev checkout run through electron, and
  // asking anyway throws on some Windows configurations.
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: s.openAtLogin, path: process.execPath })
    } catch { /* not fatal — the preference is still recorded */ }
  }
}

function saveUiState () {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true })
    fs.writeFileSync(uiStatePath(), JSON.stringify(uiState, null, 2))
  } catch { /* never fail over a cache write */ }
}

/**
 * The only path from this app to the operating system's URL handler.
 *
 * shell.openExternal hands a string to the OS to dispatch, and the OS will
 * happily act on schemes that are not web pages at all — file:, and on Windows
 * anything with a registered protocol handler. Nothing here should ever open
 * more than a web page, so the scheme is checked against a list rather than
 * assumed from where the string came from.
 */
const OPENABLE_PROTOCOLS = new Set(['https:', 'http:'])

async function openExternal (candidate) {
  let url
  try {
    url = new URL(String(candidate))
  } catch {
    return { ok: false, reason: 'bad_url' }
  }
  if (!OPENABLE_PROTOCOLS.has(url.protocol)) return { ok: false, reason: 'blocked_scheme' }
  try {
    await shell.openExternal(url.href)
    return { ok: true, url: url.href }
  } catch {
    return { ok: false, reason: 'open_failed', url: url.href }
  }
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
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      // Stated rather than left to the defaults: these are the switches an
      // audit looks for, and a default that changes upstream should not be
      // able to quietly widen what this window can do.
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  })

  // Float above normal windows without stealing focus from the editor.
  win.setAlwaysOnTop(uiState.settings.alwaysOnTop, 'floating')
  win.setOpacity(uiState.settings.opacity)
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
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', event => event.preventDefault())
  // The renderer is one local file with no frames; anything trying to attach
  // one is not this app behaving normally.
  win.webContents.on('will-attach-webview', event => event.preventDefault())

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
    vendor: uiState.vendor,
    mini: Boolean(uiState.mini),
    settings: { ...uiState.settings },
    gearbox: { ...uiState.gearbox },
    // The catalogue travels with the payload so the renderer draws gears from
    // the same list main validates against — it never invents a model value.
    catalog: PROVIDERS,
    // the panel reports what the OS is actually doing under 'system'
    darkMode: nativeTheme.shouldUseDarkColors,
    canOpenAtLogin: app.isPackaged
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

/**
 * Every channel below mutates something real — another program's config, the
 * window, the saved preferences — so each one first checks that the message
 * came from this app's own renderer rather than from whatever else happens to
 * be able to reach the main process. There is exactly one legitimate sender.
 */
const fromRenderer = event =>
  Boolean(win) && !win.isDestroyed() && event.sender === win.webContents

const onUi = (channel, handler) => ipcMain.on(channel, (event, ...args) => {
  if (!fromRenderer(event)) return
  handler(...args)
})

const handleUi = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
  if (!fromRenderer(event)) return { ok: false, reason: 'unknown_sender' }
  return handler(...args)
})

onUi('ui:ready', () => { tick().catch(() => {}) })

// Writing another program's config is a real mutation, so it answers with a
// result the UI can surface rather than failing silently.
handleUi('ui:model', value => {
  const result = writeModel(value)
  if (result.ok) push()
  return result
})

// Unlocking only records which provider the dashboard is pointed at. There is
// no credential exchange here — a provider is "unlocked" when its CLI is
// already signed in on this machine, which vendors.js reads, nothing more.
handleUi('ui:unlock', vendorId => {
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

// One setting at a time, answered with the whole block so the renderer never
// has to guess what was accepted.
handleUi('ui:setting', (key, value) => {
  const coerced = coerceSetting(key, value)
  if (coerced === undefined) return { ok: false, reason: 'unknown_setting' }
  uiState.settings[key] = coerced
  saveUiState()
  applySettings()
  push()
  return { ok: true, settings: { ...uiState.settings } }
})

handleUi('ui:settings-reset', () => {
  uiState.settings = { ...DEFAULT_SETTINGS }
  saveUiState()
  applySettings()
  push()
  return { ok: true, settings: { ...uiState.settings } }
})

/**
 * Engage a gear.
 *
 * The renderer sends a provider id and a gear number, nothing more — never a
 * model string. Both are resolved against the catalogue here, and the only
 * value that can reach writeModel() is the `apply` field the catalogue itself
 * carries, which is checked against writeModel's whitelist at load. A gear on a
 * provider this app cannot configure is recorded and reported as such rather
 * than being silently dropped.
 */
handleUi('ui:gear', (providerId, gear) => {
  // Reverse is a control, not a model: it re-engages the previous gear.
  if (gear === 'R') {
    const back = uiState.gearbox.previous
    if (!back) return { ok: false, reason: 'nothing_to_reverse_to' }
    return engageGear(back.providerId, back.gear)
  }
  return engageGear(providerId, gear)
})

function engageGear (providerId, gear) {
  const found = findGear(String(providerId), Number(gear))
  if (!found) return { ok: false, reason: 'unknown_gear' }

  const applied = { providerId: found.provider.id, gear: found.gear.gear }
  let write = null

  if (found.provider.configurable && found.gear.apply) {
    write = writeModel(found.gear.apply)
    // A refused write must not leave the shifter claiming a gear it never got
    // into, so the state only advances once the file actually changed.
    if (!write.ok) return { ok: false, reason: write.reason, gear: applied }
  }

  const current = uiState.gearbox
  const changed = current.providerId !== applied.providerId || current.gear !== applied.gear
  uiState.gearbox = {
    providerId: applied.providerId,
    gear: applied.gear,
    previous: changed && current.gear !== null
      ? { providerId: current.providerId, gear: current.gear }
      : current.previous
  }
  saveUiState()
  push()

  return {
    ok: true,
    gearbox: { ...uiState.gearbox },
    // false means "recorded, but nothing on disk changed" — the UI says so
    // rather than implying the CLI was retargeted.
    applied: Boolean(write && write.ok),
    label: found.gear.label
  }
}

onUi('ui:lock', () => {
  uiState.unlocked = false
  saveUiState()
  push()
})

// Hands off to the provider's real site in the user's own browser rather than
// rendering any sign-in form inside this app.
handleUi('ui:open-vendor', async vendorId => {
  const vendor = detectVendors().find(v => v.id === vendorId)
  if (!vendor) return { ok: false, reason: 'unknown_vendor' }
  return openExternal(vendor.url)
})

// A manual refresh may skip the comfortable interval but still cannot dip
// under the provider's hard floor, so impatient clicking cannot dig a 429 hole.
onUi('ui:refresh', () => {
  ;(async () => {
    store.refreshLocal()
    await store.pollOfficial({ force: true })
    push()
  })().catch(() => {})
})

onUi('ui:close', () => app.quit())

onUi('ui:mini', mini => {
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
    // Mount the remembered vendor even though the app opens locked, so the
    // first reading is already warm when the fob is pressed.
    mountStore(uiState.vendor || 'anthropic')
    // theme before the window exists, so it opens in the right palette rather
    // than flashing the system one and correcting itself
    nativeTheme.themeSource = uiState.settings.theme
    createWindow()
    applySettings()
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
