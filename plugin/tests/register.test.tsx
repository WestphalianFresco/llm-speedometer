import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionEndInput, SessionMeasureInput, TurnCompleteInput } from 'claude-code'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const HOUR = 3600 * 1000
const iso = (ms: number) => new Date(ms).toISOString()
const LIMITS = [
  { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + HOUR) },
  { kind: 'seven_day', percentUsed: 9, resetsAt: iso(NOW + 10 * HOUR) }
]
const BOTH = '5H 60% left · WK 91% left · 5H resets in 1h 0m'

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]

// Nothing sits beneath the plugin: these hooks stand for the engine.
type Options = { limits?: unknown[]; isPlaced?: boolean; hasClock?: boolean; hasHome?: boolean; writeFails?: boolean }
type Write = { path: string; text: string }

function engine ($: Engine, on: On, { limits = LIMITS, isPlaced = true, hasClock = true, hasHome = true, writeFails = false }: Options = {}) {
  // Without a clock, the bottom of the chain throws on every $.clock call.
  const clock = hasClock ? mock.clock(on, { now: NOW }) : undefined
  const statuses: (string | undefined)[] = []
  const tails: (string | undefined)[] = []
  const writes: Write[] = []
  mock.env(on, hasHome ? { HOME: '/home/u' } : {})
  on('fs.write', (_, e) => {
    if (writeFails) throw new Error('disk full')
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'speedometer' } }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: limits as never }
  }))
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no room' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // The engine's own hint line: records the tail the plugin handed down.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    tails.push(e.props.tail)
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  const tail = async (given?: string) => {
    const ui = await $.ui.mount({
      plugin: 'llm-speedometer',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on', ...(given ? { tail: given } : {}) },
      surface: 'terminal'
    })
    await ui.unmount()
    return tails.at(-1)
  }
  return { clock, statuses, tail, writes, file: () => JSON.parse(writes.at(-1)?.text ?? 'null') }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const measure = (rateLimits: unknown) =>
  ({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] }) as unknown as SessionMeasureInput

const turn = (usage: unknown, extra: object = {}) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage, ...extra }) as unknown as TurnCompleteInput

const USAGE = { input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 2000, cache_read_input_tokens: 999_999, model: 'claude-opus-5-5' }
const CLEAR = { reason: 'clear', sessionId: 's', resume: { id: '' } } as SessionEndInput

// The kit stamps origin and presentation, as a session does for a typed command.
const RUN = { command: 'speedometer', args: '' } as never

const PANE = {
  plugin: 'llm-speedometer',
  component: 'Pane',
  requestId: 'llm-speedometer',
  props: { title: 'LLM Speedometer', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }
} as const

test('the first reading rides the hint line, and the old warning notice is cleared', async ($, on) => {
  const { statuses, tail } = engine($, on)
  await start($)
  expect(await tail()).toBe(BOTH)
  expect(statuses).toEqual([undefined])
})

test('idle with no reading leaves the engine line alone', async ($, on) => {
  const { tail } = engine($, on, { limits: [] })
  await start($)
  expect(await tail()).toBe(undefined)
})

test("another plugin's tail is kept ahead of ours", async ($, on) => {
  const { tail } = engine($, on)
  await start($)
  expect(await tail('focus')).toBe(`focus · ${BOTH}`)
})

test('a measurement replaces the reading; an empty or junk one clears it', async ($, on) => {
  const { tail } = engine($, on)
  await start($)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 75.5 }]))
  expect(await tail()).toBe('5H 24% left')
  await $.session.measure(measure([]))
  expect(await tail()).toBe(undefined)
  await $.session.measure(measure('garbage'))
  expect(await tail()).toBe(undefined)
})

test('turns count toward rate and trip; subagent, aborted and junk turns do not inflate it', async ($, on) => {
  const { tail } = engine($, on)
  await start($)
  await $.turn.complete(turn(USAGE))
  expect(await tail()).toBe(`${BOTH} · 200 tok/min`)
  await $.turn.complete(turn(USAGE, { agentId: 'a1' }))
  await $.turn.complete(turn(undefined, { isAborted: true, reason: 'aborted' }))
  await $.turn.complete(turn({ input_tokens: NaN, cache_creation_input_tokens: -5, output_tokens: '9' }))
  expect(await tail()).toBe(`${BOTH} · 200 tok/min`)
  const ran = await $.command.run(RUN)
  // cache reads excluded: 100 + 50 + 2000, over two counted turns (one of them all junk)
  expect(ran.text).toContain('trip 2k tokens')
})

test('the rate drops off and a passed reset shows as reset, from the timer alone', async ($, on) => {
  const { clock, tail } = engine($, on, { limits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 60_000) }] })
  await start($)
  await $.turn.complete(turn(USAGE))
  expect(await tail()).toBe('5H 60% left · resets in 1m · 200 tok/min')
  await clock!.advance(11 * 60_000)
  expect(await tail()).toBe('5H reset')
})

test('/clear starts the trip over', async ($, on) => {
  engine($, on)
  await start($)
  await $.turn.complete(turn(USAGE))
  await $.session.end(CLEAR)
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe(`${BOTH} · trip 0 tokens`)
})

