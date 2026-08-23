'use strict'
const { MODEL_OPTIONS } = require('./settings')

/**
 * The gearbox catalogue: which providers the shifter offers, and which model
 * sits in each gear.
 *
 * This is a static list, edited by hand as models ship. It is deliberately not
 * fetched from anywhere: this app makes exactly one network request in its
 * whole lifetime (the usage endpoint), and a model list is not worth adding a
 * second one, a cache, or a supply chain.
 *
 * SECURITY: `apply` is the only field that can cause a write, and only the
 * Anthropic entries carry one. Its value must appear in MODEL_OPTIONS, which is
 * the whitelist writeModel() checks against — the assertion at the bottom of
 * this file fails the build rather than letting a typo through to another
 * program's config file. Every other provider is display-only: this dashboard
 * cannot reconfigure a CLI it does not own, and pretending otherwise would be
 * worse than saying so.
 *
 * Gear order follows a gearbox, not a price list: 1st is the heaviest, highest
 * torque model and top gear is the light one you cruise in. Reverse is not a
 * model at all — it drops back to whatever was engaged before.
 */

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    product: 'Claude Code',
    accent: '#D97757',
    // The only provider this app can actually retarget: Claude Code reads
    // settings.json on session start, and writeModel() owns that file.
    configurable: true,
    note: 'Engaging a gear writes settings.json. Claude Code reads it when a ' +
          'session starts, so a running window keeps its current model.',
    gears: [
      { gear: 1, label: 'Opus 5 1M', detail: 'million-token context', apply: 'opus[1m]' },
      { gear: 2, label: 'Opus 5', detail: 'standard', apply: 'opus' },
      { gear: 3, label: 'Fable 5', detail: 'creative', apply: 'fable' },
      { gear: 4, label: 'Sonnet 5', detail: 'balanced', apply: 'sonnet' },
      { gear: 5, label: 'Haiku 4.5', detail: 'fast', apply: 'haiku' }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    product: 'Codex CLI',
    accent: '#10A37F',
    configurable: false,
    note: 'Codex keeps its model in config.toml. This dashboard does not edit ' +
          'TOML, so a gear here records your choice without changing Codex.',
    gears: [
      { gear: 1, label: 'GPT-5', detail: 'flagship' },
      { gear: 2, label: 'GPT-5 mini', detail: 'lighter' },
      { gear: 3, label: 'o3', detail: 'reasoning' },
      { gear: 4, label: 'GPT-4.1', detail: 'long context' },
      { gear: 5, label: 'GPT-4.1 mini', detail: 'fast' }
    ]
  },
  {
    id: 'google',
    name: 'Google',
    product: 'Gemini CLI',
    accent: '#4285F4',
    configurable: false,
    note: 'No reader is implemented for Gemini CLI yet, so this gate records a ' +
          'choice only.',
    gears: [
      { gear: 1, label: 'Gemini 3 Pro', detail: 'flagship' },
      { gear: 2, label: 'Gemini 3 Flash', detail: 'fast' },
      { gear: 3, label: 'Gemini 2.5 Pro', detail: 'previous' },
      { gear: 4, label: 'Gemini 2.5 Flash', detail: 'previous, fast' }
    ]
  },
  {
    id: 'xai',
    name: 'xAI',
    product: 'Grok',
    accent: '#8E8E93',
    configurable: false,
    note: 'Display only — no local CLI is read for xAI.',
    gears: [
      { gear: 1, label: 'Grok 4', detail: 'flagship' },
      { gear: 2, label: 'Grok 4 Fast', detail: 'fast' },
      { gear: 3, label: 'Grok 3', detail: 'previous' }
    ]
  },
  {
    id: 'meta',
    name: 'Meta',
    product: 'Llama',
    accent: '#0866FF',
    configurable: false,
    note: 'Display only — Llama runs wherever you host it.',
    gears: [
      { gear: 1, label: 'Llama 4 Maverick', detail: 'flagship' },
      { gear: 2, label: 'Llama 4 Scout', detail: 'long context' },
      { gear: 3, label: 'Llama 3.3 70B', detail: 'previous' }
    ]
  },
  {
    id: 'mistral',
    name: 'Mistral',
    product: 'Le Chat',
    accent: '#FA520F',
    configurable: false,
    note: 'Display only — no local CLI is read for Mistral.',
    gears: [
      { gear: 1, label: 'Mistral Large', detail: 'flagship' },
      { gear: 2, label: 'Mistral Medium', detail: 'balanced' },
      { gear: 3, label: 'Codestral', detail: 'code' }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    product: 'DeepSeek',
    accent: '#4D6BFE',
    configurable: false,
    note: 'Display only — no local CLI is read for DeepSeek.',
    gears: [
      { gear: 1, label: 'DeepSeek-V3', detail: 'flagship' },
      { gear: 2, label: 'DeepSeek-R1', detail: 'reasoning' }
    ]
  },
  {
    id: 'cohere',
    name: 'Cohere',
    product: 'Command',
    accent: '#39594D',
    configurable: false,
    note: 'Display only — no local CLI is read for Cohere.',
    gears: [
      { gear: 1, label: 'Command A', detail: 'flagship' },
      { gear: 2, label: 'Command R+', detail: 'retrieval' }
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
