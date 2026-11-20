# LLM Speedometer

A frameless, always-on-top desktop gauge cluster for LLM coding CLIs. It reads
what those tools already write to disk and renders it as a car dashboard:
a tachometer for live output rate, two fuel gauges for remaining quota, and a
mechanical odometer for lifetime and per-session token throughput.

Built with [Tauri](https://tauri.app): a Rust backend under a page drawn by
the system webview, so the whole app is a few megabytes. No telemetry. The
only network calls are one optional Anthropic usage lookup described below and
the installed app checking this repo's GitHub Releases for updates.

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

## Getting started

### Install it

1. Open the [latest release](https://github.com/WestphalianFresco/llm-speedometer/releases/latest).
2. Download `LLM Speedometer_<version>_x64-setup.exe` (Windows) or
   `LLM Speedometer_<version>_aarch64.dmg` / `_x64.dmg` (macOS) and run it. The
   builds carry no Apple or Microsoft signature: Windows SmartScreen warns the
   first time, and macOS wants a right-click → Open the first time.
3. Sign in to Claude Code (`claude`) or Codex (`codex`) on the same machine if
   you have not already; the app reads what they write to disk.

After that it keeps itself up to date. It checks this repo's releases when it
starts and every four hours, downloads a newer build in the background, and
then offers **Restart to update** in the tray menu; nothing installs until
that is clicked. Updates are verified against the key the release was signed
with, so an unsigned macOS app updates as well as the Windows one.

### Run it from source

You need [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 22
or newer and git. On Windows, the WebView2 runtime that ships with Windows 10
and 11; on Linux, `webkit2gtk`.

```bash
git clone https://github.com/WestphalianFresco/llm-speedometer.git
cd llm-speedometer
npm install
npm run dev
```

`npm test` runs the Rust unit tests and the Stream Deck plugin's.

### Build an installer

```bash
npm run build       # dmg + .app on macOS, NSIS + MSI on Windows, AppImage + deb on Linux
```

Bundles land in `src-tauri/target/release/bundle/`. A release is cut by
pushing a version tag (see Contributing); the workflow signs each bundle for
the updater with the maintainer's key.

### Layout

- `src/renderer/` — the dashboard page: gauges, odometer, gearbox, settings.
- `src/renderer/tauri-shim.js` — the page's `window.meter` surface, over
  Tauri's invoke/listen.
- `src-tauri/` — the Rust backend: transcripts, the usage endpoint, quota
  calibration, pricing, sessions, the tray, the loopback bridge, the updater.
- `plugin/` — the Claude Code plugin. `streamdeck/` — the Stream Deck plugin.

## Contributing

Open to pull requests — bug fixes especially. Fork the repo, make your change
on a branch, and open a PR against `main` saying what it fixes and how you
checked it. Small, focused PRs are the easiest to review.

A release is cut by pushing a version tag (`v0.5.0`, matching `src-tauri/tauri.conf.json`):
`.github/workflows/release.yml` builds the installers and puts them on a draft
release, and every installed copy picks it up once the maintainer publishes
the draft. Changes to `.github/workflows/` get the closest look.

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
- **While a Claude Code session runs the [plugin](plugin/README.md)**, the app
  takes the week from `~/.llm-speedometer/reading.json` instead: the same
  percentages, read by the engine from the rate-limit headers of every reply,
  so the anchor moves with each reply and the endpoint is never needed for it.
  A file older than 15 minutes is ignored, and the poll above still covers
  whatever the file does not carry.

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

## Claude Code plugin

The same readings without a window: `plugin/` is a Claude Code plugin that
puts quota left, the reset countdown and the output rate on the prompt's hint
line, and `/speedometer` opens a pane with the bars and this session's TRIP.
Its figures come from the rate-limit windows Claude Code receives with every
reply, so it needs no Keychain access and never calls the usage endpoint.

```
/plugin install llm-speedometer --marketplace WestphalianFresco/llm-speedometer
```

See [plugin/README.md](plugin/README.md).

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

While the app is closed, the keys read `~/.llm-speedometer/reading.json`
instead — the file the [Claude Code plugin](plugin/README.md) rewrites with
every reply — so a Claude Code session alone keeps the deck live, with no
window anywhere. A reading older than 90 s shows its rate as 0; a window whose
reset has passed shows as no reading. Pressing a key drawn from that file
starts the app, as pressing an OFF key does.

**Settings → Stream Deck** turns the bridge on or off, says where the chain is
broken (off / Stream Deck not found / plugin not installed / no keys / connected
· N keys), and **Install plugin…** hands the packed plugin to Stream Deck's own
installer. The plugin's source is in `streamdeck/`: three keys — weekly tank,
5-hour tank, output rate — drawn as ring gauges.

```bash
npm run streamdeck:pack   # builds build/com.williamfan.llmmeter.streamDeckPlugin
```

`npm run build` runs this first and ships the packed plugin inside the app.

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

A plan has a quota to gauge; an API key has a bill. On a subscription the
dashboard shows no per-token dollars at all — a monthly fee is not charged per
token — and the COST line only appears as EXTRA when the account reports usage
credits charged past the plan with extra usage switched on. Prices live in one table
(`src/providers/pricing.js`) covering every vendor, so the same tokens are
costed the same way wherever they came from, and the figure is shown directly
rather than only used internally as a weighting unit. Rates carry the date they
were last checked, and anything the table gets wrong can be corrected without a
release by writing `~/.llm-speedometer/pricing.json`:

```json
{ "anthropic": { "^claude-sonnet-5": { "input": 2, "output": 10 } } }
```

An optional `"cacheRead"` sets that model's cache-hit price as a fraction of
its input rate (default `0.1`; Opus 5.5 is `0.05`, Fable 5.1 `0.025`).

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