test("guardrail: when the plugin's own calls fail, every event and the hint line go on", async ($, on) => {
  // No clock answers, so $.clock.every in session.start and $.clock.now in
  // turn.complete and the render hook all throw inside the plugin.
  const { tail } = engine($, on, { hasClock: false })
  expect((await start($)).cwd).toBe('/')
  expect((await $.turn.complete(turn(USAGE))).text).toBe('ok')
  expect((await $.session.measure(measure(LIMITS))).changed).toEqual(['rateLimits'])
  expect((await $.session.end(CLEAR)).sessionId).toBe('s')
  // A reading is stored, yet the hook that would draw it threw and was skipped:
  // the engine's line reached the bottom untouched.
  expect(await tail()).toBe(undefined)
})

test('stress: 1500 turns in a burst keep trip exact and the stored list capped', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, tail } = engine($, on)
  await start($)
  for (let i = 0; i < 1500; i++) {
    await $.turn.complete(turn({ input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 }))
    await clock!.advance(10)
  }
  // 1500 turns inside ten minutes, but only the last 500 are kept: 500 * 100 / 10
  // 15 s of turns moved the clock, so the 5H countdown moved with it
  expect(await tail()).toBe('5H 60% left · WK 91% left · 5H resets in 59m · 5k tok/min')
  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('trip 150k tokens')
})

test('the pane draws on every surface, at any width', async ($, on) => {
  engine($, on)
  await start($)
  await $.turn.complete(turn(USAGE))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const bodyColumns of [10, 70, 400]) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface })
      expect((await ui.find({ type: 'Text', text: /^5H/ }))?.text).toContain('60% left')
      expect((await ui.find({ type: 'Text', text: /^WK/ }))?.text).toContain('resets in 10h 0m')
      expect((await ui.find({ type: 'Text', text: /^RATE/ }))?.text).toBe('RATE 200 tok/min, last 10 min')
      expect((await ui.find({ type: 'Text', text: /^TRIP/ }))?.text).toBe('TRIP 2k tokens in 1 turns')
      await ui.unmount()
    }
  }
})

test('the pane says so when there is no reading yet', async ($, on) => {
  engine($, on, { limits: [] })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No quota reading yet/ })).toBeTruthy()
  await ui.unmount()
})

test('state an older version stored is declined, not drawn', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ bogus: 1 }], version: 1 } }))
  mock.clock(on, { now: NOW })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No quota reading yet/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^TRIP/ }))?.text).toBe('TRIP 0 tokens in 0 turns')
  await ui.unmount()
})

test('/speedometer still answers when no surface can place the pane', async ($, on) => {
  engine($, on, { isPlaced: false })
  await start($)
  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('5H 60% left')
})

test('the reading is written where the Stream Deck looks, on start, each turn, each measurement', async ($, on) => {
  const { writes, file } = engine($, on)
  await start($)
  expect(writes.at(-1)?.path).toBe('/home/u/.llm-speedometer/reading.json')
  expect(file()).toEqual({
    v: 1, at: NOW, source: 'claude-code', tokensPerMinute: 0,
    fiveHour: { percentLeft: 60, resetsAt: NOW + HOUR, source: 'official', tokensLeft: null, tokensUsed: null },
    sevenDay: { percentLeft: 91, resetsAt: NOW + 10 * HOUR, source: 'official', tokensLeft: null, tokensUsed: null },
    costWeek: null, lifetimeTokens: null, tripTokens: 0
  })
  await $.turn.complete(turn(USAGE))
  expect(file().tokensPerMinute).toBe(200)
  expect(file().tripTokens).toBe(2150)
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 50 }]))
  expect(file().sevenDay.percentLeft).toBe(50)
  expect(file().fiveHour.percentLeft).toBe(null)
  expect(writes.length).toBe(3)
})

test('an exit leaves a reading with no rate; /clear leaves one with no trip', async ($, on) => {
  const { file } = engine($, on)
  await start($)
  await $.turn.complete(turn(USAGE))
  await $.session.end({ ...CLEAR, reason: 'prompt_input_exit' })
  expect(file().tokensPerMinute).toBe(0)
  expect(file().fiveHour.percentLeft).toBe(60)
  expect(file().tripTokens).toBe(2150)
  await $.session.end(CLEAR)
  expect(file().tripTokens).toBe(0)
})

test('the timer rewrites the file so an idle session\'s rate falls off', async ($, on) => {
  const { clock, file, writes } = engine($, on)
  await start($)
  await $.turn.complete(turn(USAGE))
  expect(file().tokensPerMinute).toBe(200)
  await clock!.advance(11 * 60_000)
  expect(file().tokensPerMinute).toBe(0)
  expect(file().at).toBe(NOW + 11 * 60_000)
  expect(writes.length).toBeGreaterThan(2)
})

test('no home directory: nothing is written and nothing is held up', async ($, on) => {
  const { writes, tail } = engine($, on, { hasHome: false })
  expect((await start($)).cwd).toBe('/')
  expect((await $.turn.complete(turn(USAGE))).text).toBe('ok')
  expect(writes).toEqual([])
  expect(await tail()).toBe(`${BOTH} · 200 tok/min`)
})

test('guardrail: a write that fails costs the session nothing', async ($, on) => {
  const { tail } = engine($, on, { writeFails: true })
  expect((await start($)).cwd).toBe('/')
  expect((await $.turn.complete(turn(USAGE))).text).toBe('ok')
  expect((await $.session.measure(measure(LIMITS))).changed).toEqual(['rateLimits'])
  expect((await $.session.end(CLEAR)).sessionId).toBe('s')
  expect(await tail()).toBe(BOTH)
})
