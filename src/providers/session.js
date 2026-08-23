'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { claudeProjects, claudeSessions, claudeConfig } = require('./paths')

const SESSIONS_DIR = claudeSessions()
const PROJECTS_DIR = claudeProjects()
const CONFIG_PATH = claudeConfig()

// Only the tail of a transcript is needed to learn the model and effort in use,
// and transcripts grow to megabytes — never read one whole.
const TAIL_BYTES = 512 * 1024

const MODEL_NAMES = {
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5'
}

const PLAN_NAMES = {
  default_claude_max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  default_claude_max: 'Max',
  default_claude_pro: 'Pro',
  default_claude_team: 'Team',
  default: 'Free'
}

function prettyModel (id) {
  if (!id) return null
  const base = id.replace(/\[.*$/, '')
  if (MODEL_NAMES[base]) return MODEL_NAMES[base]
  // Unknown id: turn claude-foo-4-9 into Foo 4.9 rather than showing nothing.
  const parts = base.replace(/^claude-/, '').split('-')
  const name = parts.shift() || base
  const version = parts.join('.')
  return name.charAt(0).toUpperCase() + name.slice(1) + (version ? ' ' + version : '')
}

// Derived from the model id rather than hardcoded, so the header stays honest
// if this is ever pointed at a transcript from another provider.
const COMPANIES = [
  [/^claude-/, 'Anthropic'],
  [/^(gpt-|o[0-9]-|chatgpt)/, 'OpenAI'],
  [/^gemini-/, 'Google'],
  [/^(llama|meta-)/, 'Meta'],
  [/^mistral/, 'Mistral'],
  [/^command-/, 'Cohere'],
  [/^grok-/, 'xAI']
]

function companyFor (id) {
  if (!id) return null
  for (const [pattern, name] of COMPANIES) if (pattern.test(id)) return name
  return null
}

function prettyPlan (tier) {
  if (!tier) return null
  if (PLAN_NAMES[tier]) return PLAN_NAMES[tier]
  return tier
    .replace(/^default_/, '')
    .replace(/^claude_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** Every session file currently on disk. */
function allSessions () {
  let entries
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8')))
    } catch { /* mid-write file */ }
  }
  return out
}

/** The live session whose state was touched most recently. */
function newestSession () {
  let entries
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return null
  }
  let best = null
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'))
      const stamp = parsed.updatedAt || parsed.startedAt || 0
      if (!best || stamp > best.stamp) best = { stamp, data: parsed }
    } catch { /* a session file mid-write is not worth failing over */ }
  }
  return best ? best.data : null
}

/** Newest transcript across all projects, by mtime. */
function newestTranscript () {
  let best = null
  let projects
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(PROJECTS_DIR, project.name)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs, size: stat.size }
      } catch { /* ignore */ }
    }
  }
  return best
}

/** Model / effort / version from the last assistant turn actually recorded. */
function readTranscriptTail () {
  const newest = newestTranscript()
  if (!newest) return {}

  const start = Math.max(0, newest.size - TAIL_BYTES)
  let text
  let fd
  try {
    fd = fs.openSync(newest.file, 'r')
    const length = newest.size - start
    const buffer = Buffer.allocUnsafe(length)
    fs.readSync(fd, buffer, 0, length, start)
    text = buffer.toString('utf8')
  } catch {
    return {}
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ }
  }

  const lines = text.split('\n')
  // A partial first line is expected when starting mid-file.
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]
    if (line.indexOf('"model"') === -1) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    // Sidechain entries are subagent turns — they run at their own model and
    // effort, so reading them would misreport the session's own settings.
    if (record.isSidechain) continue
    const model = record.message && record.message.model
    if (!model) continue
    return { model, effort: record.effort || null, version: record.version || null, cwd: record.cwd || null }
  }
  return {}
}

let planCache = { mtimeMs: -1, value: null }

function readPlan () {
  let stat
  try { stat = fs.statSync(CONFIG_PATH) } catch { return null }
  if (stat.mtimeMs === planCache.mtimeMs) return planCache.value

  let value = null
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const account = parsed && parsed.oauthAccount
    if (account) {
      value = prettyPlan(account.organizationRateLimitTier || account.userRateLimitTier)
    }
  } catch { /* keep whatever we had */ }

  planCache = { mtimeMs: stat.mtimeMs, value }
  return value
}

/**
 * Assembles the header line-up: what Claude Code itself would print at startup.
 *
 * @returns {{version, model, effort, plan, cwd, sessionName}}
 */
function readSession () {
  const tail = readTranscriptTail()
  const live = newestSession()

  // The freshest transcript is the better signal for "which session is actually
  // working right now"; several sessions can be alive at once and an idle one
  // still refreshes its session file, so newest-session-file picks the wrong one.
  const cwd = tail.cwd || (live && live.cwd) || null

  // Name the session that matches the cwd we settled on, not just any session.
  let sessionName = null
  if (cwd) {
    const match = allSessions().find(sn => sn.cwd === cwd)
    if (match) sessionName = match.name || null
  }
  if (!sessionName && live) sessionName = live.name || null

  return {
    version: tail.version || (live && live.version) || null,
    company: companyFor(tail.model),
    modelId: tail.model || null,
    model: prettyModel(tail.model),
    effort: tail.effort || null,
    plan: readPlan(),
    cwd,
    sessionName
  }
}

module.exports = { readSession, prettyModel, prettyPlan, companyFor }
