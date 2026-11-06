'use strict'
const { readCredentials } = require('./credentials')

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

// This endpoint rate-limits far more aggressively than a normal API route:
// polling it on a short interval earns a 429 that then persists for hours.
// See anthropics/claude-code#31021 and #31637. Everything below is built to
// touch it as rarely as possible and to retreat hard the moment it complains.
const MIN_INTERVAL_MS = 5 * 60 * 1000        // never poll faster than this
const BASE_INTERVAL_MS = 15 * 60 * 1000      // healthy cadence
const BACKOFF_LADDER_MS = [15, 30, 60, 120].map(m => m * 60 * 1000)

const numeric = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// The fields a window can carry its level in, in the order they are trusted.
const USED_FIELDS = ['utilization', 'used_percent', 'percent_used', 'percentage']
const REMAINING_FIELDS = ['remaining', 'remaining_percent']

/** Every level-ish number in one window, whichever field it arrived in. */
function levels (raw) {
  if (!raw) return []
  const out = []
  for (const field of USED_FIELDS.concat(REMAINING_FIELDS)) {
    const n = numeric(raw[field])
    if (n !== null && n >= 0) out.push(n)
  }
  return out
}

/**
 * Levels arrive as either 0..1 or 0..100 depending on the payload, and no
 * single field can tell the two apart: 1 is a drained tank on one scale and a
 * barely-touched one on the other. Deciding field by field is what made a
 * 5-hour window twelve minutes old, sitting at 1%, read as bone empty.
 *
 * So the scale is settled once, from every number in the payload at once:
 *   - anything above 1 can only be a percentage, and settles it for all of them
 *   - failing that, a true fraction below 1 can only be the 0..1 shape
 *   - a payload of nothing but 0s and 1s is read as percentages: the fractional
 *     shape carries decimals, and a window at exactly 1.0 is the rarer claim
 */
function scaleFor (raws) {
  const all = raws.reduce((acc, raw) => acc.concat(levels(raw)), [])
  if (all.some(v => v > 1)) return 1
  if (all.some(v => v > 0 && v < 1)) return 100
  return 1
}

/** First present level among `fields`, brought onto the 0..100 scale. */
function pickPercent (raw, fields, scale) {
  for (const field of fields) {
    const n = numeric(raw[field])
    if (n !== null && n >= 0) return n * scale
  }
  return null
}

