'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { codexSessions } = require('./paths')
const { costOfTokens, priceMeta } = require('./pricing')

const RATE_WINDOW_MS = 10 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
// A rollout whose file has not been touched in this long is treated as idle
// rather than actively working. Codex writes no liveness record of its own.
const BUSY_WINDOW_MS = 90 * 1000

const MODEL_NAMES = {
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.3-codex': 'GPT-5.3-Codex'
}

function prettyModel (id) {
  if (!id) return null
  if (MODEL_NAMES[id]) return MODEL_NAMES[id]
  // gpt-6.1-sol -> GPT-6.1 Sol, without hardcoding every future name. The
  // version stays hyphenated to GPT the way OpenAI writes it; splitting it off
  // with a space gave "GPT 6.1 Sol".
  const capital = part => part.charAt(0).toUpperCase() + part.slice(1)
  const [head, ...rest] = String(id).split('-')
  if (/^gpt$/i.test(head) && rest.length) {
    return ['GPT-' + rest[0], ...rest.slice(1).map(capital)].join(' ')
  }
  return [head, ...rest].map(capital).join(' ')
}

const prettyPlan = plan =>
  plan ? String(plan).charAt(0).toUpperCase() + String(plan).slice(1) : null

/** Every rollout transcript on disk, newest last. */
function rolloutFiles () {
  const out = []
  const stack = [codexSessions()]
  let guard = 0
  while (stack.length && guard < 5000) {
    guard++
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

/**
 * Parse one rollout.
 *
 * Rollouts are append-only while a session runs, but they top out in the
 * hundreds of KB, so a whole re-read on change is cheaper than tracking byte
 * offsets across a format that interleaves several record types.
 */
function parseRollout (file) {
  const result = {
    events: [],
    meta: null,
    rateLimits: null,
    model: null,
    effort: null,
    totals: { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 }
  }

  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return result }

  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"type"') === -1) continue
    let record
    try { record = JSON.parse(line) } catch { continue }

    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue

    if (record.type === 'session_meta') {
      result.meta = {
        sessionId: payload.session_id || payload.id || null,
        cwd: payload.cwd || null,
        cliVersion: payload.cli_version || null,
        provider: payload.model_provider || null,
        startedAt: Date.parse(payload.timestamp || record.timestamp) || null
      }
      continue
    }

    if (record.type === 'turn_context') {
      if (payload.model) result.model = payload.model
      const settings = payload.collaboration_mode && payload.collaboration_mode.settings
      if (settings && settings.reasoning_effort) result.effort = settings.reasoning_effort
      continue
    }

    // token_count events carry both the running total and the delta for the
    // turn that just finished; the delta is what a rate needs.
    const info = payload.info
    if (info && info.last_token_usage) {
      const last = info.last_token_usage
      const ts = Date.parse(record.timestamp)
      if (!Number.isNaN(ts)) {
        result.events.push({
          ts,
          input: last.input_tokens || 0,
          output: last.output_tokens || 0,
          cachedInput: last.cached_input_tokens || 0,
          cacheWrite: last.cache_write_input_tokens || 0
        })
      }
      if (info.total_token_usage) {
        const t = info.total_token_usage
        result.totals = {
          input: t.input_tokens || 0,
          output: t.output_tokens || 0,
          cachedInput: t.cached_input_tokens || 0,
          cacheWrite: t.cache_write_input_tokens || 0,
          total: t.total_tokens || 0
        }
      }
    }

    if (payload.rate_limits) result.rateLimits = payload.rate_limits
  }

  return result
}

class CodexStore {
  constructor () {
    /** @type {Map<string, {mtimeMs:number,size:number,parsed:object}>} */
    this.cache = new Map()
    this.rollouts = []
    this.lastScanAt = 0
  }

  /** Present so the two stores share one interface; Codex persists nothing. */
  save () {}

  /**
   * Quota arrives inside the transcripts, so there is no endpoint to poll and
   * no backoff to run. These stubs keep main.js's tick loop vendor-agnostic.
   */
  get official () {
    return {
      nextPollAt: () => Number.MAX_SAFE_INTEGER,
      backoffIndex: -1,
      lastError: null
    }
  }

  async pollOfficial () { return { status: 'ok', at: Date.now() } }

  refreshLocal () {
    const files = rolloutFiles()
    const seen = new Set()
    const rollouts = []

    for (const file of files) {
      seen.add(file)
      let stat
      try { stat = fs.statSync(file) } catch { continue }

      const cached = this.cache.get(file)
      let parsed
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        parsed = cached.parsed
      } else {
        parsed = parseRollout(file)
        this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
      }
      rollouts.push({ file, mtimeMs: stat.mtimeMs, parsed })
    }

