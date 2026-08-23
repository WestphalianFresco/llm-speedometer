'use strict'

const SVG_NS = 'http://www.w3.org/2000/svg'

const el = id => document.getElementById(id)
const nodes = {
  card: el('card'),
  mascot: el('mascot'),
  cluster: el('cluster'),
  reset: el('reset'),
  acct: el('acct'),
  hdrVersion: el('hdr-version'),
  hdrCwd: el('hdr-cwd'),
  chipCompany: el('chip-company'),
  chipTier: el('chip-tier'),
  chipModel: el('chip-model'),
  btnExpand: el('btn-expand'),
  modelMenu: el('model-menu'),
  menuBackdrop: el('menu-backdrop'),
  tasksTitle: el('tasks-title'),
  tasksCount: el('tasks-count'),
  tasksList: el('tasks-list'),
  lock: el('lock'),
  fobUnlock: el('fob-unlock'),
  fobLed: el('fob-led'),
  fob: el('fob'),
  fobLabel: el('fob-label'),
  vendors: el('vendors'),
  lockStatus: el('lock-status'),
  lockOpen: el('lock-open'),
  odoTotal: el('odo-total'),
  odoTrip: el('odo-trip'),
  btnCloseMini: el('btn-close-mini'),
  miniPct: el('mini-pct')
}

// ---------- dial geometry ----------

const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG_NS, tag)
  for (const key in attrs) node.setAttribute(key, attrs[key])
  return node
}

