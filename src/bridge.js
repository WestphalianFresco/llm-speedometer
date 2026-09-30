'use strict'
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

/**
 * A loopback-only door for other local tools — the Stream Deck plugin first —
 * to read the gauges without reading the transcripts or polling Anthropic
 * themselves. The usage endpoint throttles hard; a second poller on the same
 * account would halve the budget this app already rations carefully, so
 * everything outside the window reads through here instead.
 *
 * It listens on 127.0.0.1 on a port the OS picks, and writes the port and a
 * fresh random token to ~/.llm-speedometer/bridge.json. Every request must
 * carry that token. That keeps it out of reach of web pages open in a browser
 * on the same machine: a page can guess the port but cannot read the file, and
 * the Host check below stops DNS rebinding from lending it a same-origin name.
 */

const BRIDGE_DIR = () => path.join(os.homedir(), '.llm-speedometer')
const BRIDGE_FILE = () => path.join(BRIDGE_DIR(), 'bridge.json')
const API_VERSION = 1

/**
 * The reading, cut down to what a 72px key can show and with the percentages
 * already turned the way the gauges turn them — remaining, not used. Accounts,
 * paths and session names stay in the app.
 */
function summarise (payload, extra) {
  const tank = (win, budget) => {
    if (!win || win.percent === null || win.percent === undefined) {
      return { percentLeft: null, resetsAt: win ? win.resetsAt || null : null,
        source: win ? win.source || null : null, tokensLeft: null, tokensUsed: null }
    }
    return {
      percentLeft: Math.max(0, Math.min(100, 100 - win.percent)),
      resetsAt: win.resetsAt || null,
      source: win.source || null,
      tokensLeft: budget && budget.remainingTokens !== undefined ? budget.remainingTokens : null,
      tokensUsed: budget ? budget.usedTokens : null
    }
  }
  const budget = payload.budget || {}
  const cost = payload.cost || {}
  return {
    v: API_VERSION,
    at: payload.at,
    ...extra,
    tokensPerMinute: payload.tokensPerMinute || 0,
    fiveHour: tank(payload.fiveHour, budget.fiveHour),
    sevenDay: tank(payload.sevenDay, budget.sevenDay),
    costWeek: typeof cost.sevenDay === 'number' ? cost.sevenDay : null,
    lifetimeTokens: budget.lifetime ? budget.lifetime.usedTokens : null
  }
}

/**
 * @param {object} hooks
 * @param {() => object|null} hooks.read     the current store reading
 * @param {() => object}      hooks.context  vendor / unlocked, sent alongside
 * @param {() => Promise}     hooks.refresh  same path as the tray's Refresh now
 * @param {() => void}        hooks.show     same path as the tray's Show dashboard
 * @param {object}            hooks.launch   how to start this app again, for a key pressed while it is closed
 */
function startBridge (hooks) {
  const token = crypto.randomBytes(24).toString('hex')
  let file = null
  // Who last read the gauges, for the settings panel's status line.
  const seen = { at: 0, keys: 0 }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const port = server.address().port
    const host = String(req.headers.host || '')
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return send(res, 421, { ok: false })

    const given = Buffer.from(String(req.headers['x-bridge-token'] || ''))
    const wanted = Buffer.from(token)
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
      return send(res, 401, { ok: false })
    }

    const route = req.method + ' ' + req.url
    try {
      if (route === 'GET /v1/reading') {
        seen.at = Date.now()
        seen.keys = Math.max(0, Math.min(999, parseInt(req.headers['x-bridge-keys'], 10) || 0))
        const payload = hooks.read()
        if (!payload) return send(res, 503, { ok: false, reason: 'no_store' })
        return send(res, 200, summarise(payload, hooks.context()))
      }
      if (route === 'POST /v1/refresh') {
        hooks.refresh().catch(() => {})
        return send(res, 202, { ok: true })
      }
      if (route === 'POST /v1/show') {
        hooks.show()
        return send(res, 200, { ok: true })
      }
    } catch {
      return send(res, 500, { ok: false })
    }
    return send(res, 404, { ok: false })
  })

  server.on('error', () => { /* a bridge that cannot start is not worth taking the app down */ })

  server.listen(0, '127.0.0.1', () => {
    try {
      fs.mkdirSync(BRIDGE_DIR(), { recursive: true })
      file = BRIDGE_FILE()
      fs.writeFileSync(file, JSON.stringify({
        v: API_VERSION,
        port: server.address().port,
        token,
        pid: process.pid,
        launch: hooks.launch
      }, null, 2), { mode: 0o600 })
    } catch { file = null }
  })

  return {
    status () {
      return { port: server.listening ? server.address().port : null, lastSeenAt: seen.at, keys: seen.keys }
    },

    /**
     * Drop the token but keep the launch line, so a key pressed after quitting
     * can still start the app rather than only reporting it offline.
     */
    stop () {
      server.close()
      if (!file) return
      try {
        fs.writeFileSync(file, JSON.stringify({ v: API_VERSION, port: null, token: null, pid: null,
          launch: hooks.launch }, null, 2), { mode: 0o600 })
      } catch { /* ignore */ }
    }
  }
}

module.exports = { startBridge, summarise, BRIDGE_FILE }
