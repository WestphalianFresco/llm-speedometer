# LLM Speedometer

A frameless, always-on-top desktop gauge cluster for LLM coding CLIs. It reads
what Claude Code and Codex already write to disk and draws it as a car
dashboard: a tachometer for live output rate, two fuel gauges for remaining
quota, and an odometer for lifetime and per-session tokens.

Built with Electron. No telemetry. The only network calls are one optional
Anthropic usage lookup and the installed app checking this repo's GitHub
Releases for updates.

```
LLM Speedometer v0.4.0                          🔒  ─  ✕
william@example.com
[Anthropic] [Max 5x] [Opus 5.5 ▾]
C:\Users\you\project

   TANK / 5H        OUTPUT RATE        TANK / WEEK
     60%               5.1k                93%
                    TOK / MIN

   TRIP   4 2 3 8 4 2 6  TOK      SESSIONS   3 ON OPUS 5.5
   ODO  0 2 4 5 5 3 1 6 2 TOK     ● lenovo-64      busy · 1m
   ──────────────────────────     ● gov-bid-est…  shell · 1h 2m
   WEEK 4.8M used · ~32M left     ○ on-campus…     idle · 2h 58m

   ⟳ 5H 1h 41m 21s    Week 2d 12h 04m
```

## Install

1. Open the [latest release](https://github.com/WestphalianFresco/llm-speedometer/releases/latest).
2. Download `LLM-Speedometer-<version>-Setup.exe` (Windows) or
   `LLM-Speedometer-<version>.dmg` (macOS) and run it. The builds are unsigned:
   Windows SmartScreen warns the first time, and macOS wants a right-click →
   Open the first time.
3. Sign in to Claude Code (`claude`) or Codex (`codex`) on the same machine;
   the app reads what they write to disk.

The Windows installer keeps itself up to date and asks before restarting. The
portable exe and the macOS and Linux builds are replaced by hand.

### From source

Needs [Node.js](https://nodejs.org) 22 or newer and git.

```bash
git clone https://github.com/WestphalianFresco/llm-speedometer.git
cd llm-speedometer
npm install
npm start           # run it
npm run dist        # Windows installer and portable .exe, in dist/
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```

## What the numbers mean

- **OUTPUT RATE**: output tokens per minute over a trailing 10 minutes. Cache
  traffic is excluded.
- **TANK**: quota *remaining*, not used, for the 5-hour and weekly windows.
- **ODO / TRIP**: lifetime and current-session tokens, counting
  input + cache writes + output.
- **WEEK**: tokens used in the current weekly window, counted from this
  machine's transcripts, next to an estimate of what is left. The estimate is
  withheld until the window is at least 8% burned and local history covers all
  of it.
- **COST**: what the week's tokens would cost at list price, and what was
  actually charged when the account has burned past its plan into usage
  credits. On a subscription only the second figure is a bill.

Prices live in `src/providers/pricing.js`. Any of them can be corrected without
a release by writing `~/.llm-speedometer/pricing.json`:

```json
{ "anthropic": { "^claude-sonnet-5": { "input": 2, "output": 10 } } }
```

Needle wander is cosmetic. The digital readouts are exact.

## Providers

| | Anthropic (Claude Code) | OpenAI (Codex CLI) |
|---|---|---|
| source | `~/.claude/projects/**/*.jsonl` | `~/.codex/sessions/**/rollout-*.jsonl` |
| output rate | yes | yes |
| odometer | yes | yes |
| weekly tank | via usage endpoint | from the rollout's `rate_limits` |
| 5-hour tank | yes | **N/A** — ChatGPT plans report one weekly window |
| model switch | writes `settings.json` | read-only (model lives in `config.toml`) |

ODO and TRIP are independent per provider; nothing is summed across them.

Where the quota comes from:

- **Codex** writes its own rate limits into the transcript. No network access.
- **Anthropic's** lives behind `api.anthropic.com/api/oauth/usage`, which
  throttles aggressively ([#31021][1], [#31637][2]). It is polled at most every
  15 minutes with exponential backoff, and between polls the reading is
  projected forward from the last official figure. The badge and tooltip say
  which mode is live.
- While a Claude Code session runs the [plugin](plugin/README.md), the app
  takes the week from `~/.llm-speedometer/reading.json` instead, so the
  endpoint is not needed for it.

[1]: https://github.com/anthropics/claude-code/issues/31021
[2]: https://github.com/anthropics/claude-code/issues/31637

### Sign-in and paths

There is no authentication in this app and no credential entry anywhere in it.
It detects which provider CLIs are already signed in locally and reads theirs.
Codex has to be run once on the machine before its figures appear.

On macOS, Claude Code keeps its token in the login Keychain, so the first
lookup raises a one-time permission prompt. If that is declined, the app falls
back to local estimation.

No path is hardcoded: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CONFIG_DIR`
win when set, then the conventional dot-directory, then
`$XDG_CONFIG_HOME/<tool>`.

## Window

- **Resize**: drag any edge and the whole dashboard scales, from about 0.6× to
  2.5×. The size is remembered.
- **Minimise or close**: both put the app in the tray. Hovering the icon shows
  the week's remaining quota and the live rate; right click gives Show /
  Collapse / Refresh / Quit. **Minimise to tray** in settings turns this off.
- **Collapse**: shrinks the window to a one-line pill that stays on screen.

## Claude Code plugin

`plugin/` puts quota left, the reset countdown and the output rate on the
prompt's hint line, and `/speedometer` opens a pane with the bars and this
session's TRIP. It needs no Keychain access and never calls the usage endpoint.

```
/plugin install llm-speedometer --marketplace WestphalianFresco/llm-speedometer
```

See [plugin/README.md](plugin/README.md).

## Stream Deck and other local readers

The running app serves its reading on a loopback-only port, so other tools on
the same machine can show the gauges without polling Anthropic again. On launch
it writes `~/.llm-speedometer/bridge.json` with the port and a fresh random
token; each request must send it as `X-Bridge-Token`.

| route | does |
|---|---|
| `GET /v1/reading` | tanks as percent *left*, reset times, tok/min, week cost |
| `POST /v1/refresh` | the tray's Refresh now |
| `POST /v1/show` | the tray's Show dashboard |

While the app is closed, the Stream Deck keys read the plugin's `reading.json`
instead. **Settings → Stream Deck** turns the bridge on or off, says where the
chain is broken, and installs the packed plugin. Its source is in
`streamdeck/`; `npm run streamdeck:pack` builds it.

## Contributing

Open to pull requests, bug fixes especially. Make your change on a branch and
open a PR against `main` saying what it fixes and how you checked it.

A release is cut by pushing a version tag that matches `package.json`:
`.github/workflows/release.yml` builds the installers onto a draft release, and
installed copies pick it up once the draft is published.

## Licence

MIT
