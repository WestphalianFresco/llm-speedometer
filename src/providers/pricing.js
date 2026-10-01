'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * One price list, shared by every provider.
 *
 * This used to live inside local.js as an Anthropic-only table, which was fine
 * while dollars were only ever an internal weighting unit for the quota gauges.
 * They are not any more: someone without a subscription has no quota to gauge,
 * and the only honest reading for them is what the tokens actually cost. That
 * number has to be computed the same way for every vendor, so the table moved
 * here and every store reads it.
 *
 * Rates are USD per million tokens. `asOf` is the date each block was last
 * checked against the vendor's published pricing — a stale price is still a
 * useful estimate, but the UI says how old it is rather than implying the
 * figure is authoritative forever.
 *
 * `cacheRead` is optional: a model's cache-hit price as a multiple of its own
 * input rate, for the models that left the usual 0.1x. It matters more than it
 * looks — cache reads are most of the input on an agentic session, so pricing
 * Fable 5.1's at 0.1x instead of its real 0.025x made every turn's cached
 * input cost four times what it was billed.
 */

const TABLE = {
  anthropic: {
    asOf: '2026-09-30',
    source: 'https://claude.com/pricing',
    // Ordered: the first pattern that matches wins, so put narrow before broad.
    models: [
      [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.025 }],
      [/^claude-(fable|mythos)-5/, { input: 10, output: 50 }],
      // Opus 5.5 is the first Opus to drop in price; every earlier 4.5+ Opus
      // is still 5/25, which is what the broad pattern below charges.
      [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.05 }],
      [/^claude-opus-/, { input: 5, output: 25 }],
      // Sonnet 5 dropped to 2/10 and Sonnet 5.5 kept it; 4.6 and earlier
      // stayed at 3/15. Matching all Sonnets at 3/15 overpriced every Sonnet
      // turn by 50%, which fed straight into the learned percent-per-dollar
      // rate and skewed the tanks.
      [/^claude-sonnet-5/, { input: 2, output: 10 }],
      [/^claude-sonnet-/, { input: 3, output: 15 }],
      [/^claude-haiku-/, { input: 1, output: 5 }]
    ],
    fallback: { input: 5, output: 25 }
  },
  openai: {
    asOf: '2026-09-30',
    source: 'https://openai.com/api/pricing/',
    models: [
      [/^gpt-6-astra/, { input: 10, output: 50 }],
      [/^gpt-6\.1-sol/, { input: 2, output: 10, cacheRead: 0.05 }],
      [/^gpt-6-sol/, { input: 2, output: 10 }],
      [/^gpt-6-luna/, { input: 0.1, output: 0.5 }],
      [/^gpt-5\.6-sol/, { input: 4, output: 20 }],
      [/^gpt-5\.6-terra/, { input: 2, output: 12 }],
      [/^gpt-5\.6-luna/, { input: 0.2, output: 1.2 }],
      [/^gpt-5\.5/, { input: 5, output: 30 }],
      [/^gpt-5\.4-nano/, { input: 0.2, output: 1.25 }],
      [/^gpt-5\.4-mini/, { input: 0.75, output: 4.5 }],
      [/^gpt-5\.4/, { input: 2.5, output: 15 }],
      [/^gpt-5\.3-codex/, { input: 1.75, output: 14 }],
      // The original GPT-5 line, kept for rollouts recorded before the above.
      [/^gpt-5.*mini/, { input: 0.25, output: 2 }],
      [/^gpt-5/, { input: 1.25, output: 10 }],
      [/^o3/, { input: 2, output: 8 }],
      [/^gpt-4\.1.*mini/, { input: 0.4, output: 1.6 }],
      [/^gpt-4\.1/, { input: 2, output: 8 }]
    ],
    fallback: { input: 1.25, output: 10 }
  },
  google: {
    asOf: '2026-09-30',
    source: 'https://ai.google.dev/pricing',
    // Pro rates are the <=200k-prompt tier. 3.6-3.8 Flash are on launch
    // pricing that Google says doubles to 1.50/7.50 on 2027-01-01.
    models: [
      [/^gemini-3\.[678]-flash/, { input: 0.75, output: 3.75 }],
      [/^gemini-3\.5-flash-lite/, { input: 0.3, output: 2.5 }],
      [/^gemini-3\.5-flash/, { input: 1.5, output: 9 }],
      [/^gemini-3\.1-flash-lite/, { input: 0.25, output: 1.5 }],
      [/^gemini-3\.1-pro/, { input: 2, output: 12 }],
      [/^gemini-2\.5-flash-lite/, { input: 0.1, output: 0.4 }],
      [/^gemini-.*flash/, { input: 0.3, output: 2.5 }],
      [/^gemini-.*pro/, { input: 1.25, output: 10 }]
    ],
    fallback: { input: 1.25, output: 10 }
  }
}

/**
 * Cache multipliers, relative to that model's base input rate.
 *
 * The write multipliers are Anthropic's and hold across its whole line. The
 * read multiplier is the default for every vendor — 0.1x is also what OpenAI
 * and Google charge for most models — and a table entry's `cacheRead`
 * overrides it for the ones that differ.
 */
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2.0
const CACHE_READ = 0.1

/**
 * A user-supplied override, so a price this app got wrong or has not caught up
 * with can be corrected without editing the source or waiting for a release.
 *
 * Shape mirrors the table: `{ "<vendor>": { "<regex source>": {input, output, cacheRead?} } }`.
 * Nothing here can execute — the keys become RegExp patterns and the values are
 * coerced to finite numbers, so a hand-edited file cannot do more than
 * misprice a model.
 */
