'use strict'
const fs = require('fs')
const path = require('path')
const { LocalProvider, FIVE_HOURS_MS, SEVEN_DAYS_MS } = require('./providers/local')
const { OfficialProvider } = require('./providers/official')
const { readAccount } = require('./providers/account')
const { readSession } = require('./providers/session')
const { listSessions } = require('./providers/sessions')
const { detectVendors } = require('./providers/vendors')
const { readOdometer } = require('./providers/odometer')
const { readModel, labelFor, MODEL_OPTIONS, modelFamily } = require('./providers/settings')

// An anchor older than this is too stale to project from with a straight face.
const MAX_ANCHOR_AGE_MS = 90 * 60 * 1000
// Below this much spend, an anchor's implied rate is mostly noise.
const MIN_SPEND_FOR_CALIBRATION = 0.5
// Rolling average weight for newly observed rates.
const CALIBRATION_ALPHA = 0.35

const WINDOWS = {
  fiveHour: { spanMs: FIVE_HOURS_MS, label: '5-hour' },
  sevenDay: { spanMs: SEVEN_DAYS_MS, label: 'This week' }
}

const clampPercent = n => Math.min(100, Math.max(0, n))

class UsageStore {
  constructor ({ statePath }) {
    this.statePath = statePath
    this.local = new LocalProvider()
    this.official = new OfficialProvider()

    /** Last accepted official reading per window. */
    this.anchors = { fiveHour: null, sevenDay: null }
    /**
     * Percent-of-quota consumed per USD of local spend, learned by comparing an
     * official reading against the local spend in the same window. This is what
     * removes the need for a hand-configured quota baseline.
     */
    this.calibration = { fiveHour: null, sevenDay: null }
    this.lastOfficialAttempt = null

    this.load()
  }

  load () {
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (saved.anchors) this.anchors = { ...this.anchors, ...saved.anchors }
      if (saved.calibration) this.calibration = { ...this.calibration, ...saved.calibration }
    } catch { /* first run, or state we can safely discard */ }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify({
        anchors: this.anchors,
        calibration: this.calibration,
        savedAt: Date.now()
      }, null, 2))
    } catch { /* a widget must never die over a cache write */ }
  }

  refreshLocal () { this.local.scan() }

  /** Fold a successful official reading into the anchors and calibration. */
  ingestOfficial (result) {
    this.lastOfficialAttempt = { at: Date.now(), status: result.status, reason: result.reason }
    if (result.status !== 'ok') return false

    for (const key of Object.keys(WINDOWS)) {
      const reading = result[key]
      if (!reading) continue

      const windowStart = result.at - WINDOWS[key].spanMs
      const spendInWindow = this.local.spendSince(windowStart)

      // Learn the conversion only when there is enough spend for the ratio to
      // mean something, and when the window is not pinned at either extreme.
      if (spendInWindow >= MIN_SPEND_FOR_CALIBRATION &&
          reading.usedPercent > 1 && reading.usedPercent < 99.5) {
        const observed = reading.usedPercent / spendInWindow
        const prior = this.calibration[key]
        this.calibration[key] = prior === null
          ? observed
          : prior * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA
      }

      this.anchors[key] = {
        at: result.at,
        usedPercent: reading.usedPercent,
        resetsAt: reading.resetsAt
      }
    }

    this.save()
    return true
  }

  async pollOfficial (opts) {
    const result = await this.official.fetch(opts)
    this.ingestOfficial(result)
    return result
  }

  _resolveWindow (key) {
    const now = Date.now()
    const span = WINDOWS[key].spanMs
    const anchor = this.anchors[key]
    const rate = this.calibration[key]

    // The anchor is void once its own window has rolled over.
    const rolled = anchor && anchor.resetsAt && now >= anchor.resetsAt
    const stale = anchor && now - anchor.at > MAX_ANCHOR_AGE_MS
    const usableAnchor = anchor && !rolled && !stale ? anchor : null

    if (usableAnchor) {
      const delta = this.local.spendBetween(usableAnchor.at, now)
      if (rate === null || delta <= 0) {
        return {
          percent: clampPercent(usableAnchor.usedPercent),
          source: 'official',
          confidence: 'exact',
          anchorAt: usableAnchor.at,
          resetsAt: usableAnchor.resetsAt,
          deltaSpend: delta
        }
      }
      return {
        percent: clampPercent(usableAnchor.usedPercent + delta * rate),
        source: 'hybrid',
        confidence: 'projected',
        anchorAt: usableAnchor.at,
        resetsAt: usableAnchor.resetsAt,
        deltaSpend: delta
      }
    }

    // No usable anchor. Fall back to a pure local projection, measuring from
    // the most recent reset boundary. A rolled anchor's own resetsAt can be
    // several cycles behind if the official poll has been throttled for
    // longer than one window — using it as-is would keep summing spend across
    // resets that already happened, so the tank would look ever more used
    // instead of coming back to full when the window actually reopens.
    let windowStart = now - span
    let nextResetsAt = anchor ? anchor.resetsAt : null
    if (rolled && anchor.resetsAt) {
      const cyclesPassed = Math.floor((now - anchor.resetsAt) / span)
      windowStart = anchor.resetsAt + cyclesPassed * span
      nextResetsAt = windowStart + span
    }
    const spend = this.local.spendSince(windowStart)

    if (rate === null) {
      return {
        percent: null,
        source: 'uncalibrated',
        confidence: 'unknown',
        anchorAt: anchor ? anchor.at : null,
        resetsAt: nextResetsAt,
        spend
      }
    }
    return {
      percent: clampPercent(spend * rate),
      source: 'local',
      confidence: 'estimated',
      anchorAt: anchor ? anchor.at : null,
      resetsAt: nextResetsAt,
      spend
    }
  }

  /** The single object the renderer draws from. */
  read () {
    const now = Date.now()
    const localSnap = this.local.snapshot()
    return {
      at: now,
      account: readAccount(),
      session: readSession(),
      liveSessions: listSessions(),
      vendors: detectVendors(),
      odometer: readOdometer(),
      // what settings.json asks for, which may differ from what the running
      // session is actually using
      configuredModel: labelFor(readModel()),
      configuredModelValue: readModel(),
      configuredModelFamily: modelFamily(readModel()),
      modelOptions: MODEL_OPTIONS,
      fiveHour: { ...this._resolveWindow('fiveHour'), label: WINDOWS.fiveHour.label },
      sevenDay: { ...this._resolveWindow('sevenDay'), label: WINDOWS.sevenDay.label },
      spend: { fiveHour: localSnap.fiveHourSpend, sevenDay: localSnap.sevenDaySpend },
      // The percent-of-quota each unit of local spend is worth, so a reader can
      // be shown the share of the window it burned rather than the internal
      // weight itself. Null until an official reading has calibrated it.
      quotaRate: { fiveHour: this.calibration.fiveHour, sevenDay: this.calibration.sevenDay },
      // live consumption, which is what the speedometer reads
      tokensPerMinute: this.local.ratePerMinute(),
      calibrated: this.calibration.fiveHour !== null || this.calibration.sevenDay !== null,
      official: {
        lastAttempt: this.lastOfficialAttempt,
        nextPollAt: this.official.nextPollAt(),
        backingOff: this.official.backoffIndex >= 0,
        reason: this.official.lastError
      },
      localEvents: localSnap.events
    }
  }
}

module.exports = { UsageStore, MAX_ANCHOR_AGE_MS }
