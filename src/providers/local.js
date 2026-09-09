'use strict'
const fs = require('fs')
const path = require('path')

const { claudeProjects } = require('./paths')
const { costOf } = require('./pricing')

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
// Keep a day of slack past the weekly window so a late anchor can still be
// reconciled against local history.
const RETENTION_MS = SEVEN_DAYS_MS + 24 * 60 * 60 * 1000
// Trailing window for the live burn-rate needle. Short enough to react to work
// starting and stopping, long enough not to swing wildly between single turns.
const RATE_WINDOW_MS = 10 * 60 * 1000
// Most of a single transcript that is read on first sight. Eight days of one
// session's turns sits far below this; anything past it is history the
// retention window would discard on the very next prune.
const FIRST_READ_CAP = 32 * 1024 * 1024

// Pricing moved to providers/pricing.js: dollars are no longer only an internal
// weighting unit for the quota gauges — they are shown directly to anyone
// without a subscription to gauge — so every vendor has to price the same way.
// The subscription quota is still not published as a token count, so spend
// remains the proxy for "how much of the window did I burn": it is the only
// local signal that weights an Opus turn against a Haiku turn the way the real
// limiter does.

class LocalProvider {
  constructor () {
    /** @type {Map<string, {offset: number, inode: number|null, lastId: string|null}>} */
    this.cursors = new Map()
    /**
     * @type {Array<{ts: number, cost: number, output: number, tokens: number,
     *               model: string}>}
     * `tokens` is input + cache writes + output, matching the odometer's
     * definition, so a window's token count and the lifetime total are the
     * same measurement over different spans rather than two different ones.
     */
    this.events = []
    this.lastScanAt = 0
    this.scanError = null
  }

  _listTranscripts () {
    const out = []
    let projects
    try {
      projects = fs.readdirSync(claudeProjects(), { withFileTypes: true })
    } catch {
      return out
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = path.join(claudeProjects(), project.name)
      let entries
      try {
        entries = fs.readdirSync(dir)
      } catch { continue }
      for (const name of entries) {
        if (name.endsWith('.jsonl')) out.push(path.join(dir, name))
      }
    }
    return out
  }

  _ingestLine (line, state) {
    // Cheap prefilter: the vast majority of transcript lines are user turns,
    // tool results and metadata with no usage block at all.
    if (line.length < 40 || line.indexOf('"usage"') === -1) return
    let record
    try { record = JSON.parse(line) } catch { return }

    const usage = record.message && record.message.usage
    if (!usage) return

    // A response is written one line per content block — thinking, text,
    // tool_use — and each of those lines repeats the whole response's usage.
    // Charging for every line billed the same turn two or three times over.
    // They are always consecutive, so one id of memory is enough to collapse
    // them back into the single response they were.
    const id = record.message.id
    if (id && id === state.lastId) return
    if (id) state.lastId = id

    const ts = Date.parse(record.timestamp)
    if (Number.isNaN(ts)) return

    const model = (record.message && record.message.model) || ''
    // Synthetic/no-op turns carry a usage block with nothing in it.
    const cost = costOf(usage, model)
    if (cost <= 0) return

    // The speedometer reads OUTPUT tokens only. Cache reads (~1.9M/min) and
    // cache writes (measured at 97% of every other term combined, with single
    // turns writing 340k at once) are context bookkeeping, not generation —
    // including them made the needle report six-figure rates that swung wildly
    // depending on where one write burst fell in the window. Their cost is
    // still counted in full by `cost` above, which is what drives the tanks.
    const output = usage.output_tokens || 0

    // What the window's token readout counts. Cache reads are excluded here for
    // the same reason they are excluded from the rate and the odometer — they
    // run orders of magnitude above everything else and would drown the number
    // — so this is exactly the odometer's definition, restricted to a window.
    const tokens =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      output

    this.events.push({ ts, cost, output, tokens, model })
  }

