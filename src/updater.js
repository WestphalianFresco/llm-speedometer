'use strict'
const { app, dialog, Notification } = require('electron')

/**
 * Self-update from GitHub Releases.
 *
 * Every push to main is built by .github/workflows/release.yml into a release
 * carrying the installer and a latest.yml describing it. The installed app
 * reads that file, downloads anything newer in the background, and then asks
 * before restarting into it — a gauge that restarts itself mid-glance is worse
 * than one a version behind. An update that is never accepted still lands: it
 * installs itself silently the next time the app quits.
 *
 * Only the installed build can do this. The portable exe has no installer to
 * hand over to, and an unpackaged `npm start` has no app-update.yml to read, so
 * both report that and otherwise leave updates alone.
 */

// Often enough that a fix lands the same day; rarely enough that GitHub's
// unauthenticated limit of 60 requests an hour per address never comes close.
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
// Startup is busy mounting the store and taking the first reading; the check
// gains nothing by joining in.
const FIRST_CHECK_DELAY_MS = 15 * 1000
// A message box grows to fit its text, and a week of pushes is a lot of lines.
const MAX_NOTE_LINES = 12

// electron-builder's portable launcher sets this before starting the real exe.
const isPortable = () => Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

/**
 * The release notes as plain lines. They normally come from latest.yml, where
 * CI writes the commit subjects as Markdown; when that is missing,
 * electron-updater falls back to the release feed, which is HTML.
 */
function notesText (info) {
  let notes = info.releaseNotes
  if (Array.isArray(notes)) notes = notes.map(n => n.note || '').join('\n')
  if (typeof notes !== 'string') return ''
  const lines = notes
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length <= MAX_NOTE_LINES) return lines.join('\n')
  return lines.slice(0, MAX_NOTE_LINES).join('\n') +
    `\n…and ${lines.length - MAX_NOTE_LINES} more`
}

/**
 * @param {object} hooks
 * @param {() => Electron.BrowserWindow|null} hooks.window  parent for dialogs, when visible
 * @param {() => void} hooks.onChange  the state changed; rebuild anything showing it
 * @param {() => void} hooks.beforeInstall  about to quit into the installer
 * @param {string} hooks.icon  path for the notification icon
 */
function createUpdater ({ window, onChange, beforeInstall, icon }) {
  // Windows only: electron-updater refuses an unsigned macOS build, and the
  // dmg is unsigned, so there the check would only ever raise an error.
  const supported = app.isPackaged && !isPortable() && process.platform === 'win32'
  // Required lazily: constructing the updater reads app-update.yml from the
  // resources folder, which a dev checkout does not have.
  const autoUpdater = supported ? require('electron-updater').autoUpdater : null

  let state = 'idle' // idle | checking | downloading | ready
  let version = null
  let ready = null // UpdateInfo of a downloaded update waiting on a restart
  let notifiedVersion = null
  let manual = false
  let prompting = false

  const setState = (next, info) => {
    state = next
    if (info) version = info.version
    onChange()
  }

  const parent = () => {
    const w = window()
    return w && !w.isDestroyed() && w.isVisible() ? w : null
  }

  const tell = (message, detail = '', type = 'info') => {
    const options = { type, title: 'LLM Speedometer', message, detail, buttons: ['OK'], noLink: true }
    const w = parent()
    return w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options)
  }

  function install () {
    if (!ready) return
    beforeInstall()
    // Silent, because the installer is the wizard kind and walking back through
    // its pages for an update would be absurd; force-run, so the app comes back
    // up on the new version instead of just disappearing.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  }

  async function promptInstall () {
    if (!ready || prompting) return
    prompting = true
    try {
      const notes = notesText(ready)
      const options = {
        type: 'info',
        title: 'Update ready',
        message: `LLM Speedometer ${ready.version} is ready to install.`,
        detail: (notes ? 'What changed:\n' + notes + '\n\n' : '') +
          'Restarting takes a few seconds. If you choose Later, it installs the next time you quit.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }
      const w = parent()
      const { response } = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options)
      if (response === 0) install()
    } finally {
      prompting = false
    }
  }

  function announce (info) {
    // A periodic check finds the same downloaded update again; saying so every
    // four hours would turn a reminder into nagging.
    if (notifiedVersion === info.version) return
    notifiedVersion = info.version
    if (!Notification.isSupported()) return promptInstall()
    const note = new Notification({
      title: `LLM Speedometer ${info.version} is ready`,
      body: 'Click to see what changed and restart into it.',
      icon
    })
    note.on('click', () => { promptInstall() })
    note.show()
  }

  if (autoUpdater) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      if (state !== 'ready') setState('checking')
    })
    autoUpdater.on('update-available', info => {
      setState('downloading', info)
      if (manual) {
        tell(`Version ${info.version} is available.`,
          'It is downloading in the background; you will be asked before it installs.')
      }
      manual = false
    })
    autoUpdater.on('update-not-available', () => {
      setState(ready ? 'ready' : 'idle')
      if (manual) tell('You are on the latest version.', `LLM Speedometer ${app.getVersion()}`)
      manual = false
    })
    autoUpdater.on('update-downloaded', info => {
      ready = info
      setState('ready', info)
      announce(info)
    })
    autoUpdater.on('error', error => {
      // Offline, or GitHub having a moment: an automatic check just tries again
      // next time. Only a check somebody asked for is worth interrupting over.
      console.error('[updater]', error && error.message)
      setState(ready ? 'ready' : 'idle')
      if (manual) tell('Could not check for updates.', String(error && error.message || error), 'warning')
      manual = false
    })
  }

  function check (byHand = false) {
    if (!autoUpdater) {
      if (byHand) {
        tell('This copy cannot update itself.',
          isPortable()
            ? 'The portable build has no installer to update through. Install the Setup version from GitHub Releases to get updates automatically.'
            : process.platform !== 'win32' && app.isPackaged
              ? 'Only the Windows installer updates itself. Download the new build from GitHub Releases.'
              : 'Updates apply to the installed app, not to a development run.')
      }
      return
    }
    if (state === 'checking' || state === 'downloading') return
    if (state === 'ready' && byHand) return promptInstall()
    manual = byHand
    autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ })
  }

  function start () {
    if (!autoUpdater) return
    setTimeout(() => check(false), FIRST_CHECK_DELAY_MS)
    setInterval(() => check(false), CHECK_EVERY_MS)
  }

  /** The tray's update entry, worded for whatever is happening right now. */
  function menuItem () {
    switch (state) {
      case 'checking':
        return { label: 'Checking for updates…', enabled: false }
      case 'downloading':
        return { label: `Downloading ${version}…`, enabled: false }
      case 'ready':
        return { label: `Restart to update to ${version}`, click: install }
      default:
        return { label: 'Check for updates', click: () => check(true) }
    }
  }

  return { start, check, menuItem }
}

module.exports = { createUpdater }
