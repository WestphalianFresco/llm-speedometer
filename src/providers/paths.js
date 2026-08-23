'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Where each provider's data lives, resolved rather than assumed.
 *
 * Nothing here is a hardcoded absolute path. Every root is derived at call
 * time from, in order:
 *
 *   1. an explicit environment override, which is how both CLIs let you
 *      relocate their state (CODEX_HOME, CLAUDE_CONFIG_DIR)
 *   2. the conventional dot-directory under the current user's home, which
 *      os.homedir() resolves correctly on Windows, macOS and Linux
 *   3. the XDG location, which some Linux packagings prefer
 *
 * The first candidate that exists on disk wins; if none exist, the primary
 * candidate is returned so callers still get a sensible path to report.
 *
 * Resolution happens per call, not at module load, so a directory that appears
 * later — the user signs into a CLI after this app is already running — is
 * picked up without a restart.
 */

const exists = p => {
  try { fs.accessSync(p); return true } catch { return false }
}

/**
 * An explicit environment override is authoritative: if the user points
 * CODEX_HOME or CLAUDE_CONFIG_DIR somewhere, that IS the location, whether or
 * not it exists yet. Probing past it would silently read a different machine's
 * leftover directory, which is worse than reporting an empty one.
 *
 * Only the conventional fallbacks are probed for existence.
 */
function resolveRoot (override, candidates) {
  if (override) return override
  const real = candidates.filter(Boolean)
  for (const c of real) if (exists(c)) return c
  return real[0] || null
}

function xdgConfig () {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

// ---------------------------------------------------------------- Anthropic

function claudeHome () {
  return resolveRoot(process.env.CLAUDE_CONFIG_DIR, [
    path.join(os.homedir(), '.claude'),
    path.join(xdgConfig(), 'claude')
  ])
}

const claudeProjects = () => path.join(claudeHome(), 'projects')
const claudeSessions = () => path.join(claudeHome(), 'sessions')
const claudeSettings = () => path.join(claudeHome(), 'settings.json')
const claudeCredentials = () => path.join(claudeHome(), '.credentials.json')

/**
 * The account/config file sits beside the home directory, not inside it, so it
 * gets its own resolution rather than being derived from claudeHome().
 */
function claudeConfig () {
  return resolveRoot(
    process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : null,
    [
      path.join(os.homedir(), '.claude.json'),
      path.join(xdgConfig(), 'claude', 'claude.json')
    ])
}

// ------------------------------------------------------------------- OpenAI

function codexHome () {
  return resolveRoot(process.env.CODEX_HOME, [
    path.join(os.homedir(), '.codex'),
    path.join(xdgConfig(), 'codex')
  ])
}

const codexSessions = () => path.join(codexHome(), 'sessions')
const codexAuth = () => path.join(codexHome(), 'auth.json')

// -------------------------------------------------------------------- Google

function geminiHome () {
  return resolveRoot(process.env.GEMINI_CONFIG_DIR, [
    path.join(os.homedir(), '.gemini'),
    path.join(xdgConfig(), 'gemini')
  ])
}

/** Diagnostics: what resolved to where, and whether it is actually there. */
function describe () {
  const rows = [
    ['claude home', claudeHome()],
    ['claude projects', claudeProjects()],
    ['claude sessions', claudeSessions()],
    ['claude config', claudeConfig()],
    ['codex home', codexHome()],
    ['codex sessions', codexSessions()],
    ['gemini home', geminiHome()]
  ]
  return rows.map(([label, p]) => ({ label, path: p, exists: exists(p) }))
}

module.exports = {
  exists,
  claudeHome,
  claudeProjects,
  claudeSessions,
  claudeSettings,
  claudeCredentials,
  claudeConfig,
  codexHome,
  codexSessions,
  codexAuth,
  geminiHome,
  describe
}
