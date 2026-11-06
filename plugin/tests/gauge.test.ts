import { expect, test } from 'claude-code/testing'

import {
  bar, compact, count, countdown, MAX_TURNS, prune, rate, RATE_WINDOW_MS,
  hintText, tankRow, tanks, toLimits
} from '../hooks/gauge'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3600 * 1000

test('compact: every boundary rounds up a unit instead of printing 1000k or 1000M', () => {
  for (const [n, out] of [
    [0, '0'], [-5, '0'], [NaN, '0'], [Infinity, '0'],
    [999, '999'], [999.4, '999'], [999.5, '1k'], [12_345, '12k'],
    [999_499, '999k'], [999_500, '1M'], [4_798_275, '4.8M'],
    [999_949_999, '999.9M'], [999_950_000, '1B'], [1.5e9, '1.5B']
  ] as const) expect(compact(n)).toBe(out)
})

test('countdown: minutes, hours, days, and junk', () => {
  expect(countdown(0)).toBe('<1m')
  expect(countdown(59_999)).toBe('<1m')
  expect(countdown(60_000)).toBe('1m')
  expect(countdown(HOUR)).toBe('1h 0m')
  expect(countdown(HOUR + 41 * 60_000 + 21_000)).toBe('1h 41m')
  expect(countdown(60 * HOUR + 4 * 60_000)).toBe('2d 12h')
  expect(countdown(NaN)).toBe('<1m')
  expect(countdown(-5)).toBe('<1m')
})

test('bar: full, empty, unknown, and widths clamped to 4..40', () => {
  expect(bar(100, 10)).toBe('█'.repeat(10))
  expect(bar(0, 10)).toBe('░'.repeat(10))
  expect(bar(null, 10)).toBe('·'.repeat(10))
  expect(bar(50, 2)).toBe('██░░')
  expect(bar(50, 1000).length).toBe(40)
  expect(bar(50, -30).length).toBe(4)
  expect(bar(50, NaN).length).toBe(10)
})

test('count: only finite positive numbers count', () => {
  expect(count(5)).toBe(5)
  for (const junk of ['5', -1, NaN, Infinity, null, undefined, {}]) expect(count(junk)).toBe(0)
})

test('tanks: 5H then WK, percent left, reset countdown', () => {
  const list = tanks([
    { kind: 'seven_day', percentUsed: 9, resetsAt: iso(NOW + 10 * HOUR) },
    { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + HOUR) }
  ], NOW)
  expect(list.map(t => [t.label, t.left, t.resetsInMs, t.isReset]))
    .toEqual([['5H', 60, HOUR, false], ['WK', 91, 10 * HOUR, false]])
})

test('tanks: junk in, nothing invented out', () => {
  expect(tanks(undefined, NOW)).toEqual([])
  expect(tanks('nope', NOW)).toEqual([])
  expect(tanks([null, 7, {}, { kind: '' , percentUsed: 1 },
    { kind: 'five_hour' }, { kind: 'five_hour', percentUsed: NaN },
    { kind: 'five_hour', percentUsed: '40' }], NOW)).toEqual([])
})

test('tanks: past 100, below 0, bad dates, duplicates, long and many kinds', () => {
  const [spend] = tanks([{ kind: 'spend_limit', percentUsed: 130 }], NOW)
  expect(spend?.left).toBe(0)
  expect(tanks([{ kind: 'five_hour', percentUsed: -20 }], NOW)[0]?.left).toBe(100)

  const [bad] = tanks([{ kind: 'five_hour', percentUsed: 10, resetsAt: 'soon' }], NOW)
  expect([bad?.left, bad?.resetsInMs, bad?.isReset]).toEqual([90, null, false])

  const dup = tanks([{ kind: 'five_hour', percentUsed: 10 }, { kind: 'five_hour', percentUsed: 70 }], NOW)
  expect(dup.map(t => t.left)).toEqual([30])

  expect(tanks([{ kind: 'a_very_long_gateway_window_name', percentUsed: 1 }], NOW)[0]?.label)
    .toBe('a_very_long_')
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: `k${i}`, percentUsed: i }))
  expect(tanks(many, NOW).length).toBe(4)
})