// 0deg points east and angles grow clockwise, which is what SVG's y-down
// coordinate system gives us for free.
const polar = (cx, cy, r, deg) => {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

const arcPath = (cx, cy, r, a1, a2) => {
  const p1 = polar(cx, cy, r, a1)
  const p2 = polar(cx, cy, r, a2)
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
}

/**
 * Instrument cluster, laid out like a car's: three gauges in a row, the primary
 * one largest and centred, the two secondaries flanking it slightly lower as
 * open C-rings broken at the bottom.
 *
 *   tach (centre)   - how fast tokens are being produced right now
 *   tank5h  (left)  - how much of the 5-hour window is LEFT
 *   tankWeek(right) - how much of the weekly window is LEFT
 *
 * The tanks read remaining rather than used: a gauge that empties as you drive
 * is the only version of the metaphor that makes sense.
 *
 * One routine draws two gauge kinds:
 *   'tach' - closed dial with tick ring, numerals, inner disc and a needle
 *   'ring' - open arc filled from the E end, readout inside, no needle. At this
 *            size an arc communicates level better than a 20px needle can.
 */
const DIALS = {
  tank5h: {
    kind: 'ring',
    cx: 68, cy: 88, r: 54, max: 100,
    start: 120, sweep: 300,
    trackR: 52, trackW: 4,
    tickCount: 20, majorEvery: 5,
    tickOuter: 46, tickInner: 41, majorOuter: 47, majorInner: 40,
    numeralR: 34, numerals: [0, 25, 50, 75, 100], numeralClass: 'sm',
    discR: 22,
    readY: 92, readClass: 'read-lg',
    caption: 'TANK / 5H', capY: 158,
    lamp: { dx: 0, dy: 14 },
    wanderPct: 0.35,
    zones: [
      { to: 15, color: 'var(--crit)' },
      { to: 30, color: 'var(--warm)' },
      { to: 100, color: 'var(--safe)' }
    ]
  },
  tach: {
    kind: 'tach',
    cx: 211, cy: 76, r: 68, max: 20000,
    start: 135, sweep: 270,
    tickCount: 40, majorEvery: 5,
    tickOuter: 65, tickInner: 58, majorOuter: 66, majorInner: 54,
    numeralR: 44, numerals: [0, 5000, 10000, 15000, 20000],
    discR: 37,
    needleLen: 50, needleTail: 9, hubR: 5,
    readY: 79, readClass: 'read-xl',
    unit: 'TOK / MIN', unitY: 92,
    caption: 'OUTPUT RATE', capY: 158,
    wanderPct: 1.6,
    zones: [
      { to: 8000, color: 'var(--safe)' },
      { to: 14000, color: 'var(--warm)' },
      { to: 17500, color: 'var(--hot)' },
      { to: 20000, color: 'var(--crit)' }
    ]
  },
  tankWeek: {
    kind: 'ring',
    cx: 354, cy: 88, r: 54, max: 100,
    start: 120, sweep: 300,
    trackR: 52, trackW: 4,
    tickCount: 20, majorEvery: 5,
    tickOuter: 46, tickInner: 41, majorOuter: 47, majorInner: 40,
    numeralR: 34, numerals: [0, 25, 50, 75, 100], numeralClass: 'sm',
    discR: 22,
    readY: 92, readClass: 'read-lg',
    caption: 'TANK / WEEK', capY: 158,
    lamp: { dx: 0, dy: 14 },
    wanderPct: 0.28,
    zones: [
      { to: 15, color: 'var(--crit)' },
      { to: 30, color: 'var(--warm)' },
      { to: 100, color: 'var(--safe)' }
    ]
  }
}

const DIAL_KEYS = ['tank5h', 'tach', 'tankWeek']

const angleFor = (dial, value) =>
  dial.start + (Math.min(dial.max, Math.max(0, value)) / dial.max) * dial.sweep

/** Colour for a value, taken from the dial's own zone table. */
function zoneColor (dial, value) {
  for (const zone of dial.zones) if (value <= zone.to) return zone.color
  return dial.zones[dial.zones.length - 1].color
}

function buildRing (dial) {
  const g = svgEl('g', {})

  g.appendChild(svgEl('path', {
    d: arcPath(dial.cx, dial.cy, dial.trackR, dial.start, dial.start + dial.sweep),
    class: 'ring-track',
    'stroke-width': dial.trackW
  }))

  // the lit portion; length and colour are set on every render
  const fill = svgEl('path', { class: 'ring-fill', 'stroke-width': dial.trackW })
  g.appendChild(fill)

  // Same tick ring the tach carries, so the three gauges read as one set.
  for (let i = 0; i <= dial.tickCount; i++) {
    const major = i % dial.majorEvery === 0
    const value = (i / dial.tickCount) * dial.max
    const a = angleFor(dial, value)
    const outer = polar(dial.cx, dial.cy, major ? dial.majorOuter : dial.tickOuter, a)
    const inner = polar(dial.cx, dial.cy, major ? dial.majorInner : dial.tickInner, a)
    const line = svgEl('line', {
      x1: outer.x.toFixed(2), y1: outer.y.toFixed(2),
      x2: inner.x.toFixed(2), y2: inner.y.toFixed(2),
      class: 'dial-tick' + (major ? ' major' : ''),
      'stroke-width': major ? 2 : 1
    })
    if (major) line.setAttribute('stroke', zoneColor(dial, value))
    g.appendChild(line)
  }

  // and the same inner face the readout sits on
  g.appendChild(svgEl('circle', { cx: dial.cx, cy: dial.cy, r: dial.discR, class: 'dial-disc' }))

  // numerals on the scale, same treatment as the tach carries
  if (dial.numerals) {
    for (const value of dial.numerals) {
      const p = polar(dial.cx, dial.cy, dial.numeralR, angleFor(dial, value))
      const t = svgEl('text', {
        x: p.x.toFixed(1), y: (p.y + 2.6).toFixed(1),
        class: 'dial-num' + (dial.numeralClass ? ' ' + dial.numeralClass : '')
      })
      t.textContent = String(value)
      g.appendChild(t)
    }
  }

  const readout = svgEl('text', {
    x: dial.cx, y: dial.readY, class: 'dial-read ' + dial.readClass
  })
  readout.textContent = '--'
  g.appendChild(readout)

  const caption = svgEl('text', { x: dial.cx, y: dial.capY, class: 'dial-cap' })
  caption.textContent = dial.caption
  g.appendChild(caption)

  let lamp = null
  if (dial.lamp) {
    lamp = svgEl('circle', {
      cx: dial.cx + dial.lamp.dx, cy: dial.cy + dial.lamp.dy, r: 3, class: 'lamp'
    })
    g.appendChild(lamp)
  }

  return { g: g, needle: null, readout: readout, lamp: lamp, fill: fill }
}

function buildTach (dial) {
  const g = svgEl('g', {})

  for (let i = 0; i <= dial.tickCount; i++) {
    const major = i % dial.majorEvery === 0
    const value = (i / dial.tickCount) * dial.max
    const a = angleFor(dial, value)
    const outer = polar(dial.cx, dial.cy, major ? dial.majorOuter : dial.tickOuter, a)
    const inner = polar(dial.cx, dial.cy, major ? dial.majorInner : dial.tickInner, a)
    const line = svgEl('line', {
      x1: outer.x.toFixed(2), y1: outer.y.toFixed(2),
      x2: inner.x.toFixed(2), y2: inner.y.toFixed(2),
      class: 'dial-tick' + (major ? ' major' : ''),
      'stroke-width': major ? 2.4 : 1.1
    })
    if (major) line.setAttribute('stroke', zoneColor(dial, value))
    g.appendChild(line)
  }

  for (const value of dial.numerals) {
    const p = polar(dial.cx, dial.cy, dial.numeralR, angleFor(dial, value))
    const t = svgEl('text', { x: p.x.toFixed(1), y: (p.y + 3.4).toFixed(1), class: 'dial-num' })
    t.textContent = String(Math.round(value / 1000))
    g.appendChild(t)
  }

  const needle = svgEl('g', { class: 'needle' })
  needle.style.transformOrigin = dial.cx + 'px ' + dial.cy + 'px'
  const tailX = dial.cx - dial.needleTail
  const tipX = dial.cx + dial.needleLen
  needle.appendChild(svgEl('polygon', {
    points: [
      tailX + ',' + (dial.cy - 2.2),
      tipX + ',' + (dial.cy - 0.8),
      tipX + ',' + (dial.cy + 0.8),
      tailX + ',' + (dial.cy + 2.2)
    ].join(' '),
    class: 'needle-body',
    fill: 'var(--dial-ink)'
  }))
  g.appendChild(needle)

  // disc goes on last of the moving parts, so the needle vanishes under it
  g.appendChild(svgEl('circle', { cx: dial.cx, cy: dial.cy, r: dial.discR, class: 'dial-disc' }))

  const readout = svgEl('text', {
    x: dial.cx, y: dial.readY, class: 'dial-read ' + dial.readClass
  })
  readout.textContent = '--'
  g.appendChild(readout)

  const unit = svgEl('text', { x: dial.cx, y: dial.unitY, class: 'dial-unit' })
  unit.textContent = dial.unit
  g.appendChild(unit)

  const caption = svgEl('text', { x: dial.cx, y: dial.capY, class: 'dial-cap' })
  caption.textContent = dial.caption
  g.appendChild(caption)

  return { g: g, needle: needle, readout: readout, lamp: null, fill: null }
}

const buildDial = dial => (dial.kind === 'ring' ? buildRing(dial) : buildTach(dial))

const cluster = {}

function buildCluster () {
  for (const key of DIAL_KEYS) {
    const built = buildDial(DIALS[key])
    cluster[key] = built
    nodes.cluster.appendChild(built.g)
  }
}

/** Set a ring gauge's lit arc length and colour. */
function paintRing (key, value) {
  const dial = DIALS[key]
  const node = cluster[key].fill
  if (!node) return
  if (value === null || value <= 0) {
    node.setAttribute('d', '')
    return
  }
  node.setAttribute('d', arcPath(dial.cx, dial.cy, dial.trackR, dial.start, angleFor(dial, value)))
  node.setAttribute('stroke', zoneColor(dial, value))
}

/**
 * Needle motion model.
 *
 * A real gauge needle is a mass on a spring against a damper, and it never sits
 * perfectly still — engine vibration and road noise keep it breathing. Both are
 * simulated: a damped spring chases the target, and a sum of incommensurate
 * sines plus a slow bounded random walk supplies the wander. Layered sines are
 * used rather than white noise because white noise reads as jitter, while
 * summed sines read as motion.
 */
const SPRING_K = 0.11
const SPRING_D = 0.76

const makeDialState = dial => ({
  target: 0,
  current: 0,
  velocity: 0,
  // wander is authored as a percentage of full scale, so it looks the same on
  // a 0-100 tank as on a 0-100000 speedometer
  amplitude: (dial.wanderPct / 100) * dial.max,
  drift: 0,
  clock: Math.random() * 100,
  phase: [Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283],
  idle: true
})

const dialState = {}
for (const key of DIAL_KEYS) dialState[key] = makeDialState(DIALS[key])

function setNeedle (key, value) {
  dialState[key].target = Math.min(DIALS[key].max, Math.max(0, value))
}

/** Park a needle dead still — used when there is no data to represent. */
function setNeedleIdle (key, idle) {
  dialState[key].idle = idle
}

function applyNeedle (key, value) {
  cluster[key].needle.style.transform = `rotate(${angleFor(DIALS[key], value).toFixed(3)}deg)`
}

let lastFrame = 0

function frame (now) {
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0.016
  lastFrame = now

  for (const key of DIAL_KEYS) {
    const s = dialState[key]

    s.velocity = (s.velocity + (s.target - s.current) * SPRING_K) * SPRING_D
    s.current += s.velocity

    let shown = s.current
    if (!s.idle) {
      s.clock += dt
      const wander =
        Math.sin(s.clock * 1.9 + s.phase[0]) * 0.50 +
        Math.sin(s.clock * 3.7 + s.phase[1]) * 0.27 +
        Math.sin(s.clock * 0.83 + s.phase[2]) * 0.34
      s.drift = s.drift * 0.985 + (Math.random() - 0.5) * 0.05
      shown += (wander + s.drift * 4) * s.amplitude
    }

    if (cluster[key] && cluster[key].needle) {
      applyNeedle(key, Math.min(DIALS[key].max, Math.max(0, shown)))
    }
  }

  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// ---------- personality ----------

const MOODS = [
  { max: 50, face: '( ˶ˆ ᗜ ˆ˵ )', text: 'Feeling great!', cls: '' },
  { max: 75, face: '( ˶• ᴗ •˵ )', text: 'Pacing myself~', cls: '' },
  { max: 90, face: '( ｡•́ - •̀｡ )', text: 'Getting a bit tight…', cls: '' },
  { max: Infinity, face: '( ; ᵕ ; )', text: 'Almost out! Go easy!', cls: 'panic' }
]
const MOOD_UNKNOWN = { face: '( ˘ ω ˘ )', text: 'Still getting to know you…', cls: 'sleep' }
const MOOD_THROTTLED = { face: '( -ω- ) zZ', text: 'API throttled — local estimate', cls: 'sleep' }

function formatRate (perMin) {
  if (perMin >= 10000) return Math.round(perMin / 1000) + 'k'
  if (perMin >= 1000) return (perMin / 1000).toFixed(1) + 'k'
  return Math.round(perMin).toString()
}

const pad2 = n => (n < 10 ? '0' : '') + n

function formatCountdown (ms) {
  if (ms <= 0) return 'resetting now'
  const total = Math.floor(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600) % 24
  const d = Math.floor(total / 86400)
  if (d > 0) return d + 'd ' + pad2(h) + 'h ' + pad2(m) + 'm ' + pad2(s) + 's to reset'
  if (h > 0) return h + 'h ' + pad2(m) + 'm ' + pad2(s) + 's to reset'
  if (m > 0) return m + 'm ' + pad2(s) + 's to reset'
  return s + 's to reset'
}

/** Long paths are truncated from the LEFT — the tail is the informative half. */
function shortenPath (p, max) {
  if (!p || p.length <= max) return p
  return '…' + p.slice(-(max - 1))
}

let menuBuilt = false
let activeModelLabel = null
let activeModelFamily = null

/**
 * Model picker.
 *
 * Writes settings.json, which Claude Code reads when a session STARTS. It
 * cannot retarget a session that is already running — so when the configured
 * model differs from the one the live transcript shows, the chip says so
 * rather than pretending the switch already took effect.
 */
function buildModelMenu (options, currentValue) {
  nodes.modelMenu.textContent = ''

  for (const option of options) {
    const item = document.createElement('button')
    item.className = 'menu-item' + (option.value === currentValue ? ' active' : '')
    item.dataset.model = option.value

    const name = document.createElement('span')
    name.textContent = option.label
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = '✓'
    item.appendChild(name)
    item.appendChild(tick)

    item.addEventListener('click', async () => {
      closeMenu()
      const result = await window.meter.setModel(option.value)
      if (!result || !result.ok) {
        nodes.chipModel.textContent = 'write failed'
        nodes.chipModel.title = 'Could not update settings.json: ' +
          ((result && result.reason) || 'unknown')
      }
    })
    nodes.modelMenu.appendChild(item)
  }

  const note = document.createElement('div')
  note.className = 'menu-note'
  note.textContent = 'Applies to new Claude Code sessions. Use /model to switch a running one.'
  nodes.modelMenu.appendChild(note)

  menuBuilt = true
}

const menuOpen = () => !nodes.modelMenu.hasAttribute('hidden')

function closeMenu () {
  nodes.modelMenu.setAttribute('hidden', '')
  nodes.menuBackdrop.setAttribute('hidden', '')
}

function openMenu () {
  // The backdrop goes up with the menu. Without it, clicking the rest of the
  // card lands on the window's drag region, which never emits a DOM click, so
  // the menu could only be dismissed by hitting the chip again.
  nodes.menuBackdrop.removeAttribute('hidden')
  nodes.modelMenu.removeAttribute('hidden')
}

function toggleMenu () {
  if (menuOpen()) closeMenu()
  else openMenu()
}

nodes.chipModel.addEventListener('click', e => {
  e.stopPropagation()
  if (menuBuilt) toggleMenu()
})
nodes.menuBackdrop.addEventListener('click', closeMenu)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuOpen()) closeMenu()
})