  _readAppended (file) {
    let stat
    try { stat = fs.statSync(file) } catch { return }

    const cursor = this.cursors.get(file)
    let start = 0
    if (cursor) {
      // A recycled inode is a different file wearing the same path, so the
      // saved offset means nothing and the whole thing is read again.
      const sameFile = cursor.inode === null || cursor.inode === (stat.ino ?? null)
      if (sameFile) {
        if (stat.size === cursor.offset) return               // untouched
        if (stat.size > cursor.offset) start = cursor.offset   // appended
        // stat.size < offset means rotated or rewritten; re-read from zero.
      }
    } else if (stat.size > FIRST_READ_CAP) {
      // First sight of a long transcript. Only the retention window is ever
      // used, so reading a hundred megabytes of history costs memory for
      // nothing — start near the end and drop the partial first line.
      start = stat.size - FIRST_READ_CAP
    }

    let fd
    try { fd = fs.openSync(file, 'r') } catch { return }
    try {
      const length = stat.size - start
      if (length <= 0) return
      const buffer = Buffer.allocUnsafe(length)
      // readSync can return fewer bytes than asked for — a file truncated under
      // us is the ordinary case. Decoding the whole buffer regardless would
      // push uninitialised heap memory through the JSON parser.
      const read = fs.readSync(fd, buffer, 0, length, start)
      if (read <= 0) return
      const text = buffer.toString('utf8', 0, read)

      // A transcript is appended to while we read it; the trailing fragment may
      // be a partial line. Stop at the last newline and resume from there.
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline === -1) return
      const complete = text.slice(0, lastNewline)
      const consumed = Buffer.byteLength(complete, 'utf8') + 1

      const lines = complete.split('\n')
      // the first line is a fragment whenever we started at an offset we chose
      // rather than one we previously stopped at
      if (start > 0 && !cursor) lines.shift()
      // The id only carries forward when this really is a continuation of the
      // same file; a re-read from the top starts with no memory of a response.
      const state = { lastId: start > 0 && cursor ? cursor.lastId || null : null }
      for (const line of lines) this._ingestLine(line, state)
      this.cursors.set(file, {
        offset: start + consumed,
        inode: stat.ino ?? null,
        lastId: state.lastId
      })
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Incrementally ingest anything appended since the last call. */
  scan () {
    try {
      for (const file of this._listTranscripts()) this._readAppended(file)
      this.scanError = null
    } catch (err) {
      this.scanError = err.message
    }
    // Sort before pruning: transcripts are read in directory order, so the
    // array is not chronological until now and events[0] says nothing about
    // the oldest entry.
    this.events.sort((a, b) => a.ts - b.ts)
    const cutoff = Date.now() - RETENTION_MS
    let drop = 0
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++
    if (drop > 0) this.events = this.events.slice(drop)
    this.lastScanAt = Date.now()
    return this
  }

  /** Spend in USD inside a trailing window ending now. */
  spendSince (sinceMs) {
    let total = 0
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].ts < sinceMs) break
      total += this.events[i].cost
    }
    return total
  }

  /** Output tokens per minute across the trailing rate window. */
  ratePerMinute () {
    const since = Date.now() - RATE_WINDOW_MS
    let tokens = 0
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].ts < since) break
      tokens += this.events[i].output || 0
    }
    return tokens / (RATE_WINDOW_MS / 60000)
  }

  spendBetween (fromMs, toMs) {
    let total = 0
    for (const e of this.events) {
      if (e.ts >= fromMs && e.ts <= toMs) total += e.cost
    }
    return total
  }

  /**
   * Tokens and dollars inside an explicit window, plus how much of that window
   * this machine can actually vouch for.
   *
   * `covered` matters. Retention holds eight days, so a weekly window is fully
   * covered — but a fresh install, or a machine that was off for part of the
   * window, has transcripts for only part of it. Reporting "12k tokens this
   * week" off two days of history, as though it were the whole week, is the
   * kind of wrong number that looks right. The caller gets the coverage and
   * says so.
   */
  windowTally (fromMs, toMs = Date.now()) {
    let tokens = 0
    let cost = 0
    let turns = 0
    for (const e of this.events) {
      if (e.ts < fromMs || e.ts > toMs) continue
      tokens += e.tokens || 0
      cost += e.cost
      turns++
    }

    const span = Math.max(1, toMs - fromMs)
    // History reaches back to the oldest event we still hold, but never further
    // than retention allows regardless of what is on disk.
    const horizon = Math.max(
      fromMs,
      Math.min(toMs, Date.now() - RETENTION_MS),
      this.events.length ? Math.min(this.events[0].ts, toMs) : fromMs
    )
    const covered = Math.min(1, Math.max(0, (toMs - horizon) / span))

    return { tokens, cost, turns, from: fromMs, to: toMs, covered }
  }

  /** Tokens inside a trailing window ending now. */
  tokensSince (sinceMs) {
    return this.windowTally(sinceMs).tokens
  }

  snapshot () {
    const now = Date.now()
    return {
      at: now,
      fiveHourSpend: this.spendSince(now - FIVE_HOURS_MS),
      sevenDaySpend: this.spendSince(now - SEVEN_DAYS_MS),
      events: this.events.length,
      oldestEventAt: this.events.length ? this.events[0].ts : null,
      error: this.scanError
    }
  }
}

module.exports = {
  LocalProvider, costOf, FIVE_HOURS_MS, SEVEN_DAYS_MS, RATE_WINDOW_MS, RETENTION_MS
}
