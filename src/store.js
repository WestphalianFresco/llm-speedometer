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
const { priceMeta: pricingMeta } = require('./providers/pricing')

// An anchor older than this is too stale to project from with a straight face.
const MAX_ANCHOR_AGE_MS = 90 * 60 * 1000
// Below this much spend, an anchor's implied rate is mostly noise.
const MIN_SPEND_FOR_CALIBRATION = 0.5
// Rolling average weight for newly observed rates.
const CALIBRATION_ALPHA = 0.35
/**
 * Floor for turning a percentage into a token capacity.
 *
 * capacity = tokens / (percent/100), so the divisor is the whole game: at 13%
 * every 1% the endpoint rounds away moves the answer by ~8%, and at 2% it moves
 * it by half. The percentages arrive as whole numbers, so below this floor the
 * division amplifies rounding into a figure with no information in it — the
 * budget says "not enough of the window burned yet" instead of inventing one.
 */
const MIN_PERCENT_FOR_BUDGET = 8
/**
 * A window's token count only means something next to its percentage if local
 * history covers the window. Two days of transcripts against a seven-day window
 * would imply a capacity nearly four times too small.
 */
const MIN_COVERAGE_FOR_BUDGET = 0.98

const WINDOWS = {
  fiveHour: { spanMs: FIVE_HOURS_MS, label: '5-hour' },
  sevenDay: { spanMs: SEVEN_DAYS_MS, label: 'This week' },
  // The per-model weekly cap. Same span as the all-model week and it resets
  // with it, but it fills at its own rate and can stop you on its own.
  weeklyScoped: { spanMs: SEVEN_DAYS_MS, label: 'Week / model' }
}

const clampPercent = n => Math.min(100, Math.max(0, n))

/**
 * When a window actually opened.
 *
 * These windows are fixed, not trailing: the weekly one resets at a wall-clock
 * moment the endpoint reports, and `resets_at - span` is where it began.
 * Counting back seven days from *now* instead was wrong by however far the
 * reset still is — three days out of seven on a window resetting Friday — and
 * every one of those extra days' tokens was being folded into "this week" and
 * into the rate learned from it. With no reset known, the trailing span is
 * still the best available guess.
 */