function renderHeader (session, appVersion) {
  nodes.hdrVersion.textContent = 'v' + (appVersion || '0.1.0')
  if (!session) return

  nodes.chipCompany.textContent = session.company || '—'
  nodes.chipTier.textContent = session.plan || '—'
  activeModelLabel = session.model || null
  activeModelFamily = session.modelId
    ? String(session.modelId).toLowerCase().replace(/^claude-/, '').replace(/[^a-z]/g, '')
    : null

  nodes.hdrCwd.textContent = shortenPath(session.cwd, 42) || '—'
  nodes.hdrCwd.title = session.cwd || ''
}

// ---------- render ----------

let latest = null
let dataArrived = false

function renderTank (key, window) {
  const usedPercent = window ? window.percent : null
  const remaining = usedPercent === null ? null : 100 - usedPercent
  setNeedle(key, remaining === null ? 0 : remaining)
  setNeedleIdle(key, remaining === null)
  paintRing(key, remaining)

  const unsupported = Boolean(window && window.source === 'unsupported')
  cluster[key].readout.textContent = remaining === null
    ? (unsupported ? 'N/A' : '--')
    : remaining.toFixed(0) + '%'
  cluster[key].readout.classList.toggle('muted', remaining === null)

  if (cluster[key].lamp) {
    cluster[key].lamp.classList.toggle('lit', remaining !== null && remaining <= 15)
  }
  return remaining
}

