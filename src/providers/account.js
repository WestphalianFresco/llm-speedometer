'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { claudeConfig } = require('./paths')

// Cached because this file is large and the account on it never changes within
// a session; re-read only when the file's mtime moves.
let cache = { mtimeMs: -1, value: null }

/**
 * Reads the signed-in account from Claude Code's own config.
 *
 * Only the display fields are pulled out — this deliberately never touches
 * .credentials.json, which is the token store and is handled separately.
 *
 * @returns {{email: string|null, org: string|null}|null}
 */
function readAccount () {
  let stat
  try {
    stat = fs.statSync(claudeConfig())
  } catch {
    return null
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.value

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(claudeConfig(), 'utf8'))
  } catch {
    return cache.value
  }

  const account = parsed && parsed.oauthAccount
  const value = account
    ? {
        email: typeof account.emailAddress === 'string' ? account.emailAddress : null,
        org: typeof account.organizationName === 'string' ? account.organizationName : null
      }
    : null

  cache = { mtimeMs: stat.mtimeMs, value }
  return value
}

module.exports = { readAccount, configPath: claudeConfig }
