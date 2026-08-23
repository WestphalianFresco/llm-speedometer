# LLM Speedometer

A frameless, always-on-top desktop gauge cluster for LLM coding CLIs. It reads
what those tools already write to disk and renders it as a car dashboard:
a tachometer for live output rate, two fuel gauges for remaining quota, and a
mechanical odometer for lifetime and per-session token throughput.

Built with Electron. No telemetry, no network calls except one optional
Anthropic usage lookup described below.

```
LLM Speedometer v0.1.0                          🔒  ─  ✕
william@example.com
[Anthropic] [Max 5x] [Opus 5 (1M) ▾]
C:\Users\you\project

   TANK / 5H        OUTPUT RATE        TANK / WEEK
     60%               5.1k                93%
                    TOK / MIN

   TRIP   4 2 3 8 4 2 6  TOK     SESSIONS   3 ON OPUS 5
   ODO  0 2 4 5 5 3 1 6 2 TOK    ● lenovo-64      busy · 1m
                                 ● gov-bid-est…  shell · 1h 2m
   ⟳ 1h 41m 21s to reset         ○ on-campus…     idle · 2h 58m
```

## Providers

| | Anthropic (Claude Code) | OpenAI (Codex CLI) |
|---|---|---|
| source | `~/.claude/projects/**/*.jsonl` | `~/.codex/sessions/**/rollout-*.jsonl` |
| output rate | yes | yes |
| odometer | yes | yes |
| weekly tank | via usage endpoint | from the rollout's `rate_limits` |
| 5-hour tank | yes | **N/A** — ChatGPT plans report one weekly window |
| model switch | writes `settings.json` | read-only (model lives in `config.toml`) |

Each provider mounts its own store behind one interface, so ODO and TRIP are
independent per LLM — nothing is shared or summed across them.

### How quota is obtained

The two providers differ in a way worth knowing:

- **Codex writes its own rate limits into the transcript.** No polling, no
  network access, no rate-limit problems.
- **Anthropic's lives behind `api.anthropic.com/api/oauth/usage`**, which
  throttles aggressively ([#31021][1], [#31637][2]). It is polled at most every
  15 minutes with an exponential backoff ladder, and between polls the reading
  is projected forward from the last official anchor using a self-calibrating
  dollars-to-percent rate. The badge and tooltip say which mode is live.

[1]: https://github.com/anthropics/claude-code/issues/31021
[2]: https://github.com/anthropics/claude-code/issues/31637

## Install

```bash
npm install
npm start
```

Build a distributable:

```bash
npm run dist        # Windows portable .exe
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```

## Paths

No path is hardcoded. Each root resolves per call, in order:

1. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CONFIG_DIR` — **authoritative**
   when set, existing or not
2. the conventional dot-directory under `os.homedir()` (Windows, macOS, Linux)
3. `$XDG_CONFIG_HOME/<tool>`

Because resolution happens per call rather than at startup, a CLI you sign into
later is picked up without restarting the app.

On macOS, Claude Code keeps its OAuth token in the login Keychain rather than in
`.credentials.json`; the credential reader falls back to
`security find-generic-password`, which raises a one-time permission prompt. If
that is declined, the app degrades to local estimation rather than failing.

## What the numbers mean

- **OUTPUT RATE** — output tokens per minute over a trailing 10-minute window.
  Cache reads and cache writes are excluded: on a busy session cache traffic
  runs orders of magnitude above everything else and would swamp the reading.
- **TANK** — quota *remaining*, not used. A gauge that empties as you work is
  the only version of the metaphor that reads correctly.
- **ODO / TRIP** — lifetime and current-session tokens, counting
  input + cache writes + output.
- **Needle wander** is cosmetic: a spring simulation with layered noise, so the
  needle breathes like a real gauge. The digital readouts are exact.

## Sign-in

There is no authentication in this app and no credential entry anywhere in it.
The unlock screen detects which provider CLIs are already signed in locally and
mounts that provider's reader. For a provider that is not signed in, the only
action offered is opening that vendor's real site in your browser.

A browser session alone is not enough for OpenAI: the quota figures come from
OpenAI's servers inside Codex's own authenticated API responses. There is no
public usage endpoint for ChatGPT consumer plans, so a fresh device needs
`codex` run once locally before anything appears.

## Licence

MIT
