import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Trip, Turn } from '../types'
import { compact, count, hintText, prune, rate, tankRow, tanks, toLimits } from './gauge'

const PANE = 'llm-speedometer'
const TICK_MS = 30 * 1000
// Bump a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const limits = atom({ plugin: 'llm-speedometer', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const turns = atom({ plugin: 'llm-speedometer', key: 'turns' } as const, [] as Turn[], { shape: 'turns-1' })
const trip = atom({ plugin: 'llm-speedometer', key: 'trip' } as const, { tokens: 0, turns: 0 } as Trip, { shape: 'trip-1' })
// Written by the timer only, so the hint line and pane redraw their countdowns.
const tick = atom({ plugin: 'llm-speedometer', key: 'tick' } as const, 0)

// Observe-only hooks: one that throws is skipped by the engine and the event
// goes on (the guardrail test holds this), so the gauge can't stall a session.
export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speedometer',
      description: "Show quota left, output rate and this session's tokens"
    })
    const usage = await $.session.usage()
    await update($, limits, () => toLimits(usage.rateLimits))
    // v0.1 pinned a status notice, which Claude Code draws with a warning sign.
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, tick, () => now)
      })().catch(() => {})
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => toLimits(e.rateLimits))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // ponytail: main loop only, subagent turns are not counted; hook them by agentId if they matter.
    if (!e.agentId && e.usage) {
      const u = e.usage
      const now = await $.clock.now()
      const tokens = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.output_tokens)
      await update($, turns, list => prune([...list, { at: now, output: count(u.output_tokens), tokens }], now))
      await update($, trip, t => ({ tokens: t.tokens + tokens, turns: t.turns + 1 }))
    }
    return next(e)
  })

  // /clear starts the session over, so the trip starts over with it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, turns, () => [])
      await update($, trip, () => ({ tokens: 0, turns: 0 }))
    }
    return next(e)
  })

  on('command.run', { command: 'speedometer' }, async $ => {
    await $.ui.open({ id: PANE, title: 'LLM Speedometer' })
    const now = await $.clock.now()
    const t = await read($, trip)
    return {
      text: `${hintText(tanks(await read($, limits), now), rate(await read($, turns), now)) ?? 'no quota reading yet'} · trip ${compact(t.tokens)} tokens`
    }
  })

  // Dim, after the engine's own hint line, which keeps its pills live. Another
  // plugin's tail is kept ahead of ours.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    await read($, tick)
    const now = await $.clock.now()
    const ours = hintText(tanks(await read($, limits), now), rate(await read($, turns), now))
    if (!ours) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${ours}` : ours } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const list = tanks(await read($, limits), now)
    const t = await read($, trip)
    const width = (e.props.bodyColumns ?? 40) - 34
    return (
      <Box flexDirection="column">
        {list.length === 0 && (
          <Text dimColor>No quota reading yet. It shows after the first reply on a Claude plan.</Text>
        )}
        {list.map(k => <Text>{tankRow(k, width)}</Text>)}
        <Text>{`RATE ${compact(rate(await read($, turns), now))} tok/min, last 10 min`}</Text>
        <Text>{`TRIP ${compact(t.tokens)} tokens in ${t.turns} turns`}</Text>
        <Text dimColor>Quota is the account's, from the last reply. Rate and trip are this session.</Text>
      </Box>
    )
  })
}
