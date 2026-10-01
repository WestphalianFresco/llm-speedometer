'use strict'
const { MODEL_OPTIONS } = require('./settings')

/**
 * The gearbox catalogue: which providers the shifter offers, and which model
 * sits in each gear.
 *
 * This is a static list, edited by hand as models ship. It is deliberately not
 * fetched from anywhere: this app makes exactly one network request in its
 * whole lifetime (the usage endpoint), and a model list is not worth adding a
 * second one, a cache, or a supply chain. Last checked against each vendor's
 * published model list on 2026-09-30.
 *
 * A gear's label is also its identity in ui.json: a saved selection is matched
 * back by label, not by gear number, so re-cutting a gearbox for a new model
 * generation drops it to neutral rather than into whatever now sits in that
 * slot. Keep labels stable for a model that has not changed.
 *
 * SECURITY: `apply` is the only field that can cause a write, and only the
 * Anthropic entries carry one. Its value must appear in MODEL_OPTIONS, which is
 * the whitelist writeModel() checks against — the assertion at the bottom of
 * this file fails the build rather than letting a typo through to another
 * program's config file. Every other provider is display-only: this dashboard
 * cannot reconfigure a CLI it does not own, and pretending otherwise would be
 * worse than saying so.
 *
 * The emoji is the provider's face in the picker: evocative of each house
 * rather than a reproduction of anyone's logo, and it needs no asset, no font
 * and no network.
 *
 * Gear order follows a gearbox, not a price list: 1st is the heaviest, highest
 * torque model and top gear is the light one you cruise in. Reverse is not a
 * model at all — it drops back to whatever was engaged before.
 */

const PROVIDERS = [
  {
    id: 'anthropic',
    emoji: '✴️',
    name: 'Anthropic',
    product: 'Claude Code',
    accent: '#D97757',
    // The only provider this app can actually retarget: Claude Code reads
    // settings.json on session start, and writeModel() owns that file.
    configurable: true,
    note: 'Engaging a gear writes settings.json. Claude Code reads it when a ' +
          'session starts, so a running window keeps its current model.',
    // No separate 1M gear any more: Fable, Opus 4.7 and later, and Sonnet 5
    // and later all run the million-token window natively, so `opus[1m]` now
    // selects exactly the model `opus` does. A gear that changes nothing would
    // only suggest it does.
    gears: [
      { gear: 1, label: 'Fable 5.1', detail: 'most capable', apply: 'fable' },
      { gear: 2, label: 'Opus 5.5', detail: 'flagship', apply: 'opus' },
      { gear: 3, label: 'Sonnet 5.5', detail: 'balanced', apply: 'sonnet' },
      { gear: 4, label: 'Haiku 4.5', detail: 'fast', apply: 'haiku' }
    ]
  },
  {
    id: 'openai',
    emoji: '🌀',
    name: 'OpenAI',
    product: 'Codex CLI',
    accent: '#10A37F',
    configurable: false,
    note: 'Codex keeps its model in config.toml. This dashboard does not edit ' +
          'TOML, so a gear here records your choice without changing Codex.',
    gears: [
      { gear: 1, label: 'GPT-6 Astra', detail: 'flagship' },
      { gear: 2, label: 'GPT-6.1 Sol', detail: 'near-flagship, cheaper' },
      { gear: 3, label: 'GPT-5.6 Sol', detail: 'previous' },
      { gear: 4, label: 'GPT-5.3-Codex', detail: 'coding' },
      { gear: 5, label: 'GPT-6 Luna', detail: 'fast' }
    ]
  },
  {
    id: 'google',
    emoji: '✨',
    name: 'Google',
    product: 'Gemini CLI',
    accent: '#4285F4',
    configurable: false,
    note: 'No reader is implemented for Gemini CLI yet, so this gate records a ' +
          'choice only.',
    gears: [
      { gear: 1, label: 'Gemini 3.1 Pro', detail: 'flagship, preview' },
      { gear: 2, label: 'Gemini 3.8 Flash', detail: 'fast' },
      { gear: 3, label: 'Gemini 3.5 Flash-Lite', detail: 'lightest' },
      { gear: 4, label: 'Gemini 2.5 Pro', detail: 'previous' }
    ]
  },
  {
    id: 'xai',
    emoji: '✖️',
    name: 'xAI',
    product: 'Grok',
    accent: '#8E8E93',
    configurable: false,
    note: 'Display only — no local CLI is read for xAI.',
    gears: [
      { gear: 1, label: 'Grok 4.7', detail: 'flagship' },
      { gear: 2, label: 'Grok 4.6', detail: 'previous' },
      { gear: 3, label: 'Grok 4.3', detail: 'lighter' }
    ]
  },
  {
    id: 'meta',
    emoji: '♾️',
    name: 'Meta',
    product: 'Muse',
    accent: '#0866FF',
    configurable: false,
    note: 'Display only — no local CLI is read for Meta.',
    gears: [
      { gear: 1, label: 'Muse Spark 1.3', detail: 'flagship' },
      { gear: 2, label: 'Muse Glimmer 30B', detail: 'open weights, local' },
      { gear: 3, label: 'Llama 4 Maverick', detail: 'previous, open' }
    ]
  },
  {
    id: 'mistral',
    emoji: '🌬️',
    name: 'Mistral',
    product: 'Le Chat',
    accent: '#FA520F',
    configurable: false,
    note: 'Display only — no local CLI is read for Mistral.',
    gears: [
      { gear: 1, label: 'Mistral Medium 3.5', detail: 'flagship' },
      { gear: 2, label: 'Mistral Large 3', detail: 'largest, open' },
      { gear: 3, label: 'Mistral Small 4', detail: 'fast' },
      { gear: 4, label: 'Codestral', detail: 'code' }
    ]
  },
  {
    id: 'deepseek',
    emoji: '🐋',
    name: 'DeepSeek',
    product: 'DeepSeek',
    accent: '#4D6BFE',
    configurable: false,
    note: 'Display only — no local CLI is read for DeepSeek.',
    gears: [
      { gear: 1, label: 'DeepSeek-V4-Pro', detail: 'flagship' },
      { gear: 2, label: 'DeepSeek-V4.1-Flash', detail: 'fast' }
    ]
  },
  {
    id: 'cohere',
    emoji: '🔗',
    name: 'Cohere',
    product: 'Command',
    accent: '#39594D',
    configurable: false,
    note: 'Display only — no local CLI is read for Cohere.',
    gears: [
      { gear: 1, label: 'Command A+', detail: 'flagship' },
      { gear: 2, label: 'Command A', detail: 'previous' },
      { gear: 3, label: 'Command R7B', detail: 'small, fast' }
    ]
  }
]

