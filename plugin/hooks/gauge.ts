// Pure gauge logic: no `$`, so every edge case is testable with plain values.
// Every input here comes from the engine or from state an older version wrote,
// so nothing is trusted to be the shape its type says.
import type { Limit, Turn } from '../types'

export const RATE_WINDOW_MS = 10 * 60 * 1000
export const MAX_TURNS = 500
const MAX_TANKS = 4
const LABELS: Record<string, string> = { five_hour: '5H', seven_day: 'WK' }
const ORDER = ['five_hour', 'seven_day']

export type Tank = {
  kind: string
  label: string
  /** Percent of the window left, 0-100; null when unknown or the window reset. */
  left: number | null
  resetsInMs: number | null
  isReset: boolean
}

/** A token count from an untrusted field: anything but a finite positive number is 0. */
export const count = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

/** Only the fields kept, so state never holds whatever else the engine adds. */
export function toLimits (raw: unknown): Limit[] {
  if (!Array.isArray(raw)) return []
  const out: Limit[] = []
  for (const l of raw) {
    if (!l || typeof l !== 'object' || typeof l.kind !== 'string' || !l.kind) continue
    if (typeof l.percentUsed !== 'number' || !Number.isFinite(l.percentUsed)) continue
    out.push(typeof l.resetsAt === 'string'
      ? { kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }
      : { kind: l.kind, percentUsed: l.percentUsed })
  }
  return out
}

export function tanks (raw: unknown, now: number): Tank[] {
  const byKind = new Map<string, Limit>()
  for (const l of toLimits(raw)) byKind.set(l.kind, l) // a repeated kind: the last wins
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)
  return [...byKind.values()]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .slice(0, MAX_TANKS)
    .map(l => {
      const resetAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const hasReset = Number.isFinite(resetAt)
      // A reading taken before its window reset says nothing about the new one.
      const isReset = hasReset && now >= resetAt
      return {
        kind: l.kind,
        label: LABELS[l.kind] ?? l.kind.slice(0, 12),
        left: isReset ? null : Math.min(100, Math.max(0, 100 - l.percentUsed)),
        resetsInMs: hasReset && !isReset ? resetAt - now : null,
        isReset
      }
    })
}

/** The turns the rate window still needs, never more than MAX_TURNS. */
export const prune = (turns: readonly Turn[], now: number): Turn[] =>
  turns.filter(t => t.at > now - RATE_WINDOW_MS).slice(-MAX_TURNS)

/** Output tokens per minute over the trailing window. */
export function rate (turns: unknown, now: number): number {
  if (!Array.isArray(turns)) return 0
  let out = 0
  for (const t of turns) {
    if (t && t.at > now - RATE_WINDOW_MS && t.at <= now) out += count(t.output)
  }
  return out / (RATE_WINDOW_MS / 60000)
}

const oneDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, '')

/** 4,798,275 -> "4.8M". Thresholds sit where rounding would print "1000k". */
export function compact (n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 999.95e6) return oneDecimal(n / 1e9) + 'B'
  if (n >= 999.5e3) return oneDecimal(n / 1e6) + 'M'
  if (n >= 999.5) return Math.round(n / 1e3) + 'k'
  return String(Math.round(n))
}

export function countdown (ms: number): string {
  if (!Number.isFinite(ms) || ms < 60000) return '<1m'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor(m / 60) % 24
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

export function bar (left: number | null, width: number): string {
  const w = Math.min(40, Math.max(4, Math.floor(Number.isFinite(width) ? width : 10)))
  if (left === null) return '·'.repeat(w)
  const full = Math.round((left / 100) * w)
  return '█'.repeat(full) + '░'.repeat(w - full)
}

// Floor, so the gauge never claims headroom that is not there.
const reading = (t: Tank) => (t.isReset ? 'reset' : `${Math.floor(t.left ?? 0)}% left`)

/**
 * The dim tail after the prompt's hint line. Most important first, since the
 * terminal cuts it where the row ends; nothing at all when there is nothing to say.
 */
export function hintText (list: readonly Tank[], perMin: number): string | undefined {
  const parts = list.map(t => `${t.label} ${reading(t)}`)
  // The reset worth knowing is the tightest window's.
  const tight = list
    .filter(t => t.left !== null && t.resetsInMs !== null)
    .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))[0]
  if (tight) {
    parts.push(`${list.length > 1 ? tight.label + ' ' : ''}resets in ${countdown(tight.resetsInMs ?? 0)}`)
  }
  if (compact(perMin) !== '0') parts.push(`${compact(perMin)} tok/min`)
  return parts.length ? parts.join(' · ') : undefined
}

export function tankRow (t: Tank, width: number): string {
  const when = t.isReset
    ? 'window reset, waiting for the next reply'
    : t.resetsInMs === null ? '' : `resets in ${countdown(t.resetsInMs)}`
  return `${t.label.padEnd(4)} ${bar(t.left, width)} ${reading(t).padStart(9)}  ${when}`.trimEnd()
}