function render (data) {
  latest = data
  dataArrived = true

  // speedometer — live consumption, always available from local transcripts
  const rate = data.tokensPerMinute || 0
  setNeedle('tach', rate)
  setNeedleIdle('tach', false)
  cluster.tach.readout.textContent = formatRate(rate)

  renderTank('tank5h', data.fiveHour)
  renderTank('tankWeek', data.sevenDay)

  const known = [data.fiveHour.percent, data.sevenDay.percent].filter(p => p !== null)
  const worst = known.length ? Math.max.apply(null, known) : null

  let mood
  if (worst === null) mood = MOOD_UNKNOWN
  else if (data.official.backingOff && data.fiveHour.source === 'local') mood = MOOD_THROTTLED
  else mood = MOODS.find(m => worst < m.max)

  nodes.mascot.textContent = mood.face
  nodes.mascot.title = mood.text
  // a poll landing mid-hop must not cancel the hop
  const hopping = nodes.mascot.classList.contains('boing')
  nodes.mascot.className = 'mascot ' + mood.cls + (hopping ? ' boing' : '')

  nodes.miniPct.textContent = data.fiveHour.percent === null
    ? '--'
    : (100 - data.fiveHour.percent).toFixed(0) + '%'

  renderHeader(data.session, data.appVersion)
  renderModelChip(data)
  renderTasks(data)
  renderOdometer(data)
  syncCollapsed(data)
  renderLock(data)

  if (data.account && data.account.email) {
    nodes.acct.textContent = data.account.email
    // join with a real newline without embedding an escape in this source
    nodes.acct.title = [data.account.email, data.account.org]
      .filter(Boolean).join(String.fromCharCode(10))
  } else if (data.session && data.session.company) {
    // Codex's account sits in auth.json, a credential file this app does not
    // read. Name the provider and plan instead of guessing at an identity.
    const plan = data.session.plan ? ' \u00b7 ' + data.session.plan : ''
    nodes.acct.textContent = data.session.company + plan
    nodes.acct.title = 'Signed in through the provider CLI'
  } else {
    nodes.acct.textContent = 'not signed in'
    nodes.acct.title = 'No account found'
  }

  nodes.reset.title = buildTooltip(data)
  tickCountdown()
}

