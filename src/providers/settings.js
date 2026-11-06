'use strict'
const fs = require('fs')

const { claudeSettings } = require('./paths')

// Resolved per call rather than frozen at import, so a CLAUDE_CONFIG_DIR that
// only becomes real after launch is still written to the right place.
const settingsPath = () => claudeSettings()
const backupPath = () => settingsPath() + '.speedometer.bak'

/**
 * Models offered by the picker.
 *
 * The values are what Claude Code accepts in settings.json / --model: either a
 * latest-version alias or a full model name. Aliases are preferred so the entry
 * keeps working when a new point release lands. The labels name what each
 * alias resolves to on the Anthropic API as of 2026-09-30.
 *
 * `opus[1m]` is no longer offered: every model these aliases resolve to runs
 * the million-token window natively, so it selects the same model as `opus`.
 * Claude Code still accepts it, and labelFor() still names it, so a
 * settings.json that already carries it reads correctly.
 */
const MODEL_OPTIONS = [
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 4.5' }
]

const LABELS = new Map(MODEL_OPTIONS.map(o => [o.value, o.label]))

/** Best-effort display name for whatever is configured, including odd values. */
function labelFor (value) {
  if (!value) return null
  if (LABELS.has(value)) return LABELS.get(value)
  // `opus[1m]` and friends: the suffix picks a context window, not a model.
  const base = String(value).replace(/\[.*$/, '')
  if (LABELS.has(base)) return LABELS.get(base)
  return value
}

function readSettings () {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return null
  }
}

function readModel () {
  const settings = readSettings()
  return settings && typeof settings.model === 'string' ? settings.model : null
}

/**
 * Writes the model preference, leaving every other setting untouched.
 *
 * This is another program's config file, so: re-read immediately before
 * writing (never cache and clobber), keep a one-time backup of the original,
 * and swap the file in atomically so an interrupted write cannot leave Claude
 * Code with a truncated settings.json.
 *
 * @returns {{ok: true, model: string} | {ok: false, reason: string}}
 */
function writeModel (value) {
  if (!MODEL_OPTIONS.some(o => o.value === value)) {
    return { ok: false, reason: 'unknown_model' }
  }

  let raw
  try {
    raw = fs.readFileSync(settingsPath(), 'utf8')
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no_settings_file' : 'unreadable' }
  }

  let settings
  try {
    settings = JSON.parse(raw)
  } catch {
    // Refuse to rewrite a file we cannot parse — that would destroy content.
    return { ok: false, reason: 'malformed_settings' }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, reason: 'malformed_settings' }
  }

  if (settings.model === value) return { ok: true, model: value }

  // Preserve the pre-existing file once, before we ever modify it.
  try {
    const backup = backupPath()
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw)
  } catch { /* a missing backup must not block the change */ }

  settings.model = value

  const target = settingsPath()
  const tmp = target + '.tmp-' + process.pid
  try {
    // 0o600: this file can carry API keys and hook commands, so the temp copy
    // must not exist world-readable even for the instant before the rename.
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, target)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, reason: 'write_failed' }
  }

  return { ok: true, model: value }
}

/**
 * Reduce any model spelling to its family so a configured value can be compared
 * against what the live transcript reports. `opus[1m]` and `claude-opus-5` are
 * the same model; comparing display strings flags them as different.
 *
 * Family granularity is the honest limit: a transcript records `claude-opus-5`
 * whether or not the 1M variant is active, so an opus -> opus[1m] switch is
 * not detectable here.
 */
function modelFamily (value) {
  if (!value) return null
  return String(value)
    .toLowerCase()
    .replace(/\[.*$/, '')
    .replace(/^claude-/, '')
    .replace(/[^a-z]/g, '') || null
}

module.exports = {
  modelFamily,
  MODEL_OPTIONS, readSettings, readModel, writeModel, labelFor, settingsPath, backupPath
}
