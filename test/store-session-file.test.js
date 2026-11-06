'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { UsageStore, SESSION_FILE_MAX_AGE_MS } = require('../src/store')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speedo-'))
const file = path.join(tmp, 'reading.json')
const NOW = Date.now()
const HOUR = 3600 * 1000
let n = 0

function make () {
  // a state file of its own per store: one carries anchors over from the last
  const store = new UsageStore({ statePath: path.join(tmp, `state-${n++}.json`), sessionFile: file })
  store.local.scan = () => {} // the transcripts on this machine are not the subject
  return store
}
const write = r => fs.writeFileSync(file, JSON.stringify(r))
const reading = (extra = {}) => ({
  v: 1, at: NOW, source: 'claude-code', tokensPerMinute: 96,
  fiveHour: { percentLeft: null, resetsAt: null },
  sevenDay: { percentLeft: 87, resetsAt: NOW + 10 * HOUR },
  ...extra
})

test('a fresh session file anchors the week, and only the windows it has', () => {
  const store = make()
  write(reading())
  store.refreshLocal()
  assert.equal(store.anchors.sevenDay.usedPercent, 13)
  assert.equal(store.anchors.sevenDay.resetsAt, NOW + 10 * HOUR)
  assert.equal(store.anchors.sevenDay.at, NOW)
  assert.equal(store.anchors.fiveHour, null)
  const week = store._resolveWindow('sevenDay')
  assert.equal(week.source, 'official')
  assert.equal(week.percent, 13)
  assert.equal(store.lastOfficialAttempt.status, 'ok')
})

test('an unchanged file is read once; a rewritten one moves the anchor', () => {
  const store = make()
  write(reading())
  assert.equal(store.ingestSessionFile(), true)
  assert.equal(store.ingestSessionFile(), false)
  fs.utimesSync(file, new Date(NOW + 1000), new Date(NOW + 1000))
  write(reading({ at: NOW + 1000, sevenDay: { percentLeft: 80, resetsAt: NOW + 10 * HOUR } }))
  assert.equal(store.ingestSessionFile(), true)
  assert.equal(store.anchors.sevenDay.usedPercent, 20)
})

test('a stale file, junk, and a file older than the anchor change nothing', () => {
  const store = make()
  write(reading({ at: NOW - SESSION_FILE_MAX_AGE_MS - 1 }))
  assert.equal(store.ingestSessionFile(), false)
  for (const junk of ['nope', 'null', JSON.stringify({ v: 2, at: NOW, source: 'claude-code' }),
    JSON.stringify(reading({ source: 'someone-else' })),
    JSON.stringify(reading({ sevenDay: { percentLeft: '87' }, fiveHour: null }))]) {
    fs.writeFileSync(file, junk)
    store.sessionFileMtime = null
    assert.equal(store.ingestSessionFile(), false, junk.slice(0, 30))
  }
  assert.equal(store.anchors.sevenDay, null)

  store.anchors.sevenDay = { at: NOW + 5000, usedPercent: 50, resetsAt: null, scope: null }
  write(reading())
  store.sessionFileMtime = null
  assert.equal(store.ingestSessionFile(), false)
  assert.equal(store.anchors.sevenDay.usedPercent, 50)
})

test('percent left past the ends is clamped', () => {
  const store = make()
  write(reading({ sevenDay: { percentLeft: 130, resetsAt: null }, fiveHour: { percentLeft: -5, resetsAt: 'soon' } }))
  store.refreshLocal()
  assert.equal(store.anchors.sevenDay.usedPercent, 0)
  assert.equal(store.anchors.fiveHour.usedPercent, 100)
  assert.equal(store.anchors.fiveHour.resetsAt, null)
})