function renderModelChip (data) {
  const configured = data.configuredModel
  const configuredValue = data.configuredModelValue

  const hasPicker = Array.isArray(data.modelOptions) && data.modelOptions.length > 0
  nodes.chipModel.classList.toggle('static', !hasPicker)
  nodes.chipModel.disabled = !hasPicker
  if (!hasPicker) closeMenu()

  if (!menuBuilt && hasPicker) {
    buildModelMenu(data.modelOptions, configuredValue)
  } else if (menuBuilt) {
    for (const item of nodes.modelMenu.querySelectorAll('.menu-item')) {
      item.classList.toggle('active', item.dataset.model === configuredValue)
    }
  }

  nodes.chipModel.textContent = configured || activeModelLabel || '—'

  // Compare FAMILIES, not display strings: `opus[1m]` and `claude-opus-5` are
  // the same model and must not read as a pending switch.
  const drifted = Boolean(
    data.configuredModelFamily && activeModelFamily &&
    data.configuredModelFamily !== activeModelFamily
  )
  nodes.chipModel.classList.toggle('pending', drifted)

  const nl = String.fromCharCode(10)
  const lines = []
  lines.push('Configured  ' + (configured || 'unset'))
  lines.push('Running     ' + (activeModelLabel || 'unknown'))
  if (drifted) lines.push('', 'Takes effect on the next Claude Code session.')
  const session = data.session
  if (session) {
    if (session.effort) lines.push('Effort      ' + session.effort)
    if (session.version) lines.push('Claude Code v' + session.version)
  }
  nodes.chipModel.title = lines.join(nl)
}

const MAX_TASK_ROWS = 4

function formatAge (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + (m % 60) + 'm'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}

/**
 * Live-session strip.
 *
 * Counts only sessions whose model family matches the one this dashboard is
 * reporting on — a window running a different model is listed but dimmed and
 * excluded from the headline count, since its usage is not what these gauges
 * are measuring.
 */
