'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const { claudeProjects, claudeSessions } = require('./paths')

// Enough of a transcript tail to find the last real assistant turn even when a
// single record is very large.
const TAIL_BYTES = 256 * 1024

/**
 * Is this process still running?
 *
 * Signal 0 performs the permission/existence check without delivering anything.
 * EPERM means the process exists but belongs to someone else — still alive.
 */
function isAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** sessionId -> transcript path. Transcript filenames are the session id. */
function transcriptIndex () {
  const index = new Map()
  let projects
  try {
    projects = fs.readdirSync(claudeProjects(), { withFileTypes: true })
  } catch {
    return index
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(claudeProjects(), project.name)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (name.endsWith('.jsonl')) index.set(name.slice(0, -6), path.join(dir, name))
    }
  }
  return index
}

// Reading a tail per session on every tick would be wasteful, and a transcript
// only changes model when it is written to — so key the cache on mtime.
const modelCache = new Map()

function modelOf (file) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }

  const cached = modelCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.model

  let text = ''
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const length = stat.size - start
    if (length > 0) {
      const buffer = Buffer.allocUnsafe(length)
      fs.readSync(fd, buffer, 0, length, start)
      text = buffer.toString('utf8')
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ }
  }

  let model = null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].indexOf('"model"') === -1) continue
    let record
    try { record = JSON.parse(lines[i]) } catch { continue }
    if (record.isSidechain) continue
    if (record.message && record.message.model) { model = record.message.model; break }
  }

  modelCache.set(file, { mtimeMs: stat.mtimeMs, model })
  return model
}

/**
 * Live Claude Code sessions, newest activity first.
 *
 * Session files outlive the processes that wrote them, so every entry is
 * checked against its pid — a stale file is not a running window.
 */
function listSessions () {
  let names
  try {
    names = fs.readdirSync(claudeSessions()).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  const index = transcriptIndex()
  const out = []

  for (const name of names) {
    let data
    try {
      data = JSON.parse(fs.readFileSync(path.join(claudeSessions(), name), 'utf8'))
    } catch {
      continue // mid-write file
    }
    if (!isAlive(data.pid)) continue

    const transcript = index.get(data.sessionId)
    out.push({
      pid: data.pid,
      sessionId: data.sessionId || null,
      name: data.name || null,
      cwd: data.cwd || null,
      status: data.status || null,
      kind: data.kind || null,
      updatedAt: data.updatedAt || data.startedAt || null,
      startedAt: data.startedAt || null,
      model: transcript ? modelOf(transcript) : null
    })
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out
}

module.exports = { listSessions, isAlive }