function toEpochMs (value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

// Pull a window out of the payload without depending on its exact nesting.
const WINDOW_ALIASES = {
  fiveHour: [/^five_?hour$/i, /^5h$/i, /^five_?hour_?limit$/i],
  sevenDay: [/^seven_?day$/i, /^7d$/i, /^weekly$/i, /^week$/i, /^seven_?day_?limit$/i]
}

function findWindow (payload, patterns, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 5) return null
  for (const [key, value] of Object.entries(payload)) {
    if (patterns.some(p => p.test(key))) {
      if (value && typeof value === 'object') return value
      if (typeof value === 'number') return { utilization: value }
    }
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const hit = findWindow(value, patterns, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function readWindow (raw, scale) {
  if (!raw) return null

  let used = pickPercent(raw, USED_FIELDS, scale)
  const remaining = pickPercent(raw, REMAINING_FIELDS, scale)
  if (used === null && remaining !== null) used = 100 - remaining

  const resetsAt = toEpochMs(
    raw.resets_at ?? raw.reset_at ?? raw.resetsAt ?? raw.reset ?? raw.expires_at
  )

  if (used === null) return null
  return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt }
}

/**
 * The `limits` array, which is the shape `/usage` itself renders.
 *
 * The endpoint answers with both shapes: the older top-level `five_hour` /
 * `seven_day` objects, and this array. The array is preferred because it is
 * strictly richer — every entry is already a plain 0..100 `percent`, so none of
 * the scale guessing above applies to it, and it carries the per-model weekly
 * cap that has no top-level equivalent at all. That cap is a real limit you can
 * hit while the all-model weekly window still looks half full, and reading only
 * the top-level keys meant this app could not see it coming.
 *
 * `kind` is an open set. Anything unrecognised is ignored rather than guessed
 * at, and the legacy keys still answer for the two windows that matter most.
 */
const LIMIT_KINDS = {
  session: 'fiveHour',
  five_hour: 'fiveHour',
  weekly_all: 'sevenDay',
  seven_day: 'sevenDay',
  weekly_scoped: 'weeklyScoped'
}

function scopeLabel (scope) {
  if (!scope || typeof scope !== 'object') return null
  const model = scope.model && (scope.model.display_name || scope.model.id)
  const surface = typeof scope.surface === 'string'
    ? scope.surface
    : scope.surface && scope.surface.display_name
  return [model, surface].filter(Boolean).join(' · ') || null
}

function readLimits (payload) {
  const list = payload && Array.isArray(payload.limits) ? payload.limits : null
  if (!list) return null

  const out = {}
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const key = LIMIT_KINDS[String(entry.kind || '').toLowerCase()]
    if (!key) continue
    const percent = numeric(entry.percent)
    if (percent === null || percent < 0) continue

    const reading = {
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt: toEpochMs(entry.resets_at),
      severity: typeof entry.severity === 'string' ? entry.severity : null,
      scope: scopeLabel(entry.scope)
    }
    // Several scoped caps can be in flight at once, one per model. Only the
    // tightest is worth a gauge — it is the one that will stop you first.
    if (!out[key] || reading.usedPercent > out[key].usedPercent) out[key] = reading
  }
  return Object.keys(out).length ? out : null
}

/**
 * Money actually owed, as opposed to quota consumed.
 *
 * Every `*_dollars` field on the quota windows comes back null on a
 * subscription — the plan is not metered in dollars, so there is nothing to
 * report there and no amount of parsing will produce one. What IS real is
 * `spend`: usage credits burned past the plan's limits, in minor units with an
 * explicit exponent. For anyone off a subscription that is the entire meter,
 * and for anyone on one it is the part of the month that actually costs money.
 */
function readSpend (payload) {
  if (!payload || typeof payload !== 'object') return null

  const spend = payload.spend
  if (spend && spend.used && numeric(spend.used.amount_minor) !== null) {
    const exponent = numeric(spend.used.exponent)
    const divisor = Math.pow(10, exponent === null ? 2 : exponent)
    const limitMinor = spend.limit && numeric(spend.limit.amount_minor)
    return {
      usedUsd: spend.used.amount_minor / divisor,
      limitUsd: limitMinor === null || limitMinor === undefined ? null : limitMinor / divisor,
      currency: spend.used.currency || 'USD',
      enabled: spend.enabled !== false,
      percent: numeric(spend.percent)
    }
  }

  // Older payloads carry the same number under extra_usage, as credits in minor
  // units with the exponent stated separately.
  const extra = payload.extra_usage
  if (extra && numeric(extra.used_credits) !== null) {
    const places = numeric(extra.decimal_places)
    const divisor = Math.pow(10, places === null ? 2 : places)
    const limit = numeric(extra.monthly_limit)
    return {
      usedUsd: extra.used_credits / divisor,
      limitUsd: limit === null ? null : limit / divisor,
      currency: extra.currency || 'USD',
      enabled: extra.is_enabled !== false,
      percent: numeric(extra.utilization)
    }
  }

  return null
}

class OfficialProvider {
  constructor () {
    this.backoffIndex = -1        // -1 == healthy
    this.nextAllowedAt = 0
    this.lastError = null
  }

  /** Earliest wall-clock time this provider is willing to be called again. */
  nextPollAt () { return this.nextAllowedAt }

  /** Interval to use for scheduling, widening while we are being throttled. */
  currentIntervalMs () {
    if (this.backoffIndex < 0) return BASE_INTERVAL_MS
    return BACKOFF_LADDER_MS[Math.min(this.backoffIndex, BACKOFF_LADDER_MS.length - 1)]
  }

  _succeed () {
    this.backoffIndex = -1
    this.lastError = null
    this.nextAllowedAt = Date.now() + BASE_INTERVAL_MS
  }

  _throttle (reason, retryAfterMs) {
    this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_LADDER_MS.length - 1)
    const wait = Math.max(retryAfterMs || 0, this.currentIntervalMs())
    this.nextAllowedAt = Date.now() + wait
    this.lastError = reason
  }

  /**
   * @param {{force?: boolean}} [opts] force skips the local cooldown but still
   *   respects MIN_INTERVAL_MS, so a manual refresh cannot dig a 429 hole.
   */
  async fetch (opts = {}) {
    const now = Date.now()
    if (!opts.force && now < this.nextAllowedAt) {
      return { status: 'cooldown', retryAt: this.nextAllowedAt, reason: this.lastError }
    }
    if (opts.force && now < this.nextAllowedAt - (this.currentIntervalMs() - MIN_INTERVAL_MS)) {
      return { status: 'cooldown', retryAt: this.nextAllowedAt, reason: 'min_interval' }
    }

    let creds
    try {
      creds = readCredentials()
    } catch (err) {
      this._throttle(err.message, 60 * 60 * 1000)
      return { status: 'error', reason: err.message }
    }
    if (!creds) {
      this._throttle('no_credentials', 60 * 60 * 1000)
      return { status: 'error', reason: 'no_credentials' }
    }
    if (creds.expiresAt && creds.expiresAt < Date.now()) {
      // Claude Code refreshes the token on its next run; nothing for us to do.
      this._throttle('token_expired', 30 * 60 * 1000)
      return { status: 'error', reason: 'token_expired' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${creds.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
          'user-agent': 'claude-meter/1.0 (local desktop widget)'
        }
      })
    } catch (err) {
      clearTimeout(timeout)
      this._throttle(err.name === 'AbortError' ? 'timeout' : 'network_error')
      return { status: 'error', reason: err.name === 'AbortError' ? 'timeout' : 'network_error' }
    }
    clearTimeout(timeout)

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      this._throttle('rate_limited', Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)
      return { status: 'rate_limited', retryAt: this.nextAllowedAt }
    }
    if (res.status === 401 || res.status === 403) {
      this._throttle('unauthorized', 60 * 60 * 1000)
      return { status: 'error', reason: 'unauthorized' }
    }
    if (!res.ok) {
      this._throttle(`http_${res.status}`)
      return { status: 'error', reason: `http_${res.status}` }
    }

    let payload
    try {
      payload = await res.json()
    } catch {
      this._throttle('bad_payload')
      return { status: 'error', reason: 'bad_payload' }
    }

    // Both windows are pulled out before either is converted, so the pair can
    // agree on one scale — a weekly window reading 26 is what proves a 5-hour
    // window reading 1 is a percentage and not a full tank.
    const rawFiveHour = findWindow(payload, WINDOW_ALIASES.fiveHour)
    const rawSevenDay = findWindow(payload, WINDOW_ALIASES.sevenDay)
    const scale = scaleFor([rawFiveHour, rawSevenDay])

    // The limits array wins where it answers: its percentages need no scale
    // inference, and it is the same list `/usage` prints. The legacy keys fill
    // any gap so an older payload still drives both gauges.
    const limits = readLimits(payload) || {}
    const fiveHour = limits.fiveHour || readWindow(rawFiveHour, scale)
    const sevenDay = limits.sevenDay || readWindow(rawSevenDay, scale)
    const weeklyScoped = limits.weeklyScoped || null
    const spend = readSpend(payload)

    if (!fiveHour && !sevenDay) {
      // Endpoint answered but in a shape we do not recognize — treat as a soft
      // failure so the local estimator stays in charge instead of showing 0%.
      this._throttle('unrecognized_schema', 60 * 60 * 1000)
      // The body is deliberately not returned. It is an account-scoped API
      // response, and the caller only ever needs to know the shape was not
      // understood — passing it along would put it a step from the UI and the
      // diagnostics tooltip.
      return { status: 'error', reason: 'unrecognized_schema' }
    }

    this._succeed()
    return { status: 'ok', at: Date.now(), fiveHour, sevenDay, weeklyScoped, spend }
  }
}

module.exports = {
  OfficialProvider,
  ENDPOINT,
  MIN_INTERVAL_MS,
  BASE_INTERVAL_MS,
  readLimits,
  readSpend
}