function renderTasks (data) {
  const sessions = data.liveSessions || []
  const family = data.configuredModelFamily || activeModelFamily

  const familyOf = id => id
    ? String(id).toLowerCase().replace(/^claude-/, '').replace(/[^a-z]/g, '')
    : null

  const matching = sessions.filter(s => family && familyOf(s.model) === family)
  const label = activeModelLabel || data.configuredModel || 'model'

  nodes.tasksTitle.textContent = 'SESSIONS'
  nodes.tasksCount.textContent = sessions.length === 0
    ? 'NONE'
    : matching.length + ' ON ' + label.toUpperCase() +
      (sessions.length > matching.length ? '  ·  ' + sessions.length + ' TOTAL' : '')

  nodes.tasksList.textContent = ''
  if (sessions.length === 0) {
    const row = document.createElement('div')
    row.className = 'task'
    const none = document.createElement('span')
    none.className = 'task-name other-model'
    none.textContent = 'No Claude Code windows running'
    row.appendChild(none)
    nodes.tasksList.appendChild(row)
    return
  }

  const now = Date.now()
  for (const s of sessions.slice(0, MAX_TASK_ROWS)) {
    const row = document.createElement('div')
    row.className = 'task'

    const dot = document.createElement('span')
    const state = (s.status || '').toLowerCase()
    dot.className = 'task-dot ' + (state === 'busy' ? 'busy' : state === 'idle' ? 'idle' : 'shell')
    row.appendChild(dot)

    const name = document.createElement('span')
    const sameModel = family && familyOf(s.model) === family
    name.className = 'task-name' + (sameModel ? '' : ' other-model')
    name.textContent = s.name || ('pid ' + s.pid)
    row.appendChild(name)

    const meta = document.createElement('span')
    meta.className = 'task-meta'
    meta.textContent = (s.status || '?') + ' · ' + formatAge(now - (s.updatedAt || now))
    row.appendChild(meta)

    const nl = String.fromCharCode(10)
    row.title = [
      s.name || ('pid ' + s.pid),
      'pid     ' + s.pid,
      'model   ' + (s.model || 'unknown'),
      'status  ' + (s.status || 'unknown'),
      'dir     ' + (s.cwd || 'unknown')
    ].join(nl)

    nodes.tasksList.appendChild(row)
  }

  if (sessions.length > MAX_TASK_ROWS) {
    const more = document.createElement('div')
    more.className = 'task-more'
    more.textContent = '+' + (sessions.length - MAX_TASK_ROWS) + ' MORE'
    nodes.tasksList.appendChild(more)
  }
}

/* ---------- unlock screen ----------
 *
 * This is a key-fob styled gate, not an authentication step. It never asks for
 * a credential: a provider counts as unlockable only when its CLI is already
 * signed in on this machine, and for anything else the sole action offered is
 * opening that provider's real site in the user's own browser.
 */

let selectedVendor = null
let vendorsBuilt = false

/** Flash the lamp without disturbing the colour it rests at. */
function blinkLed () {
  nodes.fobLed.classList.remove('blink')
  void nodes.fobLed.offsetWidth
  nodes.fobLed.classList.add('blink')
}

/**
 * Drive the whole fob between its two states: shackle, label and status lamp
 * all follow one flag, so the lamp can never disagree with the padlock.
 */
function setFobLabel (text) {
  const inner = nodes.fobLabel.firstElementChild
  if (!inner || inner.textContent === text) return
  nodes.fobLabel.classList.remove('swap')
  void nodes.fobLabel.offsetWidth
  nodes.fobLabel.classList.add('swap')
  // swap the word at the midpoint, while it is off-screen
  setTimeout(() => { inner.textContent = text }, 230)
  setTimeout(() => nodes.fobLabel.classList.remove('swap'), 480)
}

function setFobOpen (open) {
  nodes.fob.classList.toggle('open', open)
  nodes.fobLed.classList.toggle('on', open)
  setFobLabel(open ? 'UNLOCKED' : 'LOCKED')
}

/** Refusal: shake, without changing state. */
function denyFob () {
  nodes.fob.classList.remove('deny')
  void nodes.fob.offsetWidth
  nodes.fob.classList.add('deny')
  setTimeout(() => nodes.fob.classList.remove('deny'), 440)
}

// The main process pushes a fresh payload the instant the unlock succeeds, and
// that push would otherwise rip the overlay away before the shackle has moved.
// This holds renderLock off until the animation has actually played.
let unlockAnimating = false

function describeVendor (v) {
  if (!v) return '—'
  if (v.usable) return 'Signed in as ' + (v.account || 'this machine') + '. Press unlock.'
  if (v.supported && !v.present) return v.note + ' ' + v.signInHint
  return v.note
}