function windowStart (resetsAt, spanMs, now = Date.now()) {
  if (!resetsAt) return now - spanMs
  // A reset already in the past means the window rolled over while we were not
  // looking; walk it forward to the cycle we are actually in.
  const start = resetsAt <= now
    ? resetsAt + Math.floor((now - resetsAt) / spanMs) * spanMs
    : resetsAt - spanMs
  return Math.min(start, now)
}

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
    this.calibration = { fiveHour: null, sevenDay: null, weeklyScoped: null }
    /**
     * Tokens per percent of quota, learned the same way as `calibration` but in
     * token space. This is what turns the endpoint's bare percentage into the
     * token budget the gauges report — there is no token count anywhere in the
     * payload, so the only way to name one is to measure how many tokens this
     * machine burned to move the percentage.
     */
    this.tokenCalibration = { fiveHour: null, sevenDay: null, weeklyScoped: null }
    /** Real money: credits burned past the plan, straight from the endpoint. */
    this.officialSpend = null
    this.lastOfficialAttempt = null

    this.load()
  }

  load () {
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (saved.anchors) this.anchors = { ...this.anchors, ...saved.anchors }
      if (saved.calibration) this.calibration = { ...this.calibration, ...saved.calibration }
      if (saved.tokenCalibration) {
        this.tokenCalibration = { ...this.tokenCalibration, ...saved.tokenCalibration }
      }
      if (saved.officialSpend) this.officialSpend = saved.officialSpend
    } catch { /* first run, or state we can safely discard */ }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify({
        anchors: this.anchors,
        calibration: this.calibration,
        tokenCalibration: this.tokenCalibration,
        officialSpend: this.officialSpend,
        savedAt: Date.now()
      }, null, 2))
    } catch { /* a widget must never die over a cache write */ }
  }

  refreshLocal () { this.local.scan() }

  /** Fold a successful official reading into the anchors and calibration. */
  ingestOfficial (result) {
    this.lastOfficialAttempt = { at: Date.now(), status: result.status, reason: result.reason }
    if (result.status !== 'ok') return false

    if (result.spend) this.officialSpend = { ...result.spend, at: result.at }

    for (const key of Object.keys(WINDOWS)) {
      const reading = result[key]
      if (!reading) continue

      // Aligned to the window the endpoint is actually reporting on, not to a
      // span trailing back from now. Those are the same thing only at the
      // instant a window resets; the rest of the time the trailing version
      // swept in work from the *previous* window and inflated the divisor.
      const start = windowStart(reading.resetsAt, WINDOWS[key].spanMs, result.at)
      const tally = this.local.windowTally(start, result.at)

      // Learn the conversion only when there is enough spend for the ratio to
      // mean something, and when the window is not pinned at either extreme.
      const usable = reading.usedPercent > 1 && reading.usedPercent < 99.5
      if (usable && tally.cost >= MIN_SPEND_FOR_CALIBRATION) {
        const observed = reading.usedPercent / tally.cost
        const prior = this.calibration[key]
        this.calibration[key] = prior === null
          ? observed
          : prior * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA
      }

      // Same idea in token space, held to a stricter bar: a capacity figure is
      // read as a real number of tokens, so it may only be learned from a
      // window this machine has full history for and that has burned enough
      // percent for the division to be stable.
      if (usable && tally.tokens > 0 &&
          reading.usedPercent >= MIN_PERCENT_FOR_BUDGET &&
          tally.covered >= MIN_COVERAGE_FOR_BUDGET) {
        const observed = tally.tokens / reading.usedPercent
        const prior = this.tokenCalibration[key]
        this.tokenCalibration[key] = prior === null
          ? observed
          : prior * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA
      }

      this.anchors[key] = {
        at: result.at,
        usedPercent: reading.usedPercent,
        resetsAt: reading.resetsAt,
        scope: reading.scope || null
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
    const start = windowStart(anchor ? anchor.resetsAt : null, span, now)
    const nextResetsAt = anchor && anchor.resetsAt ? start + span : null
    const spend = this.local.spendSince(start)

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

  /**
   * A window expressed in tokens rather than percent.
   *
   * The endpoint reports no token count and no dollar figure — every
   * `*_dollars` field comes back null on a subscription — so the only route to
   * "how many tokens is this week" is to measure what this machine burned and
   * divide by the share of the window the endpoint says that represents.
   *
   * `used` is measured, `remaining` is derived. They are deliberately not two
   * halves of one subtraction: `remaining` leans on the official percentage,
   * which is exact and accounts for work done on other machines, while `used`
   * is only ever what these transcripts prove. When those disagree the gap is
   * real information, so both are reported and `covered` says how much of the
   * window the local half can actually vouch for.
   */
  _budget (key, resolved) {
    const now = Date.now()
    const span = WINDOWS[key].spanMs
    const start = windowStart(resolved.resetsAt, span, now)
    const tally = this.local.windowTally(start, now)
    const perPercent = this.tokenCalibration[key]
    const percent = resolved.percent

    const base = {
      windowStart: start,
      resetsAt: resolved.resetsAt,
      usedTokens: tally.tokens,
      usedCost: tally.cost,
      turns: tally.turns,
      covered: tally.covered
    }

    if (perPercent === null || percent === null) {
      return { ...base, capacityTokens: null, remainingTokens: null, confidence: 'unknown' }
    }

    const capacityTokens = perPercent * 100
    return {
      ...base,
      capacityTokens,
      // From the percentage rather than from capacity minus used, so a machine
      // that missed part of the window still reports the right headroom.
      remainingTokens: Math.max(0, capacityTokens * (100 - clampPercent(percent)) / 100),
      // 'measured' means an official percentage and a window this machine
      // covers in full; 'carried' means the same official percentage against a
      // rate learned earlier; 'projected' means even the percentage is a local
      // estimate, so the token figure inherits that uncertainty rather than
      // presenting itself as the firmest of the three.
      confidence: resolved.source !== 'official' && resolved.source !== 'hybrid'
        ? 'projected'
        : (tally.covered >= MIN_COVERAGE_FOR_BUDGET && percent >= MIN_PERCENT_FOR_BUDGET
            ? 'measured'
            : 'carried')
    }
  }

  /** The single object the renderer draws from. */
  read () {
    const now = Date.now()
    const localSnap = this.local.snapshot()
    const odometer = readOdometer()
    const fiveHour = { ...this._resolveWindow('fiveHour'), label: WINDOWS.fiveHour.label }
    const sevenDay = { ...this._resolveWindow('sevenDay'), label: WINDOWS.sevenDay.label }
    // The per-model cap is reported only while an official reading still
    // stands. _resolveWindow would happily project it forward from local spend
    // the way it does the other two, but that spend is every model's, and what
    // moves this window is one model's share of it — which these transcripts do
    // not separate. Projecting an Opus cap through an hour of Haiku work
    // invents a number that climbs while the real cap sits still.
    const scopedResolved = this.anchors.weeklyScoped
      ? this._resolveWindow('weeklyScoped')
      : null
    const scoped = scopedResolved && scopedResolved.source === 'official'
      ? { ...scopedResolved, label: WINDOWS.weeklyScoped.label,
          scope: this.anchors.weeklyScoped.scope }
      : null
    return {
      at: now,
      account: readAccount(),
      session: readSession(),
      liveSessions: listSessions(),
      vendors: detectVendors(),
      odometer,
      // what settings.json asks for, which may differ from what the running
      // session is actually using
      configuredModel: labelFor(readModel()),
      configuredModelValue: readModel(),
      configuredModelFamily: modelFamily(readModel()),
      modelOptions: MODEL_OPTIONS,
      fiveHour,
      sevenDay,
      // Only present once the endpoint has actually reported a per-model cap;
      // an account without one gets no half-drawn gauge for it.
      weeklyScoped: scoped,
      spend: { fiveHour: localSnap.fiveHourSpend, sevenDay: localSnap.sevenDaySpend },
      // The percent-of-quota each unit of local spend is worth, so a reader can
      // be shown the share of the window it burned rather than the internal
      // weight itself. Null until an official reading has calibrated it.
      quotaRate: { fiveHour: this.calibration.fiveHour, sevenDay: this.calibration.sevenDay },
      /**
       * The same windows counted in tokens, which is the unit anyone actually
       * asking "how much have I got left this week" has in mind. `lifetime` is
       * the odometer, so the three readouts — this window, what is left of it,
       * and everything ever — come from one definition of a token.
       */
      budget: {
        fiveHour: this._budget('fiveHour', fiveHour),
        sevenDay: this._budget('sevenDay', sevenDay),
        lifetime: { usedTokens: odometer.total, turns: odometer.turns }
      },
      /**
       * Dollars. On a subscription this is a weighting unit that happens to be
       * denominated in money; without one it is the bill. `official` is the
       * genuine article either way — credits the endpoint says were charged.
       */
      cost: {
        fiveHour: localSnap.fiveHourSpend,
        sevenDay: localSnap.sevenDaySpend,
        lifetime: null,
        official: this.officialSpend,
        pricing: pricingMeta('anthropic')
      },
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
