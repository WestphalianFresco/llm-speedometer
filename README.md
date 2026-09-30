# LLM Speedometer

A frameless, always-on-top desktop gauge cluster for LLM coding CLIs. It reads
what those tools already write to disk and renders it as a car dashboard:
a tachometer for live output rate, two fuel gauges for remaining quota, and a
mechanical odometer for lifetime and per-session token throughput.

Built with Electron. No telemetry, no network calls except one optional
Anthropic usage lookup described below.

```
LLM Speedometer v0.2.0                          🔒  ─  ✕
william@example.com
[Anthropic] [Max 5x] [Opus 5 (1M) ▾]
C:\Users\you\project

   TANK / 5H        OUTPUT RATE        TANK / WEEK
     60%               5.1k                93%
                    TOK / MIN

   TRIP   4 2 3 8 4 2 6  TOK      SESSIONS   3 ON OPUS 5
   ODO  0 2 4 5 5 3 1 6 2 TOK     ● lenovo-64      busy · 1m
   ──────────────────────────     ● gov-bid-est…  shell · 1h 2m
   WEEK 4.8M used · ~32M left     ○ on-campus…     idle · 2h 58m
   COST $138.70 wk · $24.42 billed

   ⟳ 5H 1h 41m 21s    Week 2d 12h 04m
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

## Resizing

Drag any edge of the expanded window and the whole dashboard scales with it:
the aspect ratio is locked and the page is zoomed to the new width, so the
gauges are drawn larger rather than rearranged. It goes from about 0.6× to
2.5× of its 470×432 default, and the chosen size is remembered. The collapsed
pill stays fixed — it is one line of text, and there is nothing in it to grow.

## Minimising

Minimising puts the app in the notification area rather than the taskbar. On
Windows a tray icon new to the system starts in the overflow flyout — behind
the chevron, with the "hidden icons" — until it is dragged onto the bar itself.
Hovering it reports the week's remaining quota, remaining tokens and the live
rate, so the usual glance needs no window at all; left click brings the window
back, right click gives Show / Collapse / Refresh / Quit.

The window's own close button does the same thing while the tray icon exists,
because with somewhere to put it away, closing the window is putting it away
and not quitting. Quit lives on the tray menu and on the ✕ in the collapsed
pill. Turning **Minimise to tray** off in settings restores the ordinary
behaviour — minimise to taskbar, close to exit — and it falls back to that on
its own where no notification area exists.

Collapsing to the pill is unchanged and is a different gesture: the window
stays on screen, just small.

## Stream Deck and other local readers

The running app serves its reading on a loopback-only port, so other tools on
the same machine can show the gauges without polling Anthropic a second time.
On launch it writes `~/.llm-speedometer/bridge.json` with the port and a fresh
random token; each request must send it as `X-Bridge-Token`.

| route | does |
|---|---|
| `GET /v1/reading` | tanks as percent *left*, reset times, tok/min, week cost |
| `POST /v1/refresh` | the tray's Refresh now |
| `POST /v1/show` | the tray's Show dashboard |

On quit the token is cleared but the launch command is kept, so a Stream Deck
key pressed while the app is closed can start it.

**Settings → Stream Deck** turns the bridge on or off, says where the chain is
broken (off / Stream Deck not found / plugin not installed / no keys / connected
· N keys), and **Install plugin…** hands the packed plugin to Stream Deck's own
installer. The plugin's source is in `streamdeck/`: three keys — weekly tank,
5-hour tank, output rate — drawn as ring gauges.

```bash
npm run streamdeck:pack   # builds build/com.williamfan.llmmeter.streamDeckPlugin
```

`npm run dist` runs this first and ships the packed plugin inside the app.

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
- **WEEK** — the same count restricted to the current weekly window, next to an
  estimate of what is left of it. See below: the two halves are not the same
  kind of number.
- **COST** — what the week's tokens would cost at list price, and — when the
  account has burned past its plan into usage credits — what was actually
  charged. On a subscription only the second figure is a bill.

### Why "used" is counted and "left" is estimated

The usage endpoint reports percentages and nothing else. Every `*_dollars`
field on a quota window comes back `null` on a subscription, and there is no
token count anywhere in the payload — `/usage` shows percentages for the same
reason. So the two halves of the WEEK line are obtained differently:

- **used** is counted from the transcripts on this machine. Exact, for this
  machine.
- **left** is the endpoint's percentage against a window size *learned* from
  how many tokens it took to move that percentage. It is marked as an estimate
  and it is withheld entirely until the window is at least 8% burned and local
  history covers the whole window — below that, whole-number percentages make
  the division swing by more than the answer is worth.

They are deliberately not two halves of one subtraction. `left` leans on the
official percentage, which accounts for work done on other machines; `used` only
ever reports what these transcripts prove. When they disagree, the gap is real.

Windows are aligned to the reset the endpoint reports (`resets_at - 7d`), not
to a trailing seven days from now. Those are the same thing only at the instant
a window resets; the rest of the time a trailing count sweeps in work from the
*previous* window. On the machine this was developed against, the trailing
version read 7.17M tokens for a week that had actually used 4.80M.

### Cost tracking without a subscription

A plan has a quota to gauge; an API key has a bill. Prices live in one table
(`src/providers/pricing.js`) covering every vendor, so the same tokens are
costed the same way wherever they came from, and the figure is shown directly
rather than only used internally as a weighting unit. Rates carry the date they
were last checked, and anything the table gets wrong can be corrected without a
release by writing `~/.llm-speedometer/pricing.json`:

```json
{ "anthropic": { "^claude-sonnet-5": { "input": 2, "output": 10 } } }
```
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
