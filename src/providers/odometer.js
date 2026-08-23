'use strict'
const fs = require('fs')
const path = require('path')

const { claudeProjects } = require('./paths')

/**
 * Odometer: lifetime token throughput across every transcript on disk, plus a
 * trip meter for the session currently in use.
 *
 * Cache reads are excluded, exactly as they are for the burn rate: they run
 * into the hundreds of millions (361M here against 24M of everything else) and
 * would make the reading meaningless. What is counted is what the model was
 * actually fed and produced: input + cache writes + output.
 *
 * A full pass over ~17MB of transcripts costs ~75ms, so the first read is
 * cheap enough to do inline; after that only files whose mtime or size moved
 * are re-read, which makes steady-state updates effectively free.
 */

/** @type {Map<string, {mtimeMs: number, size: number, offset: number,
 *                        tokens: number, turns: number}>} */
const cache = new Map()

/**
 * Tally the usage records in one slice of a transcript.
 *
 * @param {string} file
 * @param {number} from byte offset to start at, always a line boundary this
 *   function previously reported as consumed.
 * @returns {{tokens: number, turns: number, consumed: number}}
 */
function tallySlice (file, from) {
  let tokens = 0
  let turns = 0
  let text = ''
  let fd

  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const length = stat.size - from
    if (length <= 0) return { tokens, turns, consumed: from }
    const buffer = Buffer.allocUnsafe(length)
    // decode only the bytes actually read — the rest of the buffer is
    // uninitialised heap, not transcript
    const read = fs.readSync(fd, buffer, 0, length, from)
    if (read <= 0) return { tokens, turns, consumed: from }
    text = buffer.toString('utf8', 0, read)
  } catch {
    return { tokens, turns, consumed: from }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ }
  }

  // Stop at the last complete line: the file is appended to as we read it.
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { tokens, turns, consumed: from }
  const complete = text.slice(0, lastNewline)
  const consumed = from + Buffer.byteLength(complete, 'utf8') + 1

  // Every offset handed in is one this function itself stopped at, which is
  // always the first byte after a newline — so there is no leading fragment to
  // discard here, and discarding one would silently drop a real turn.
  for (const line of complete.split('\n')) {
    if (line.indexOf('"usage"') === -1) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const usage = record.message && record.message.usage
    if (!usage) continue
    turns++
    tokens +=
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.output_tokens || 0)
  }
  return { tokens, turns, consumed }
}

/**
 * The running total for one transcript.
 *
 * Transcripts are append-only, and the session in use is written to constantly,
 * so re-reading one whole on every tick meant re-parsing megabytes to learn what
 * the last few lines added. Only the appended bytes are read and the totals
 * carry forward. A file that shrank was rewritten rather than appended to, so
 * that one is counted again from the start.
 */
function entryFor (file) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }

  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached

  const resumable = Boolean(cached) && stat.size >= cached.offset
  const from = resumable ? cached.offset : 0
  const slice = tallySlice(file, from)

  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset: slice.consumed,
    tokens: (resumable ? cached.tokens : 0) + slice.tokens,
    turns: (resumable ? cached.turns : 0) + slice.turns
  }
  cache.set(file, entry)
  return entry
}

function transcripts () {
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
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (name.endsWith('.jsonl')) {
        out.push({ sessionId: name.slice(0, -6), file: path.join(dir, name) })
      }
    }
  }
  return out
}

/**
 * @returns {{total: number, turns: number, files: number,
 *            trip: number, tripTurns: number, tripSessionId: string|null}}
 */
function readOdometer () {
  let total = 0
  let turns = 0
  let files = 0

  let newest = null
  let newestMtime = -1

  const live = new Set()
  for (const { sessionId, file } of transcripts()) {
    live.add(file)
    const entry = entryFor(file)
    if (!entry) continue
    total += entry.tokens
    turns += entry.turns
    files++
    if (entry.mtimeMs > newestMtime) {
      newestMtime = entry.mtimeMs
      newest = { sessionId, entry }
    }
  }

  // Drop transcripts no longer on disk, or the cache grows for the life of the
  // process and keeps counting files that were deleted.
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)

  return {
    total,
    turns,
    files,
    // The trip meter follows the session being worked in right now, which is
    // the transcript most recently written to.
    trip: newest ? newest.entry.tokens : 0,
    tripTurns: newest ? newest.entry.turns : 0,
    tripSessionId: newest ? newest.sessionId : null
  }
}

module.exports = { readOdometer }
