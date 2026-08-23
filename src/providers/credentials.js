'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { claudeCredentials } = require('./paths')

const CRED_PATH = claudeCredentials()

// The exact schema of .credentials.json is not contractual and has changed
// across Claude Code versions. Rather than hard-coding a key path, walk the
// object graph and pick the most plausible OAuth access token. This keeps the
// widget working across upgrades instead of breaking on a rename.
const TOKEN_HINT = /^(access_?token|token|bearer)$/i
const REFRESH_HINT = /refresh/i
const EXPIRY_HINT = /^(expires_?at|expiry|exp)$/i

function looksLikeAccessToken (value) {
  if (typeof value !== 'string' || value.length < 40) return false
  // Anthropic OAuth access tokens are prefixed; fall back to a generic
  // "long opaque secret" shape if the prefix ever changes.
  if (/^sk-ant-(oat|oauth)/i.test(value)) return true
  return /^[A-Za-z0-9_\-.]{40,}$/.test(value)
}

function walk (node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') {
      walk(value, out, depth + 1)
      continue
    }
    if (REFRESH_HINT.test(key)) continue
    if (EXPIRY_HINT.test(key) && typeof value === 'number') {
      out.expiresAt = value > 1e12 ? value : value * 1000
    }
    if (typeof value === 'string' && looksLikeAccessToken(value)) {
      const score = TOKEN_HINT.test(key) ? 2 : /^sk-ant-oat/i.test(value) ? 1 : 0
      if (score > out.score) { out.token = value; out.score = score }
    }
  }
  return out
}

/**
 * Reads the local Claude Code OAuth credentials.
 *
 * This runs on the user's own machine against the user's own credential file,
 * and the token never leaves the process except in the Authorization header of
 * a request to api.anthropic.com. Nothing is logged or persisted.
 *
 * @returns {{token: string, expiresAt: number|null} | null}
 */
/**
 * macOS keeps Claude Code's OAuth token in the login Keychain rather than in a
 * file, so the file read returns ENOENT there even on a signed-in machine.
 * `security find-generic-password` is the supported way to read one's own
 * Keychain item; the first call may raise a system permission prompt, which
 * the user grants once. Any failure falls through to "no credentials", which
 * the store already degrades gracefully around.
 */
function readKeychain () {
  if (process.platform !== 'darwin') return null
  try {
    const { execFileSync } = require('child_process')
    for (const service of ['Claude Code-credentials', 'Claude Code']) {
      try {
        const out = execFileSync(
          'security',
          ['find-generic-password', '-s', service, '-w'],
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
        )
        if (out && out.trim()) return out.trim()
      } catch { /* try the next service name */ }
    }
  } catch { /* security binary unavailable */ }
  return null
}

function readCredentials () {
  let raw
  try {
    raw = fs.readFileSync(CRED_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      raw = readKeychain()
      if (!raw) return null
    } else {
      throw Object.assign(new Error('credentials_unreadable'), { cause: err })
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('credentials_malformed')
  }

  const found = walk(parsed, { token: null, expiresAt: null, score: -1 })
  if (!found.token) return null
  return { token: found.token, expiresAt: found.expiresAt }
}

function credentialsPath () { return CRED_PATH }

module.exports = { readCredentials, credentialsPath }
