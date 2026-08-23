'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { claudeSettings } = require('./paths')

const SETTINGS_PATH = claudeSettings()
const BACKUP_PATH = SETTINGS_PATH + '.speedometer.bak'

/**
 * Models offered by the picker.
 *
 * The values are what Claude Code accepts in settings.json / --model: either a
 * latest-version alias or a full model name. Aliases are preferred so the entry
 * keeps working when a new point release lands.
 */
const MODEL_OPTIONS = [
  { value: 'opus[1m]', label: 'Opus 5 (1M)' },
  { value: 'opus', label: 'Opus 5' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' },
  { value: 'fable', label: 'Fable 5' }
]

const LABELS = new Map(MODEL_OPTIONS.map(o => [o.value, o.label]))

/** Best-effort display name for whatever is configured, including odd values. */
function labelFor (value) {
  if (!value) return null
  if (LABELS.has(value)) return LABELS.get(value)
  return value
}

function readSettings () {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
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
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8')
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
    if (!fs.existsSync(BACKUP_PATH)) fs.writeFileSync(BACKUP_PATH, raw)
  } catch { /* a missing backup must not block the change */ }

  settings.model = value

  const tmp = SETTINGS_PATH + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
    fs.renameSync(tmp, SETTINGS_PATH)
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
  MODEL_OPTIONS, readSettings, readModel, writeModel, labelFor, SETTINGS_PATH, BACKUP_PATH
}