/**
 * The sign-in button appears only when signing in would actually change the
 * outcome. For a provider this dashboard cannot read, offering it would be a
 * false promise — being signed in through a browser does nothing here.
 */
function canOfferSignIn (v) {
  return Boolean(v && v.supported && !v.usable)
}

function selectVendor (v) {
  selectedVendor = v
  for (const btn of nodes.vendors.querySelectorAll('.vendor')) {
    btn.classList.toggle('selected', btn.dataset.vendor === v.id)
  }
  nodes.lockStatus.textContent = describeVendor(v)
  nodes.lockOpen.toggleAttribute('hidden', !canOfferSignIn(v))
}

function buildVendors (vendors) {
  nodes.vendors.textContent = ''
  for (const v of vendors) {
    const btn = document.createElement('button')
    btn.className = 'vendor'
    btn.dataset.vendor = v.id

    const dot = document.createElement('span')
    dot.className = 'vendor-dot ' + (v.usable ? 'ready' : v.present ? 'seen' : '')
    btn.appendChild(dot)

    const label = document.createElement('span')
    label.textContent = v.name
    btn.appendChild(label)

    btn.title = v.product + ' — ' + v.note
    btn.addEventListener('click', () => selectVendor(v))
    nodes.vendors.appendChild(btn)
  }
  vendorsBuilt = true

  // Default to whichever provider is actually usable.
  selectVendor(vendors.find(v => v.usable) || vendors[0])
}

nodes.fobUnlock.addEventListener('click', async () => {
  if (!selectedVendor) return

  if (!selectedVendor.usable) {
    blinkLed()
    denyFob()
    nodes.lockStatus.textContent = describeVendor(selectedVendor)
    return
  }

  const result = await window.meter.unlock(selectedVendor.id)
  if (!result || !result.ok) {
    blinkLed()
    denyFob()
    nodes.lockStatus.textContent = (result && result.reason) || 'Unlock failed.'
    return
  }

  unlockAnimating = true
  // lamp goes green and stays green; the blink just marks the moment
  setFobOpen(true)
  blinkLed()
  nodes.lockStatus.textContent = 'Unlocked. Starting up\u2026'

  // hold long enough for the shackle to swing before handing over to the dash
  setTimeout(() => {
    nodes.lock.setAttribute('hidden', '')
    unlockAnimating = false
    runIgnitionSweep()
  }, 780)
})

nodes.lockOpen.addEventListener('click', async () => {
  if (!selectedVendor) return
  const result = await window.meter.openVendor(selectedVendor.id)
  nodes.lockStatus.textContent = result && result.ok
    ? 'Opened ' + result.url + ' in your browser.'
    : 'Could not open the browser.'
})

/**
 * Keep the DOM's collapsed state in step with the window's.
 *
 * The window size is restored from disk on launch; without this the body class
 * never followed, and the full layout rendered clipped inside the pill.
 */
function syncCollapsed (data) {
  const shouldBeMini = Boolean(data.mini)
  if (document.body.classList.contains('mini') !== shouldBeMini) {
    document.body.classList.toggle('mini', shouldBeMini)
  }
}

function renderLock (data) {
  if (!vendorsBuilt && data.vendors) buildVendors(data.vendors)
  if (unlockAnimating) return

  const locked = !data.unlocked
  nodes.lock.toggleAttribute('hidden', !locked)
  // Re-locking from the header must put the shackle back down.
  if (locked) setFobOpen(false)
}

/**
 * Odometer, mechanical style.
 *
 * Digits are zero-padded to a fixed width and rendered one drum face per cell,
 * so the reading keeps a constant footprint as it climbs. Only cells whose
 * digit actually changed get the roll animation — repainting every wheel on
 * each tick would look like a slot machine rather than an odometer.
 */
const ODO_DIGITS = 9
const TRIP_DIGITS = 7

// last rendered string per drum, so we can tell which wheels moved
const drumState = new Map()

function paintDrum (container, value, width) {
  const text = String(Math.max(0, Math.round(value))).padStart(width, '0').slice(-width)
  const previous = drumState.get(container.id) || ''

  if (container.children.length !== width) {
    container.textContent = ''
    for (let i = 0; i < width; i++) {
      const cell = document.createElement('span')
      cell.className = 'odo-digit'
      cell.appendChild(document.createElement('span'))
      container.appendChild(cell)
    }
  }

  for (let i = 0; i < width; i++) {
    const cell = container.children[i]
    const digit = text[i]
    if (previous[i] === digit) continue
    cell.firstChild.textContent = digit
    cell.classList.remove('roll')
    void cell.offsetWidth
    cell.classList.add('roll')
  }

  drumState.set(container.id, text)
}