test('tanks: a reading from before its reset is not shown as current', () => {
  const [t] = tanks([{ kind: 'five_hour', percentUsed: 95, resetsAt: iso(NOW - 1) }], NOW)
  expect([t?.left, t?.resetsInMs, t?.isReset]).toEqual([null, null, true])
  expect(hintText(t ? [t] : [], 0)).toBe('5H reset')
  expect(tankRow(t!, 10)).toContain('waiting for the next reply')
})

test('toLimits keeps only the three fields', () => {
  expect(toLimits([{ kind: 'five_hour', percentUsed: 1, resetsAt: 'x', secret: 'y' }]))
    .toEqual([{ kind: 'five_hour', percentUsed: 1, resetsAt: 'x' }])
})

test('hint: says nothing when idle with no reading, never rounds headroom up', () => {
  expect(hintText([], 0)).toBe(undefined)
  expect(hintText([], 0.4)).toBe(undefined)
  expect(hintText([], 96)).toBe('96 tok/min')
  const list = tanks([
    { kind: 'five_hour', percentUsed: 0.4 },
    { kind: 'seven_day', percentUsed: 9.5 }
  ], NOW)
  expect(hintText(list, 1234)).toBe('5H 99% left · WK 90% left · 1k tok/min')
  expect(tankRow(list[0]!, 10)).toBe(`5H   ${'█'.repeat(10)}  99% left`)
})

test('hint: one window, then two, the reset shown is the tightest one', () => {
  const wk = { kind: 'seven_day', percentUsed: 11, resetsAt: iso(NOW + 10 * HOUR + 31 * 60_000) }
  expect(hintText(tanks([wk], NOW), 0)).toBe('WK 89% left · resets in 10h 31m')
  expect(hintText(tanks([wk], NOW), 96)).toBe('WK 89% left · resets in 10h 31m · 96 tok/min')
  const h5 = { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + HOUR) }
  expect(hintText(tanks([wk, h5], NOW), 0)).toBe('5H 60% left · WK 89% left · 5H resets in 1h 0m')
  const tightWeek = { ...wk, percentUsed: 95 }
  expect(hintText(tanks([tightWeek, h5], NOW), 0)).toBe('5H 60% left · WK 5% left · WK resets in 10h 31m')
})

test('rate: trailing ten minutes only, junk ignored', () => {
  const turns = [
    { at: NOW - RATE_WINDOW_MS - 1, output: 1e6, tokens: 0 }, // too old
    { at: NOW - 60_000, output: 3000, tokens: 0 },
    { at: NOW, output: 2000, tokens: 0 },
    { at: NOW + 1, output: 1e6, tokens: 0 }, // from a clock that jumped back
    { at: NOW - 1, output: NaN, tokens: 0 }
  ]
  expect(rate(turns, NOW)).toBe(500)
  expect(rate('nope', NOW)).toBe(0)
  expect(rate([], NOW)).toBe(0)
})

test('stress: 20k turns stay bounded and fast', { timeoutMs: 20_000 }, () => {
  const started = Date.now()
  let list: { at: number; output: number; tokens: number }[] = []
  for (let i = 0; i < 20_000; i++) {
    const now = NOW + i * 100
    list = prune([...list, { at: now, output: 10, tokens: 10 }], now)
    if (list.length > MAX_TURNS) throw new Error(`grew to ${list.length}`)
  }
  expect(list.length).toBe(MAX_TURNS)
  const end = NOW + 19_999 * 100
  expect(rate(list, end)).toBe((MAX_TURNS * 10) / 10)
  // Old turns age out entirely once the window passes.
  expect(prune(list, end + RATE_WINDOW_MS)).toEqual([])
  expect(Date.now() - started).toBeLessThan(5000)
})

test('the payload a real session reported on 11-05: one window, no five_hour', () => {
  const real = [{ kind: 'seven_day', percentUsed: 10, resetsAt: '2026-11-06T15:00:00.000Z' }]
  const at = Date.parse('2026-11-06T03:00:00.000Z')
  const list = tanks(real, at)
  expect(hintText(list, rate([{ at, output: 4, tokens: 26_636 }], at))).toBe('WK 90% left · resets in 12h 0m')
  expect(tankRow(list[0]!, 10)).toBe(`WK   ${'█'.repeat(9)}░  90% left  resets in 12h 0m`)
})
