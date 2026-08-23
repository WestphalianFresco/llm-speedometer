'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readAccount } = require('./account')

const { claudeProjects, codexHome, codexAuth, codexSessions, geminiHome, exists: pathExists } = require('./paths')

/**
 * The providers the unlock screen can offer.
 *
 * `usable` is decided by detection, not declared here, and it is deliberately
 * strict: it means "this dashboard can actually read usage for this provider",
 * not merely "a CLI for it is installed".
 *
 * This app never asks for a credential. For anything not already signed in
 * locally, the only action offered is opening the provider's real site in the
 * user's browser — there is no form here to type a password or token into.
 */
const VENDORS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    product: 'Claude Code',
    url: 'https://claude.ai/login',
    supported: true,
    signInHint: 'Run `claude` in a terminal and follow the sign-in prompt.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    product: 'Codex CLI',
    url: 'https://chatgpt.com/',
    supported: true,
    signInHint: null
  },
  {
    id: 'google',
    name: 'Google',
    product: 'Gemini CLI',
    url: 'https://gemini.google.com/',
    supported: false,
    signInHint: null
  }
]

const exists = p => { try { fs.accessSync(p); return true } catch { return false } }

function detectAnthropic () {
  const account = readAccount()
  const hasTranscripts = exists(claudeProjects())
  if (account && account.email) {
    return {
      present: true,
      usable: hasTranscripts,
      account: account.email,
      note: hasTranscripts
        ? 'Signed in. Usage and quota available.'
        : 'Signed in, but no transcripts found yet.'
    }
  }
  return { present: false, usable: false, account: null, note: 'Not signed in on this machine.' }
}

/**
 * Does Codex have any rollout transcripts on disk?
 *
 * These live under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and only appear
 * once Codex has actually been run. An earlier version of this check looked
 * only at the SQLite databases, concluded no usage data existed, and told the
 * user OpenAI could never be metered. That was wrong: the rollouts carry
 * per-turn token counts AND a rate_limits block with used_percent, window and
 * reset time — everything the gauges need, without any API polling.
 */
function hasCodexRollouts () {
  const root = codexSessions()
  const stack = [root]
  let depth = 0
  while (stack.length && depth < 4000) {
    depth++
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name))
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) return true
    }
  }
  return false
}

function detectOpenAI () {
  const dir = codexHome()
  if (!exists(dir)) {
    return {
      present: false,
      usable: false,
      dataAvailable: false,
      account: null,
      note: 'Codex CLI not found on this device. Sign in to ChatGPT, install ' +
            'Codex, then run `codex` once — usage appears here straight after, ' +
            'with no restart needed.'
    }
  }
  const signedIn = exists(codexAuth())
  const hasData = hasCodexRollouts()

  if (!hasData) {
    return {
      present: signedIn,
      usable: false,
      dataAvailable: false,
      account: null,
      note: 'Codex CLI is installed but has not been run on this machine yet, so ' +
            'it has written no usage data. Run `codex` once and it will appear.'
    }
  }

  return {
    present: signedIn,
    usable: true,
    dataAvailable: true,
    account: null,
    note: 'Codex rollouts found. Output rate, odometer and the weekly tank are ' +
          'available. ChatGPT plans report only a weekly window, so TANK / 5H ' +
          'reads N/A.'
  }
}

function detectGoogle () {
  const dir = geminiHome()
  if (!exists(dir)) {
    return {
      present: false,
      usable: false,
      account: null,
      note: 'Gemini CLI not found on this device. No reader is implemented for it yet.'
    }
  }
  return {
    present: true,
    usable: false,
    account: null,
    note: 'Gemini CLI detected, but reading its usage is not implemented yet.'
  }
}

const DETECTORS = {
  anthropic: detectAnthropic,
  openai: detectOpenAI,
  google: detectGoogle
}

/** @returns {Array<object>} every vendor, annotated with live local state. */
function detectVendors () {
  return VENDORS.map(v => Object.assign({}, v, DETECTORS[v.id]()))
}

module.exports = { VENDORS, detectVendors }