function renderOdometer (data) {
  const odo = data.odometer
  if (!odo) return

  paintDrum(nodes.odoTrip, odo.trip, TRIP_DIGITS)
  paintDrum(nodes.odoTotal, odo.total, ODO_DIGITS)

  const nl = String.fromCharCode(10)
  el('odo').title = [
    'ODO   ' + odo.total.toLocaleString('en-US') + ' tokens across ' +
      odo.files + ' transcripts (' + odo.turns.toLocaleString('en-US') + ' turns)',
    'TRIP  ' + odo.trip.toLocaleString('en-US') + ' tokens in the current session (' +
      odo.tripTurns.toLocaleString('en-US') + ' turns)',
    '',
    'Counts input + cache writes + output.',
    'Cache reads are excluded — they run ~15x everything else combined.'
  ].join(nl)
}

function buildTooltip (data) {
  const nl = String.fromCharCode(10)
  const lines = []
  lines.push('Source                ' +
    (data.official.backingOff ? 'throttled -> local' : data.fiveHour.source))
  lines.push('Output rate           ' + Math.round(data.tokensPerMinute || 0) + ' tok/min')
  lines.push('5-hour window spend   $' + data.spend.fiveHour.toFixed(2))
  lines.push('Weekly window spend   $' + data.spend.sevenDay.toFixed(2))
  lines.push('Local records         ' + data.localEvents)
  lines.push(data.fiveHour.anchorAt
    ? 'Official anchor       ' + Math.round((Date.now() - data.fiveHour.anchorAt) / 60000) + ' min ago'
    : 'Official anchor       none yet')
  if (data.official.nextPollAt > Date.now()) {
    lines.push('Next poll             in ' + Math.ceil((data.official.nextPollAt - Date.now()) / 60000) + ' min')
  }
  if (data.official.reason) lines.push('Last status           ' + data.official.reason)
  return lines.join(nl)
}

// Countdown ticks locally so the widget feels alive between polls.
function tickCountdown () {
  if (!latest) return
  const resetsAt = latest.fiveHour.resetsAt || latest.sevenDay.resetsAt
  nodes.reset.textContent = resetsAt
    ? '⟳ ' + formatCountdown(resetsAt - Date.now())
    : '⟳ reset time unknown'
}
// ticks every second now that the countdown is second-accurate
setInterval(tickCountdown, 1000)

// ---------- wiring ----------

nodes.mascot.addEventListener('click', () => {
  // Re-adding the class is not enough to replay a running animation; the
  // reflow read in between is what actually restarts it.
  nodes.mascot.classList.remove('boing')
  void nodes.mascot.offsetWidth
  nodes.mascot.classList.add('boing')
})
nodes.mascot.addEventListener('animationend', e => {
  if (e.animationName === 'boing') nodes.mascot.classList.remove('boing')
})

el('btn-refresh').addEventListener('click', e => {
  const btn = e.currentTarget
  btn.classList.add('spinning')
  setTimeout(() => btn.classList.remove('spinning'), 640)
  window.meter.refresh()
})
el('btn-lock').addEventListener('click', () => window.meter.lock())
el('btn-close').addEventListener('click', () => window.meter.close())
nodes.btnCloseMini.addEventListener('click', () => window.meter.close())

// Collapsing is reversible from a visible control, not only from the
// double-click shortcut — a hidden gesture is not a way out of a UI state.
function setCollapsed (collapsed) {
  document.body.classList.toggle('mini', collapsed)
  window.meter.setMini(collapsed)
}
el('btn-min').addEventListener('click', () => setCollapsed(true))
nodes.btnExpand.addEventListener('click', () => setCollapsed(false))
// double-clicking the pill still works, as a shortcut rather than the only way
nodes.card.addEventListener('dblclick', () => {
  if (document.body.classList.contains('mini')) setCollapsed(false)
})

buildCluster()

// Ignition self-test: every needle sweeps to full and settles back, the way a
// car's cluster does at startup. The spring supplies the overshoot for free.
// How long every needle is pinned at full scale before falling back to live
// values. A real cluster holds the sweep long enough to read as a deliberate
// self-test rather than a flicker.
const IGNITION_HOLD_MS = 1250

function runIgnitionSweep () {
  for (const key of DIAL_KEYS) {
    setNeedle(key, DIALS[key].max)
    if (DIALS[key].kind === 'ring') paintRing(key, DIALS[key].max)
  }
  setTimeout(() => {
    // settle straight onto the live values; the spring damps the overshoot
    if (latest) render(latest)
    else for (const key of DIAL_KEYS) setNeedle(key, 0)
  }, IGNITION_HOLD_MS)
}

// On a launch that is already unlocked, still run the self-test once.
setTimeout(() => { if (!nodes.lock.hasAttribute('hidden')) return; runIgnitionSweep() }, 150)

window.meter.onUpdate(render)
window.meter.ready()
