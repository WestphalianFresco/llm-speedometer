'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * What the settings panel needs to know about Elgato's side: whether Stream
 * Deck is on this machine, whether our plugin is in it, and where the packed
 * plugin that ships with this app lives.
 *
 * Installing is handed to Stream Deck itself — opening a .streamDeckPlugin is
 * what its own installer listens for — so this app never writes into another
 * program's plugin folder.
 */

const PLUGIN_UUID = 'com.williamfan.llmmeter'
const PACKED_NAME = PLUGIN_UUID + '.streamDeckPlugin'

function streamDeckDir () {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(roaming, 'Elgato', 'StreamDeck')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.elgato.StreamDeck')
  }
  return null // Elgato ships no Linux build
}

const exists = p => { try { return fs.existsSync(p) } catch { return false } }

/**
 * The packed plugin. An installed copy carries it in resources; a dev checkout
 * has it under build/ once `npm run streamdeck:pack` has run.
 */
function packedPluginPath (app) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, PACKED_NAME)]
    : [path.join(app.getAppPath(), 'build', PACKED_NAME)]
  return candidates.find(exists) || null
}

function streamDeckStatus (app) {
  const dir = streamDeckDir()
  const deckInstalled = Boolean(dir) && exists(dir)
  return {
    deckInstalled,
    pluginInstalled: deckInstalled && exists(path.join(dir, 'Plugins', PLUGIN_UUID + '.sdPlugin')),
    canInstall: deckInstalled && Boolean(packedPluginPath(app))
  }
}

module.exports = { streamDeckStatus, packedPluginPath }