    for (const key of Array.from(this.cache.keys())) {
      if (!seen.has(key)) this.cache.delete(key)
    }

    rollouts.sort((a, b) => a.mtimeMs - b.mtimeMs)
    this.rollouts = rollouts
    this.lastScanAt = Date.now()
  }

  /** Output tokens per minute across the trailing rate window. */
  ratePerMinute () {
    const since = Date.now() - RATE_WINDOW_MS
    let tokens = 0
    for (const r of this.rollouts) {
      for (const e of r.parsed.events) {
        if (e.ts >= since) tokens += e.output
      }
    }
    return tokens / (RATE_WINDOW_MS / 60000)
  }

  /** Newest rollout is the session currently being worked in. */
  newest () {
    return this.rollouts.length ? this.rollouts[this.rollouts.length - 1] : null
  }

  /**
   * Tokens, turns and dollars inside an explicit window.
   *
   * Codex's rate_limits give a percentage and nothing else, exactly as
   * Anthropic's endpoint does, so the same trick applies: measure the tokens
   * locally, divide by the share of the window they represent, and the quotient
   * is a capacity. Each rollout's model prices its own turns — a session run on
   * a mini model must not be costed at the flagship rate.
   */
  windowTally (fromMs, toMs = Date.now()) {
    let tokens = 0
    let cost = 0
    let turns = 0
    let oldest = null

    for (const r of this.rollouts) {
      const model = r.parsed.model
      for (const e of r.parsed.events) {
        if (oldest === null || e.ts < oldest) oldest = e.ts
        if (e.ts < fromMs || e.ts > toMs) continue
        // Same definition as the odometer: fed plus produced, cached reads out.
        tokens += (e.input || 0) + (e.cacheWrite || 0) + (e.output || 0)
        cost += costOfTokens({
          input: e.input || 0,
          output: e.output || 0,
          cachedInput: e.cachedInput || 0,
          cacheWrite: e.cacheWrite || 0
        }, model, 'openai')
        turns++
      }
    }

    const span = Math.max(1, toMs - fromMs)
    // Codex keeps rollouts indefinitely, so coverage is bounded by how far back
    // the transcripts themselves go rather than by a retention policy.
    const horizon = oldest === null ? toMs : Math.max(fromMs, Math.min(oldest, toMs))
    return {
      tokens,
      cost,
      turns,
      from: fromMs,
      to: toMs,
      covered: Math.min(1, Math.max(0, (toMs - horizon) / span))
    }
  }

  /** A window in tokens, mirroring UsageStore._budget so one renderer fits both. */
  budgetFor (window, spanMs) {
    const now = Date.now()
    const start = window && window.resetsAt
      ? Math.min(window.resetsAt - spanMs, now)
      : now - spanMs
    const tally = this.windowTally(start, now)
    const percent = window ? window.percent : null

    const base = {
      windowStart: start,
      resetsAt: window ? window.resetsAt : null,
      usedTokens: tally.tokens,
      usedCost: tally.cost,
      turns: tally.turns,
      covered: tally.covered
    }

    // Same floors as the Anthropic store: below 8% the division turns rounding
    // into noise, and a window local history does not cover implies a capacity
    // far too small.
    if (percent === null || percent < 8 || tally.covered < 0.98 || tally.tokens <= 0) {
      return { ...base, capacityTokens: null, remainingTokens: null, confidence: 'unknown' }
    }
    const capacityTokens = tally.tokens / (percent / 100)
    return {
      ...base,
      capacityTokens,
      remainingTokens: Math.max(0, capacityTokens * (100 - percent) / 100),
      confidence: 'measured'
    }
  }

  odometer () {
    let total = 0
    let turns = 0
    for (const r of this.rollouts) {
      // total_token_usage is already cumulative for that session
      total += r.parsed.totals.input + r.parsed.totals.cacheWrite + r.parsed.totals.output
      turns += r.parsed.events.length
    }
    const newest = this.newest()
    const trip = newest
      ? newest.parsed.totals.input + newest.parsed.totals.cacheWrite + newest.parsed.totals.output
      : 0
    return {
      total,
      turns,
      files: this.rollouts.length,
      trip,
      tripTurns: newest ? newest.parsed.events.length : 0,
      tripSessionId: newest && newest.parsed.meta ? newest.parsed.meta.sessionId : null
    }
  }

  liveSessions () {
    const now = Date.now()
    return this.rollouts
      .slice()
      .reverse()
      .map(r => {
        const meta = r.parsed.meta || {}
        const id = meta.sessionId || path.basename(r.file)
        return {
          pid: null,
          sessionId: meta.sessionId || null,
          // Codex has no session naming, so fall back to the folder being
          // worked in, which is what a name would have told you anyway.
          name: meta.cwd ? path.basename(meta.cwd) + '-' + String(id).slice(0, 4) : String(id).slice(0, 8),
          cwd: meta.cwd || null,
          // inferred from file mtime; Codex writes no liveness record
          status: now - r.mtimeMs < BUSY_WINDOW_MS ? 'busy' : 'idle',
          kind: 'cli',
          updatedAt: r.mtimeMs,
          startedAt: meta.startedAt || null,
          model: r.parsed.model || null
        }
      })
  }

  read () {
    const now = Date.now()
    const newest = this.newest()
    const parsed = newest ? newest.parsed : null
    const limits = parsed && parsed.rateLimits ? parsed.rateLimits : null
    const primary = limits && limits.primary ? limits.primary : null
    const secondary = limits && limits.secondary ? limits.secondary : null

    const windowFrom = (win, label) => {
      if (!win) {
        return {
          percent: null,
          source: 'unsupported',
          confidence: 'unknown',
          resetsAt: null,
          spend: 0,
          label
        }
      }
      return {
        percent: Math.min(100, Math.max(0, win.used_percent || 0)),
        source: 'official',
        confidence: 'exact',
        anchorAt: now,
        resetsAt: win.resets_at ? win.resets_at * 1000 : null,
        label
      }
    }

    // ChatGPT plans report one weekly window; there is no 5-hour equivalent,
    // so that gauge is explicitly marked unsupported rather than shown as 0.
    const weekly = primary && primary.window_minutes >= 1440 ? primary : null
    const shortWindow = secondary || (primary && primary.window_minutes < 1440 ? primary : null)

    const odo = this.odometer()
    const fiveHour = windowFrom(shortWindow, '5-hour')
    const sevenDay = windowFrom(weekly, 'This week')

    const shortSpan = shortWindow && shortWindow.window_minutes
      ? shortWindow.window_minutes * 60 * 1000
      : 5 * 60 * 60 * 1000
    const weeklySpan = weekly && weekly.window_minutes
      ? weekly.window_minutes * 60 * 1000
      : SEVEN_DAYS_MS

    const fiveHourTally = this.windowTally(Date.now() - shortSpan)
    const sevenDayTally = this.windowTally(Date.now() - weeklySpan)
    const lifetime = this.windowTally(0)

    return {
      at: now,
      vendorId: 'openai',
      fiveHour,
      sevenDay,
      spend: { fiveHour: fiveHourTally.cost, sevenDay: sevenDayTally.cost },
      budget: {
        fiveHour: this.budgetFor(fiveHour, shortSpan),
        sevenDay: this.budgetFor(sevenDay, weeklySpan),
        lifetime: { usedTokens: odo.total, turns: odo.turns }
      },
      // ChatGPT plans bill a flat subscription, so these dollars are what the
      // same tokens would have cost on the API — a scale for the work done, not
      // an invoice. On an API key it is the invoice.
      cost: {
        fiveHour: fiveHourTally.cost,
        sevenDay: sevenDayTally.cost,
        lifetime: lifetime.cost,
        official: null,
        plan: prettyPlan(limits ? limits.plan_type : null),
        pricing: priceMeta('openai')
      },
      weeklyScoped: null,
      tokensPerMinute: this.ratePerMinute(),
      calibrated: Boolean(primary),
      official: {
        lastAttempt: { at: this.lastScanAt, status: limits ? 'ok' : 'no_data' },
        nextPollAt: 0,
        backingOff: false,
        reason: limits ? null : 'no rate_limits recorded yet'
      },
      localEvents: odo.turns,
      account: { email: null, org: null },
      session: {
        version: parsed && parsed.meta ? parsed.meta.cliVersion : null,
        company: 'OpenAI',
        modelId: parsed ? parsed.model : null,
        model: prettyModel(parsed ? parsed.model : null),
        effort: parsed ? parsed.effort : null,
        plan: prettyPlan(limits ? limits.plan_type : null),
        cwd: parsed && parsed.meta ? parsed.meta.cwd : null,
        sessionName: null
      },
      // Codex's model lives in config.toml; this dashboard does not edit TOML,
      // so the picker is withheld rather than offered and silently broken.
      configuredModel: prettyModel(parsed ? parsed.model : null),
      configuredModelValue: parsed ? parsed.model : null,
      configuredModelFamily: null,
      modelOptions: [],
      liveSessions: this.liveSessions(),
      odometer: odo
    }
  }
}

module.exports = { CodexStore, prettyModel, prettyPlan, rolloutFiles }