const OVERRIDE_FILE = () =>
  path.join(os.homedir(), '.llm-speedometer', 'pricing.json')

let overrideCache = { at: 0, value: null }
const OVERRIDE_TTL_MS = 60 * 1000

function overrides () {
  const now = Date.now()
  if (overrideCache.value && now - overrideCache.at < OVERRIDE_TTL_MS) {
    return overrideCache.value
  }
  let parsed = {}
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE(), 'utf8'))
    for (const [vendor, models] of Object.entries(raw)) {
      if (!TABLE[vendor] || !models || typeof models !== 'object') continue
      const list = []
      for (const [pattern, price] of Object.entries(models)) {
        const input = price && price.input
        const output = price && price.output
        // Typed and positive, not merely coercible. Number(null) is 0, and 0 is
        // finite and not negative — so a field left null in a hand-edited file
        // used to be accepted as a real price of zero, which silently costed
        // every turn at nothing. local.js drops zero-cost events, so the whole
        // spend pipeline went quiet while the UI still said "overridden".
        if (typeof input !== 'number' || typeof output !== 'number') continue
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue
        if (input <= 0 || output <= 0) continue
        let re
        try { re = new RegExp(pattern, 'i') } catch { continue }
        // Optional, and dropped rather than rejecting the entry when it is not
        // a multiplier in (0, 1]: a bad cacheRead falls back to the 0.1x default.
        const cacheRead = price.cacheRead
        const entry = { input, output }
        if (typeof cacheRead === 'number' && cacheRead > 0 && cacheRead <= 1) {
          entry.cacheRead = cacheRead
        }
        list.push([re, entry])
      }
      if (list.length) parsed[vendor] = list
    }
  } catch { parsed = {} }
  overrideCache = { at: now, value: parsed }
  return parsed
}

/**
 * @param {string} vendorId
 * @param {string} model
 * @returns {{input: number, output: number, exact: boolean}} `exact` is false
 *   when the model was not in the table and the vendor's fallback was used, so
 *   a caller can mark the figure as a guess rather than a quote.
 */
function priceFor (vendorId, model) {
  const vendor = TABLE[vendorId] || TABLE.anthropic
  const id = String(model || '').toLowerCase()

  for (const [pattern, price] of overrides()[vendorId] || []) {
    if (pattern.test(id)) return { ...price, exact: true }
  }
  if (id) {
    for (const [pattern, price] of vendor.models) {
      if (pattern.test(id)) return { ...price, exact: true }
    }
  }
  return { ...vendor.fallback, exact: false }
}

/**
 * Cost in USD of one usage block, in Anthropic's transcript shape.
 *
 * @param {object} usage
 * @param {string} model
 * @param {string} [vendorId]
 */
function costOf (usage, model, vendorId = 'anthropic') {
  const price = priceFor(vendorId, model)
  const cacheCreation = usage.cache_creation || {}
  const write5m = cacheCreation.ephemeral_5m_input_tokens || 0
  const write1h = cacheCreation.ephemeral_1h_input_tokens || 0
  // Older transcripts only carry the flat total, with no 5m/1h split.
  const writeFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - write5m - write1h)

  const inputUnits =
    (usage.input_tokens || 0) +
    write5m * CACHE_WRITE_5M +
    write1h * CACHE_WRITE_1H +
    writeFlat * CACHE_WRITE_5M +
    (usage.cache_read_input_tokens || 0) * (price.cacheRead || CACHE_READ)

  return (inputUnits * price.input + (usage.output_tokens || 0) * price.output) / 1e6
}

/**
 * Cost in USD from plain token counts, which is the shape every non-Anthropic
 * transcript reports.
 *
 * The crucial difference from costOf: here `input` is the WHOLE prompt with the
 * cached portion already inside it, which is how Codex and the OpenAI API both
 * report it. Anthropic instead reports its cached tokens in fields separate
 * from `input_tokens`. Adding the cached count on top of a full-rate `input`
 * therefore billed those tokens twice — once at 1.0x and again at 0.1x — and on
 * a real cache-heavy rollout (411k input of which 366k cached) it returned
 * $0.56 against a true $0.10, a 5.5x overcharge that grew with cache hit rate.
 */
function costOfTokens ({ input = 0, output = 0, cachedInput = 0, cacheWrite = 0 }, model, vendorId) {
  const price = priceFor(vendorId, model)
  const uncached = Math.max(0, input - cachedInput)
  const inputUnits =
    uncached + cachedInput * (price.cacheRead || CACHE_READ) + cacheWrite * CACHE_WRITE_5M
  return (inputUnits * price.input + output * price.output) / 1e6
}

/** What the UI shows when it explains where a dollar figure came from. */
function priceMeta (vendorId) {
  const vendor = TABLE[vendorId] || TABLE.anthropic
  return {
    asOf: vendor.asOf,
    source: vendor.source,
    overridden: Boolean((overrides()[vendorId] || []).length),
    overrideFile: OVERRIDE_FILE()
  }
}

module.exports = {
  TABLE,
  priceFor,
  priceMeta,
  costOf,
  costOfTokens,
  CACHE_WRITE_5M,
  CACHE_WRITE_1H,
  CACHE_READ
}