/**
 * Nothing reaches writeModel() that is not in this set, and nothing is in this
 * set that MODEL_OPTIONS does not already accept. Checked at load so a bad edit
 * to the catalogue is a startup crash in development rather than a silent
 * rejection — or worse, a value written into someone else's config.
 */
const APPLICABLE = new Set()
for (const provider of PROVIDERS) {
  for (const gear of provider.gears) {
    if (!gear.apply) continue
    if (!provider.configurable) {
      throw new Error(`catalog: ${provider.id} is not configurable but gear ` +
                      `${gear.gear} carries an apply value`)
    }
    if (!MODEL_OPTIONS.some(o => o.value === gear.apply)) {
      throw new Error(`catalog: ${provider.id} gear ${gear.gear} applies ` +
                      `"${gear.apply}", which writeModel() would reject`)
    }
    APPLICABLE.add(gear.apply)
  }
}

/** @returns {object|null} the provider entry, or null for anything unknown. */
function findProvider (id) {
  return PROVIDERS.find(p => p.id === id) || null
}

/**
 * Resolve a (provider, gear) pair against the catalogue.
 *
 * Returns null unless BOTH exist — the renderer sends indices, and an index is
 * not a promise that the thing it points at is real.
 *
 * @param {string} providerId
 * @param {number} gear
 * @returns {{provider: object, gear: object}|null}
 */
function findGear (providerId, gear) {
  const provider = findProvider(providerId)
  if (!provider) return null
  const found = provider.gears.find(g => g.gear === gear)
  return found ? { provider, gear: found } : null
}

module.exports = { PROVIDERS, APPLICABLE, findProvider, findGear }
