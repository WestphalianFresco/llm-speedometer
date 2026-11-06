# LLM Speedometer for Claude Code

The gauges from [LLM Speedometer](../README.md), inside Claude Code itself: no
window, no Keychain access, no usage endpoint. The quota figures are the ones
Claude Code already receives with every reply.

```
⏵⏵ auto mode on (shift+tab to cycle) · WK 89% left · resets in 10h 31m · 96 tok/min
```

- **Hint line** — after the engine's own line under the prompt, dim: each
  rate-limit window as percent *left*, when the tightest one resets, and the
  output rate while the model is producing. Nothing is added while there is
  nothing to say.
- **`/speedometer`** — opens a pane with a bar per window, the reset countdown,
  the output rate over the last ten minutes and TRIP, the tokens this session
  has used (input + cache writes + output; cache reads are left out, as in the
  app). `/clear` starts the trip over.

## Install

At the prompt of a terminal session:

```
/plugin install llm-speedometer --marketplace WestphalianFresco/llm-speedometer
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:
`claude plugin install llm-speedometer --marketplace WestphalianFresco/llm-speedometer`.

## What it reads

The engine's `session.usage()` and `session.measure` (the `five_hour` and
`seven_day` windows, as whole percentages used) and each turn's token usage.
It observes only: no hook can block a tool call, a prompt or a command, and a
hook that fails is skipped while the session goes on. It reads no file, makes
no network call and runs no command — `claude plugin validate plugin` lists
every call it makes.

The hint-line tail is drawn by the terminal only; the pane works on every
surface. A session without a quota reading (an API key, or before the first
reply) shows nothing on the line and says so in the pane.

## Develop

```
claude plugin validate plugin
claude plugin test plugin
```

The plugin API is early access and may change between releases.
