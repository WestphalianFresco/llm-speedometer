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
  vendorMark: el('vendor-mark'),
  vendorName: el('vendor-name'),
  vendorDots: el('vendor-dots'),
  lockStatus: el('lock-status'),
  lockOpen: el('lock-open'),
  odoTotal: el('odo-total'),
  odoTrip: el('odo-trip'),
  btnCloseMini: el('btn-close-mini'),
  miniPct: el('mini-pct'),
  miniRate: el('mini-rate-val')
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
 * One routine draws two gauge kinds, and all three carry a needle:
 *   'tach' - closed dial with a full tick ring and numerals
 *   'ring' - the same dial with an open arc lit from the E end behind the
 *            needle, so the level is readable both as a swept angle and as a
 *            length of lit track.
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
    // shorter and finer than the tach's: it sweeps a smaller face and must not
    // out-weigh the gauge it is drawn on
    needleLen: 40, needleTail: 7, needleW: [1.7, 0.7],
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
    needleLen: 50, needleTail: 9,
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
    needleLen: 40, needleTail: 7, needleW: [1.7, 0.7],
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

/**
 * A needle, drawn pointing right at the dial's centre and rotated from there by
 * the frame loop. Tapered tail-to-tip so it reads as a balanced pointer rather
 * than a stick, and always built into the group BEFORE the inner disc so the
 * tail disappears under it.
 */
function buildNeedle (dial) {
  const needle = svgEl('g', { class: 'needle' })
  needle.style.transformOrigin = dial.cx + 'px ' + dial.cy + 'px'
  const [tailW, tipW] = dial.needleW || [2.2, 0.8]
  const tailX = dial.cx - dial.needleTail
  const tipX = dial.cx + dial.needleLen
  needle.appendChild(svgEl('polygon', {
    points: [
      tailX + ',' + (dial.cy - tailW),
      tipX + ',' + (dial.cy - tipW),
      tipX + ',' + (dial.cy + tipW),
      tailX + ',' + (dial.cy + tailW)
    ].join(' '),
    class: 'needle-body',
    fill: 'var(--needle)'
  }))
  return needle
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

  // numerals on the scale, same treatment as the tach carries — laid down
  // before the needle so it sweeps over them rather than under, as on the tach
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

  const needle = buildNeedle(dial)
  g.appendChild(needle)

  // and the same inner face the readout sits on, over the needle's tail
  g.appendChild(svgEl('circle', { cx: dial.cx, cy: dial.cy, r: dial.discR, class: 'dial-disc' }))

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

  return { g: g, needle: needle, readout: readout, lamp: lamp, fill: fill }
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

  const needle = buildNeedle(dial)
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
/**
 * A second damping figure, used only while a needle is being returned from full
 * scale to a live reading.
 *
 * The normal spring is deliberately underdamped — that overshoot is what makes
 * the needles feel sprung rather than animated. But a rev drops the tach from
 * 20,000 to whatever you are actually running at, and an underdamped spring
 * takes a fall that big well past the target: to 4.7k on the way to 7.4k, and
 * straight through zero for any live rate under about 3k. That is the needle
 * hitting the bottom stop and climbing back, which is exactly what it looked
 * like.
 *
 * For K = 0.11 the discrete system stops overshooting at D <= 0.564, so this is
 * critical damping rather than a number picked by eye: the needle falls to the
 * live rate and stops there.
 */
const SPRING_D_SETTLE = 0.56

const makeDialState = dial => ({
  target: 0,
  current: 0,
  velocity: 0,
  // wander is authored as a percentage of full scale, so it looks the same on
  // a 0-100 tank as on a 0-100000 speedometer
  amplitude: (dial.wanderPct / 100) * dial.max,
  drift: 0,
  // while set, the needle is settling from a sweep and must not overshoot
  settleUntil: 0,
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

    const damping = now < s.settleUntil ? SPRING_D_SETTLE : SPRING_D
    s.velocity = (s.velocity + (s.target - s.current) * SPRING_K) * damping
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
      const value = Math.min(DIALS[key].max, Math.max(0, shown))
      applyNeedle(key, value)
      // during a blip the digits follow the needle, so the two never disagree
      if (revActive && key === 'tach') cluster.tach.readout.textContent = formatRate(value)
    }
  }

  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// ---------- personality ----------

/**
 * The mascot.
 *
 * It has a state, and each state has a bagful of faces rather than one. Which
 * face you get is chosen at random and held for a while, so glancing at the
 * widget twice does not give you the same picture twice — the way a desk toy
 * with a handful of frames feels alive without animating.
 *
 * State comes from what the app already knows: whether tokens are moving right
 * now, and how much of the window is left. Nothing here is decorative in the
 * sense of being made up — asleep really does mean nothing has been generated
 * for the whole rate window.
 */
const MOOD_FACES = {
  // nothing generated for the length of the rate window
  asleep: [
    '( ˘ω˘ ) zZ',
    '( ˘ ﻌ ˘ ) zZ',
    '( -ω- ) zZ',
    '( ˘_˘ ) zZ',
    '( ᴗ_ᴗ ) 💤',
    '( ﹏ ) zZ'
  ],
  // poked awake
  waking: [
    '( ⊙ o ⊙ )',
    '( º ﹏ º )',
    '( •o• )!',
    '( ˚ o ˚ )',
    '( ⊙_⊙ )?'
  ],
  // tokens are moving
  working: [
    '( •̀ ᴗ •́ )',
    '( ˶ ˃ ᗜ ˂ ˶ )',
    '( ｀ ω ´ )',
    '( ｀_´ )',
    '( •̀_•́ )',
    '( ˘ ³˘ )',
    '( ✧ ω ✧ )'
  ],
  // idle but awake, plenty left
  cruise: [
    '( ˶ˆ ᗜ ˆ˵ )',
    '( ˶• ᴗ •˵ )',
    '( ᵔ ᴗ ᵔ )',
    '( ˘ ᗜ ˘ )',
    '( ・ ω ・ )',
    '( ｡ ᵕ ｡ )'
  ],
  // three quarters gone
  tight: [
    '( ｡•́ - •̀｡ )',
    '( ˘ ︿ ˘ )',
    '( ・_・; )',
    '( ｡ ﾉ ω ＼ ｡ )',
    '( ˃ ᵕ ˂ ；)'
  ],
  // nearly out
  critical: [
    '( ; ᵕ ; )',
    '( ; ω ; )',
    '( ⌣́_⌣̀ )',
    '( ; ﹏ ; )',
    '( ｡ ; ﹏ ; ｡ )'
  ],
  // the API is refusing us and the numbers are local guesses
  throttled: [
    '( -ω- ) zZ',
    '( ˘ ~ ˘ ) …',
    '( ¬ ω ¬ )'
  ],
  // no reading yet
  unknown: [
    '( ˘ ω ˘ )',
    '( ・ ・ ? )',
    '( ˘ ? ˘ )'
  ]
}

const MOOD_TEXT = {
  asleep: 'Asleep — nothing running',
  waking: 'Oh! I am up, I am up',
  working: 'Working',
  cruise: 'Plenty in the tank',
  tight: 'Getting a bit tight…',
  critical: 'Almost out! Go easy!',
  throttled: 'API throttled — local estimate',
  unknown: 'Still getting to know you…'
}

// Which states read as "eyes shut" for styling, and which as alarm.
const MOOD_CLASS = { asleep: 'sleep', throttled: 'sleep', critical: 'panic' }

// A face is held this long before another is drawn from the same bag. Long
// enough that it is never a flicker, short enough that you catch it changing.
const FACE_HOLD_MS = 11000
// How long being poked awake lasts before the real state takes over again.
const WAKE_MS = 3200
// Below this the needle is not really moving; the rate window is ten minutes,
// so zero here means nothing has been generated in that whole time.
const WORKING_TOK_MIN = 1

let moodState = null
let moodFace = null
let moodShownAt = 0
let wakeUntil = 0

/** Pick a face from a bag, avoiding the one already on screen. */
function pickFace (state) {
  const bag = MOOD_FACES[state] || MOOD_FACES.unknown
  if (bag.length === 1) return bag[0]
  let face = moodFace
  while (face === moodFace) face = bag[Math.floor(Math.random() * bag.length)]
  return face
}

/** What the mascot should be feeling, from the numbers alone. */
function moodStateFor (data) {
  if (Date.now() < wakeUntil) return 'waking'

  const known = [data.fiveHour.percent, data.sevenDay.percent].filter(p => p !== null)
  const worst = known.length ? Math.max.apply(null, known) : null

  if (worst !== null && worst >= 90) return 'critical'
  if (data.official && data.official.backingOff && data.fiveHour.source === 'local') {
    return 'throttled'
  }
  if (worst === null) return 'unknown'
  if ((data.tokensPerMinute || 0) < WORKING_TOK_MIN) return 'asleep'
  if (worst >= 75) return 'tight'
  if ((data.tokensPerMinute || 0) >= WORKING_TOK_MIN) return 'working'
  return 'cruise'
}

function renderMood (data) {
  const state = moodStateFor(data)
  const now = Date.now()

  // A new state redraws at once; the same state redraws when its face has been
  // up long enough, so the mascot keeps changing while nothing else does.
  if (state !== moodState || now - moodShownAt > FACE_HOLD_MS) {
    moodState = state
    moodFace = pickFace(state)
    moodShownAt = now
  }

  nodes.mascot.textContent = moodFace
  nodes.mascot.title = MOOD_TEXT[state] || ''
  // a poll landing mid-hop must not cancel the hop
  const hopping = nodes.mascot.classList.contains('boing')
  nodes.mascot.className = 'mascot ' + (MOOD_CLASS[state] || '') + (hopping ? ' boing' : '')
}

/** Poking it wakes it up, and it stays startled for a moment. */
function wakeMascot () {
  const wasAsleep = moodState === 'asleep' || moodState === 'throttled'
  if (wasAsleep) {
    wakeUntil = Date.now() + WAKE_MS
    moodState = null          // force a redraw into the waking bag
    if (latest) renderMood(latest)
    return
  }
  // already awake: just pull a different face out of the current bag
  moodFace = pickFace(moodState || 'cruise')
  moodShownAt = Date.now()
  nodes.mascot.textContent = moodFace
}

// While asleep or startled nothing else is repainting, so the face is kept
// turning here rather than waiting for the next poll.
setInterval(() => { if (latest) renderMood(latest) }, 2000)

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

  // speedometer — live consumption, always available from local transcripts
  // A blip owns the tach until it finishes; a poll landing mid-rev must not
  // yank the needle out of the sweep. The blip reads `latest` when it settles,
  // so it lands on this rate anyway.
  const rate = data.tokensPerMinute || 0
  if (!revActive) {
    setNeedle('tach', rate)
    setNeedleIdle('tach', false)
    cluster.tach.readout.textContent = formatRate(rate)
  }

  renderTank('tank5h', data.fiveHour)
  renderTank('tankWeek', data.sevenDay)

  renderMood(data)

  nodes.miniPct.textContent = data.fiveHour.percent === null
    ? '--'
    : (100 - data.fiveHour.percent).toFixed(0) + '%'
  // the speedometer's reading, carried into the collapsed pill
  nodes.miniRate.textContent = formatRate(rate)

  renderHeader(data.session, data.appVersion)
  renderModelChip(data)
  renderTasks(data)
  renderOdometer(data)
  renderSettings(data)
  renderGearbox(data)
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
let vendorList = []
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
  const index = vendorList.findIndex(x => x.id === v.id)
  nodes.vendorMark.textContent = emojiFor(v.id)
  nodes.vendorName.textContent = v.name
  for (const [i, dot] of [...nodes.vendorDots.children].entries()) {
    dot.classList.toggle('on', i === index)
  }
  nodes.lockStatus.textContent = describeVendor(v)
  nodes.lockOpen.toggleAttribute('hidden', !canOfferSignIn(v))
}

/** Step the picker along, wrapping at both ends. */
function stepVendor (by) {
  if (vendorList.length < 2) return
  const index = vendorList.findIndex(v => v.id === (selectedVendor || {}).id)
  const next = (index + by + vendorList.length) % vendorList.length
  selectVendor(vendorList[next])
}

function buildVendors (vendors) {
  vendorList = vendors
  // One dot per provider, so it is obvious there are others to step to.
  nodes.vendorDots.textContent = ''
  for (const v of vendors) {
    const dot = document.createElement('span')
    dot.className = 'picker-dot ' + (v.usable ? 'ready' : v.present ? 'seen' : '')
    dot.title = v.name + ' — ' + v.note
    dot.addEventListener('click', () => selectVendor(v))
    nodes.vendorDots.appendChild(dot)
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

  // Claim the animation BEFORE awaiting. The main process pushes a fresh
  // payload from inside its unlock handler, and that payload lands here the
  // moment the await resolves -- if the flag were still false, renderLock
  // would tear the overlay away before the shackle had moved at all.
  unlockAnimating = true

  const result = await window.meter.unlock(selectedVendor.id)
  if (!result || !result.ok) {
    unlockAnimating = false
    blinkLed()
    denyFob()
    nodes.lockStatus.textContent = (result && result.reason) || 'Unlock failed.'
    return
  }

  // lamp goes green and stays green; the blink just marks the moment
  setFobOpen(true)
  blinkLed()
  nodes.lockStatus.textContent = 'Unlocked. Starting up\u2026'

  // Three beats rather than one hard cut: the shackle pops, it is allowed to
  // sit open long enough to actually be read, then the panel dissolves away
  // and the cluster sweeps up behind it.
  const POP_MS = 620      // shackle swings and settles
  const DISSOLVE_MS = 460 // must match the lock-out keyframe

  setTimeout(() => {
    nodes.lock.classList.add('opening')
    // the sweep starts under the dissolve, so the needles are already moving
    // by the time the panel clears
    runIgnitionSweep()
  }, POP_MS)

  setTimeout(() => {
    nodes.lock.setAttribute('hidden', '')
    nodes.lock.classList.remove('opening')
    unlockAnimating = false
  }, POP_MS + DISSOLVE_MS)
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

// The panel is painted at launch, so it is only ever "entering" when it comes
// back after an unlock — which is the one time it should animate.
let wasUnlocked = false

function renderLock (data) {
  if (!vendorsBuilt && data.vendors) buildVendors(data.vendors)
  if (unlockAnimating) return

  const locked = !data.unlocked
  if (locked && wasUnlocked) {
    nodes.lock.classList.remove('entering')
    void nodes.lock.offsetWidth
    nodes.lock.classList.add('entering')
  }
  wasUnlocked = !locked
  nodes.lock.toggleAttribute('hidden', !locked)
  if (locked) {
    // clear the exit animation, or the panel returns already faded out
    nodes.lock.classList.remove('opening')
    setFobOpen(false)
  }
}

/**
 * Odometer, mechanical style.
 *
 * Each digit is a drum: a strip of faces behind a slot, translated so the face
 * you want sits in the window. A wheel going 7 -> 2 therefore rolls up through
 * 8, 9, 0, 1 and stops on 2, the way a real one has to — it cannot get there
 * any other way. The strip carries two runs of 0-9 so a wrap has somewhere to
 * roll into, and snaps silently back to the single-run position afterwards.
 *
 * The wheels do not all go at once either. On a real odometer a wheel only
 * turns when the one to its right carries into it, so each place starts a beat
 * later than its neighbour and the change ripples leftward.
 */
// Both drums carry the same number of wheels, so the two readings line up
// column for column and the trip pads with leading zeroes rather than sitting
// short and inset.
const ODO_DIGITS = 9
const TRIP_DIGITS = 9

const DRUM_FACES = 20            // 0-9 twice, so a 9 -> 0 wrap has road ahead
const DRUM_STAGGER_MS = 80       // how far each place lags the one to its right
const DRUM_BASE_MS = 180
const DRUM_STEP_MS = 55          // added per digit the wheel has to travel
const DRUM_MAX_MS = 900
const DRUM_MAX_DELAY_MS = 400    // a nine-wide cascade must not crawl

// Percentages on transform resolve against the element's own height, so a
// strip of 20 faces moves exactly one face per 5% — no measuring required.
const drumPos = index => 'translateY(-' + (index * (100 / DRUM_FACES)) + '%)'

// last rendered string per drum, so we can tell which wheels moved
const drumState = new Map()

function buildDrum (container, width) {
  container.textContent = ''
  for (let i = 0; i < width; i++) {
    const cell = document.createElement('span')
    cell.className = 'odo-digit'
    const strip = document.createElement('span')
    strip.className = 'odo-strip'
    for (let f = 0; f < DRUM_FACES; f++) {
      const face = document.createElement('span')
      face.className = 'odo-face'
      face.textContent = String(f % 10)
      strip.appendChild(face)
    }
    strip.style.transform = drumPos(0)
    cell.appendChild(strip)
    container.appendChild(cell)
  }
}

function rollCell (cell, from, to, delay) {
  const dist = (to - from + 10) % 10
  if (dist === 0) return
  const strip = cell.firstChild
  const duration = Math.min(DRUM_MAX_MS, DRUM_BASE_MS + dist * DRUM_STEP_MS)

  // park on the face we are leaving before arming the transition, or a wheel
  // caught mid-roll would animate from wherever it happened to be
  strip.style.transition = 'none'
  strip.style.transform = drumPos(from)
  void strip.offsetWidth
  strip.style.transition =
    'transform ' + duration + 'ms cubic-bezier(.25,.8,.3,1) ' + delay + 'ms'
  strip.style.transform = drumPos(from + dist)

  // Landing on the second run of faces is only ever a stand-in for the first;
  // drop back to the real position once the eye is done with the movement.
  clearTimeout(cell.snapTimer)
  cell.snapTimer = setTimeout(() => {
    strip.style.transition = 'none'
    strip.style.transform = drumPos(to)
  }, delay + duration + 20)
}

function paintDrum (container, value, width) {
  const text = String(Math.max(0, Math.round(value))).padStart(width, '0').slice(-width)
  // A drum with no history starts from all zeroes rather than from nothing, so
  // the first reading winds up into place instead of appearing fully formed.
  const previous = drumState.get(container.id) || '0'.repeat(width)

  if (container.children.length !== width) buildDrum(container, width)

  for (let i = 0; i < width; i++) {
    const delay = Math.min(DRUM_MAX_DELAY_MS, (width - 1 - i) * DRUM_STAGGER_MS)
    rollCell(container.children[i], Number(previous[i]), Number(text[i]), delay)
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
  // Spelled out because the footer can only count down one window at a time,
  // and which one it picked is otherwise invisible.
  lines.push('5-hour resets         ' + (data.fiveHour.resetsAt
    ? new Date(data.fiveHour.resetsAt).toLocaleTimeString()
    : 'unknown until the next official poll'))
  lines.push('Weekly resets         ' + (data.sevenDay.resetsAt
    ? new Date(data.sevenDay.resetsAt).toLocaleString()
    : 'unknown until the next official poll'))
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
//
// This line is the 5-hour window and nothing else. It used to fall through to
// the weekly reset whenever the 5-hour one was unknown, which put a number in
// days on a readout everybody reads as the short window — worse than admitting
// the value is not known yet. The weekly reset is still in the diagnostics
// tooltip, where a multi-day figure is labelled and expected.
function tickCountdown () {
  if (!latest) return
  const five = latest.fiveHour.resetsAt
  nodes.reset.textContent = five
    ? '⟳ 5H · ' + formatCountdown(five - Date.now())
    : '⟳ 5H · reset time unknown'
}
// ticks every second now that the countdown is second-accurate
setInterval(tickCountdown, 1000)

/* ---------- throttle blip ----------
 *
 * Purely cosmetic: it sweeps the needle and makes a noise, and changes no
 * reading. The live value is restored the moment it settles.
 *
 * The sound is synthesised rather than shipped as an asset — two detuned
 * sawtooths for the engine body, filtered noise for induction roar, and a
 * lowpass that opens with the revs. No file, no network, and nothing for the
 * page's content policy to block.
 */
let audioCtx = null
let audioOut = null
let revActive = false

// Everything audible routes through one gain node, so the volume slider and
// the mute switch have a single place to act rather than each voice carrying
// its own copy of the preference.
let soundEnabled = true
let soundVolume = 0.8

function getAudio () {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    audioCtx = new Ctor()
    audioOut = audioCtx.createGain()
    audioOut.gain.value = soundEnabled ? soundVolume : 0
    audioOut.connect(audioCtx.destination)
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

/** The node every voice connects to instead of ctx.destination. */
const audioBus = ctx => audioOut || ctx.destination

function setSoundLevel (enabled, volume) {
  soundEnabled = enabled
  soundVolume = volume
  // the recordings sit outside the bus, so they are set directly
  const level = enabled ? volume : 0
  revSample.setVolume(level)
  startSample.setVolume(level)
  if (!audioOut) return
  const t = audioCtx.currentTime
  holdParam(audioOut.gain, t)
  audioOut.gain.linearRampToValueAtTime(enabled ? volume : 0, t + 0.08)
}

// White noise is the raw material for both the induction roar and the
// starter's brush hiss; the character comes from the filter each one runs it
// through, not from the sample.
function noiseSource (ctx, seconds) {
  const frames = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
  const source = ctx.createBufferSource()
  source.buffer = buffer
  return source
}

/**
 * The recorded sound effects.
 *
 * Both of them want exactly the same handling, so they share one:
 *
 *   - Built on first press rather than at load. Creating a media element up
 *     front races the audio output coming up and produces an
 *     AUDIO_RENDERER_ERROR, which is a transient condition, not a missing file.
 *   - A failure drops the element instead of setting a flag, so the next press
 *     builds a fresh one and tries again rather than one bad moment at startup
 *     silencing the app for the session.
 *   - Played from a chosen point, because both files open with silence and one
 *     of them holds three takes back to back.
 *   - Faded rather than cut, since stopping a recording dead sounds like a file
 *     ending, which is exactly what it is.
 *
 * They play through plain <audio> elements rather than the Web Audio bus:
 * feeding a file:// media element into a MediaElementAudioSourceNode taints it
 * and the node emits silence, so the sound settings are applied to each
 * element's own volume instead.
 *
 * @param {string} src
 * @param {{from?: number, ms?: number, fade?: number}} opts `ms` is how long to
 *   play before fading on its own; leave it out for a sound that is stopped by
 *   whatever started it.
 */
function makeSample (src, opts) {
  const from = opts.from || 0
  const runFor = opts.ms || 0
  const fadeMs = opts.fade || 240
  let el = null
  let stopTimer = null
  let fadeTimer = null

  const element = () => {
    if (el) return el
    const made = new Audio(src)
    made.preload = 'auto'
    made.volume = soundEnabled ? soundVolume : 0
    made.addEventListener('error', () => {
      console.warn(src + ' failed, will retry on the next press:',
        made.error && made.error.message)
      if (el === made) el = null
    })
    el = made
    return made
  }

  const fadeOut = () => {
    const playing = el
    if (!playing || playing.paused) return
    clearInterval(fadeTimer)
    let left = fadeMs
    fadeTimer = setInterval(() => {
      left -= 40
      playing.volume = Math.max(0, soundVolume * (left / fadeMs))
      if (left > 0) return
      clearInterval(fadeTimer)
      playing.pause()
      playing.volume = soundVolume
    }, 40)
  }

  return {
    play () {
      if (!soundEnabled) return
      const playing = element()
      clearTimeout(stopTimer)
      clearInterval(fadeTimer)
      playing.volume = soundVolume
      try {
        playing.currentTime = from
      } catch {
        // seeking before metadata has arrived throws; starting from the top
        // costs one press its promptness and nothing else
      }
      playing.play().catch(() => { /* the press beat the decoder to it */ })
      if (runFor) stopTimer = setTimeout(fadeOut, runFor - fadeMs)
    },
    setVolume (v) { if (el) el.volume = v }
  }
}

/*
 * sfx/rev.mp4 is an engine being blipped: silence, then two swells with a dip
 * between them, tapering out by about 4.8 seconds. It plays all the way through
 * rather than being cut off when the throttle closes — the recording is a
 * complete rev and gets to finish as one. Every press restarts it, which is
 * what makes repeated presses sound like repeated blips rather than one clip
 * playing over itself.
 */
const REV_SOUND_MS = 4450
const revSample = makeSample('sfx/rev.mp4',
  { from: 0.5, ms: REV_SOUND_MS, fade: 250 })

/*
 * sfx/engine-start.mp4 holds three takes back to back with silence between
 * them, so only the first is played — in at 0.15s, out at 2.0s.
 */
const IGNITION_MS = 1850
const startSample = makeSample('sfx/engine-start.mp4',
  { from: 0.15, ms: IGNITION_MS, fade: 200 })

const playRevSound = () => revSample.play()
const playIgnition = () => startSample.play()

/* How long one press keeps the throttle open. Pressing again inside this
   window extends it rather than restarting a fresh blip, so leaning on the
   button holds the engine up the way a real one stays up.
   Net of the ~300ms it takes to climb, this is the time spent up at the top,
   which is the part of a blip worth hearing. */
const REV_HOLD_MS = 1150
// After release: the needle falls, the note drops, and only then does the
// gauge go back to reporting.
const REV_FALL_MS = 700
// The limiter does not hold a perfectly steady number — it bounces between
// full scale and a little under it, which is what keeps the needle alive at
// the top instead of pinned like a stuck gauge.
const LIMITER_MS = 150
// Shallow on purpose: the spring only partly follows a target this brief, so a
// deep dip would swing the needle several degrees and flick the digits back
// and forth across the 19k/20k rounding boundary. This flutters and holds.
const LIMITER_DIP = 0.97

let revHoldTimer = null
let revFallTimer = null
let revLimiterTimer = null
let revPreTarget = 0

function revEngine () {
  const alreadyUp = revActive
  // Where the needle came from, as the fallback for a blip before any data has
  // landed. A blip drops back to the live rate, not to an invented idle mark —
  // settling on a number the gauge never measured read as the needle sticking.
  if (!alreadyUp) revPreTarget = dialState.tach.target

  revActive = true
  clearTimeout(revHoldTimer)
  clearTimeout(revFallTimer)

  // Every press restarts the clip, which is what makes repeated presses sound
  // like repeated blips rather than one recording playing over itself.
  playRevSound()

  if (!revLimiterTimer) {
    setNeedle('tach', DIALS.tach.max)
    let high = true
    revLimiterTimer = setInterval(() => {
      high = !high
      setNeedle('tach', high ? DIALS.tach.max : DIALS.tach.max * LIMITER_DIP)
    }, LIMITER_MS)
  }

  revHoldTimer = setTimeout(revRelease, REV_HOLD_MS)
}

function revRelease () {
  clearInterval(revLimiterTimer)
  revLimiterTimer = null
  // Coming down off the limiter is the one moment the tach must not overshoot:
  // the drop is most of the dial, and an underdamped return goes through the
  // bottom stop before climbing back to the live rate.
  dialState.tach.settleUntil = performance.now() + REV_FALL_MS + 400
  setNeedle('tach', latest ? latest.tokensPerMinute || 0 : revPreTarget)
  revFallTimer = setTimeout(() => {
    revActive = false
    if (latest) render(latest)
  }, REV_FALL_MS)
}

// ---------- gearbox ----------

/**
 * A clutch and an H-pattern shifter for choosing a model.
 *
 * The point of the metaphor is that it behaves like the thing it looks like:
 *
 *   - The lever will not leave a gate with the clutch up. Forcing it grinds,
 *     and the lever stays where it was.
 *   - Movement is constrained to the gate, not to the pointer. You travel along
 *     a slot to the neutral rail, across the rail, then down another slot —
 *     exactly as a real gate makes you.
 *   - Nothing engages while the clutch is down. The model changes at the bite
 *     point on the way back up, which is when a real one takes drive.
 *
 * The renderer never sends a model name anywhere. It sends the provider id and
 * the gear number it is in; main resolves those against the catalogue and is
 * the only thing that decides what, if anything, gets written.
 */

// A provider accent goes into a CSS custom property, so it is confirmed to be
// a plain hex colour first.
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i

/** The provider's emoji, from whichever catalogue entry matches. */
function emojiFor (id) {
  const found = gbCatalog.find(p => p.id === id)
  return found && found.emoji ? found.emoji : '\u2022'
}

const gbNodes = {
  panel: el('gearbox'),
  close: el('gb-close'),
  help: el('gb-help'),
  hint: el('gb-hint'),
  hintOk: el('gb-hint-ok'),
  makes: el('gb-makes'),
  makeMark: el('gb-make-mark'),
  makeName: el('gb-make-name'),
  prev: el('gb-prev'),
  next: el('gb-next'),
  pedal: el('gb-pedal'),
  gate: el('gb-gate'),
  lamp: el('gb-lamp'),
  status: el('gb-status'),
  note: el('gb-note')
}

// gate geometry, in the gate's own viewBox units
const GATE_W = 260
const RAIL_Y = 105
const SLOT_TOP = 52
const SLOT_BOTTOM = 158
const SLOT_GAP = 70
const DETENT_R = 22      // how close to a gear counts as being in it
/*
 * Two thresholds, not one, and this matters more than it looks.
 *
 * Leaving a slot for the rail happens close in (RAIL_EXIT); being taken BY a
 * slot needs a decisive pull away from it (SLOT_ENTER). The gap between them is
 * the band you can travel across the rail in. Sharing a single threshold left
 * that band 9 units wide — about fifteen screen pixels — so any wobble while
 * moving sideways dropped the lever straight back into a slot, and the lever
 * could not be moved horizontally at all.
 */
const RAIL_EXIT = 14     // this close to the rail and the slot lets go
const SLOT_ENTER = 30    // this far off it before a slot takes hold
const SLOT_SNAP = 22     // ...and only near that slot's mouth
const BITE_MS = 190      // clutch travel before it takes drive

let gbCatalog = []
let gbProviderId = null
let gbState = { providerId: null, gear: null, previous: null }
let gbSlots = []         // x of each column
let gbPositions = []     // { gear, label, detail, x, y, node }
let clutchDown = false
let clutchMode = null
let dragging = false
let lever = { x: GATE_W / 2, y: RAIL_Y, lane: null }
let leverNode = null
let leverPos = null
let biteTimer = null
let lastDetent = null

const gbProvider = () => gbCatalog.find(p => p.id === gbProviderId) || gbCatalog[0] || null

/**
 * Where each gear sits. Columns fill left to right, top before bottom, and
 * reverse takes the next free position after the last gear — which is how a
 * five-speed ends up with R in the bottom right and a four-speed does not.
 */
function layoutGate (provider) {
  const gears = provider ? provider.gears : []
  const slots = Math.max(2, Math.ceil((gears.length + 1) / 2))
  const span = (slots - 1) * SLOT_GAP
  const left = (GATE_W - span) / 2

  gbSlots = []
  for (let i = 0; i < slots; i++) gbSlots.push(left + i * SLOT_GAP)

  const at = index => ({
    x: gbSlots[Math.floor(index / 2)],
    y: index % 2 === 0 ? SLOT_TOP : SLOT_BOTTOM
  })

  const positions = gears.map((g, i) => ({
    gear: g.gear, label: g.label, detail: g.detail, ...at(i)
  }))
  positions.push({ gear: 'R', label: 'Reverse', detail: 'last model', ...at(gears.length) })
  return positions
}

function buildGate () {
  const provider = gbProvider()
  gbNodes.gate.textContent = ''
  gbPositions = layoutGate(provider)
  if (!provider) return

  const defs = svgEl('defs', {})
  const grad = svgEl('radialGradient', { id: 'gb-knob-fill', cx: '35%', cy: '30%', r: '75%' })
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#6A6353' }))
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#2A251D' }))
  defs.appendChild(grad)
  gbNodes.gate.appendChild(defs)

  // The gate is cut into a plate: a wide dark stroke for the channel, a lighter
  // one inside it for the machined lip.
  // Only the legs that lead somewhere are cut. A two-speed box has no gate to
  // the bottom right, and drawing one implies a gear that is not there.
  const occupied = (x, y) => gbPositions.some(p => p.x === x && p.y === y)
  const parts = ['M' + gbSlots[0] + ' ' + RAIL_Y + ' H' + gbSlots[gbSlots.length - 1]]
  for (const x of gbSlots) {
    if (occupied(x, SLOT_TOP)) parts.push('M' + x + ' ' + SLOT_TOP + ' V' + RAIL_Y)
    if (occupied(x, SLOT_BOTTOM)) parts.push('M' + x + ' ' + RAIL_Y + ' V' + SLOT_BOTTOM)
  }
  const d = parts.join(' ')
  gbNodes.gate.appendChild(svgEl('path', { d: d, class: 'gb-slot', 'stroke-width': 19 }))
  gbNodes.gate.appendChild(svgEl('path', { d: d, class: 'gb-slot-lip', 'stroke-width': 13 }))

  for (const pos of gbPositions) {
    const group = svgEl('g', { class: 'gb-gear' })
    group.dataset.gear = String(pos.gear)
    group.appendChild(svgEl('circle', { cx: pos.x, cy: pos.y, r: 9, class: 'gb-detent' }))

    // Both labels clear the knob, which covers 13 units either side of the
    // detent — the model name used to sit under it in the top row.
    const above = pos.y === SLOT_TOP
    const num = svgEl('text', { x: pos.x, y: pos.y + (above ? -19 : 27), class: 'gb-gear-num' })
    num.textContent = String(pos.gear)
    group.appendChild(num)

    const name = svgEl('text', { x: pos.x, y: pos.y + (above ? -30 : 37), class: 'gb-gear-name' })
    name.textContent = pos.label
    group.appendChild(name)

    gbNodes.gate.appendChild(group)
    pos.node = group
  }

  // Two groups, not one. The outer carries the position and the inner carries
  // the shake — a CSS transform on the same element would win over the
  // positioning transform attribute and fling the lever to the origin for as
  // long as the animation ran.
  leverPos = svgEl('g', {})
  leverNode = svgEl('g', { class: 'gb-lever' })
  leverNode.appendChild(svgEl('ellipse', { class: 'gb-knob-shadow', cx: 0, cy: 8, rx: 13, ry: 4 }))
  leverNode.appendChild(svgEl('line', { class: 'gb-shaft', x1: 0, y1: 4, x2: 0, y2: 17 }))
  leverNode.appendChild(svgEl('circle', { class: 'gb-knob', cx: 0, cy: 0, r: 13 }))
  leverNode.appendChild(svgEl('path', { class: 'gb-knob-cap', d: 'M-7 -5 A8 8 0 0 1 6 -6' }))
  leverPos.appendChild(leverNode)
  gbNodes.gate.appendChild(leverPos)

  const home = gbPositions.find(p => p.gear === gbState.gear)
  placeLever(home ? home.x : GATE_W / 2, home ? home.y : RAIL_Y)
  lever.lane = home ? gbSlots.indexOf(home.x) : null
  markEngaged()
}

function placeLever (x, y) {
  lever.x = x
  lever.y = y
  if (leverPos) {
    leverPos.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')')
  }
}

/** The gear the lever is currently sitting in, or null for neutral. */
function gearUnderLever () {
  for (const pos of gbPositions) {
    const dx = pos.x - lever.x
    const dy = pos.y - lever.y
    if (dx * dx + dy * dy <= DETENT_R * DETENT_R) return pos
  }
  return null
}

function markEngaged () {
  for (const pos of gbPositions) {
    if (pos.node) pos.node.classList.toggle('on', pos.gear === gbState.gear)
  }
}

/**
 * Constrain a pointer position to the gate.
 *
 * The lever is either on the rail or in a slot, and can only change between the
 * two at a crossing. This is the whole feel of an H-pattern: you cannot cut the
 * corner from 1st to 2nd, you go up, across, and down.
 */
/** Is there a gear at this slot's top or bottom end? */
const legExists = (slotX, down) =>
  gbPositions.some(p => p.x === slotX && p.y === (down ? SLOT_BOTTOM : SLOT_TOP))

/** Keep a position inside the legs that this slot actually has. */
const clampSlot = (slotX, py) => Math.min(
  legExists(slotX, true) ? SLOT_BOTTOM : RAIL_Y,
  Math.max(legExists(slotX, false) ? SLOT_TOP : RAIL_Y, py))

function constrain (px, py) {
  const first = gbSlots[0]
  const last = gbSlots[gbSlots.length - 1]
  const off = py - RAIL_Y

  if (lever.lane === null) {
    const x = Math.min(last, Math.max(first, px))
    // A slot takes the lever only on a decisive pull away from the rail, near
    // that slot's mouth, and only if there is a leg to pull into.
    if (Math.abs(off) > SLOT_ENTER) {
      const near = gbSlots.findIndex(sx => Math.abs(sx - x) < SLOT_SNAP)
      if (near !== -1 && legExists(gbSlots[near], off > 0)) {
        lever.lane = near
        return { x: gbSlots[near], y: clampSlot(gbSlots[near], py) }
      }
    }
    return { x: x, y: RAIL_Y }
  }

  const slotX = gbSlots[lever.lane]
  const y = clampSlot(slotX, py)
  // back at the rail, the lever is free to travel across it again
  if (Math.abs(y - RAIL_Y) < RAIL_EXIT) {
    lever.lane = null
    return { x: slotX, y: RAIL_Y }
  }
  return { x: slotX, y: y }
}

function gatePoint (event) {
  const box = gbNodes.gate.getBoundingClientRect()
  if (!box.width) return null
  const scale = GATE_W / box.width
  return {
    x: (event.clientX - box.left) * scale,
    y: (event.clientY - box.top) * scale
  }
}

function refuse () {
  if (!leverNode) return
  leverNode.classList.remove('grind')
  void leverNode.getBoundingClientRect()
  leverNode.classList.add('grind')
  playGrind()
  setGearStatus('Clutch is up — the lever will not move.', 'slipping')
}

function moveLever (point) {
  const next = constrain(point.x, point.y)
  placeLever(next.x, next.y)
  const found = gearUnderLever()
  const key = found ? String(found.gear) : null
  if (key !== lastDetent) {
    lastDetent = key
    if (found) { playDetent(); describeGear(found) }
    else setGearStatus('Neutral. Slot the lever into a gear.', null)
  }
}

function describeGear (pos) {
  const provider = gbProvider()
  const suffix = pos.detail ? ' · ' + pos.detail : ''
  const how = clutchMode === 'latch' ? 'click the pedal to engage' : 'release the clutch to engage'
  setGearStatus(pos.gear === 'R'
    ? 'Reverse — back to the last model  (' + how + ')'
    : pos.label + suffix + '  (' + how + ')', null)
  if (provider) gbNodes.note.textContent = provider.note || ''
}

function setGearStatus (text, lamp) {
  gbNodes.status.textContent = text
  gbNodes.lamp.classList.toggle('engaged', lamp === 'engaged')
  gbNodes.lamp.classList.toggle('slipping', lamp === 'slipping')
}

// ---- the clutch itself ----

/**
 * @param {'latch'|'hold'} mode how the clutch was put down, which decides how
 *   it comes back up. A foot stays on a pedal while a hand shifts; a pointer
 *   cannot, because there is only one of it. So the pedal latches when clicked
 *   and a second click lets it up, while the keyboard clutch stays momentary
 *   and behaves like the real thing.
 */
function pressClutch (mode) {
  if (clutchDown) return
  clutchMode = mode
  clutchDown = true
  clearTimeout(biteTimer)
  gbNodes.pedal.classList.add('down')
  gbNodes.pedal.setAttribute('aria-pressed', 'true')
  if (leverNode) leverNode.classList.add('free')
  playClutch(true)
  setGearStatus(mode === 'latch'
    ? 'Clutch in — drag the lever, then click the pedal to engage.'
    : 'Clutch in — the lever is free.', 'slipping')
}

function releaseClutch () {
  if (!clutchDown) return
  clutchDown = false
  dragging = false
  gbNodes.pedal.classList.remove('down')
  gbNodes.pedal.setAttribute('aria-pressed', 'false')
  if (leverNode) leverNode.classList.remove('free')
  playClutch(false)

  // Drive is taken at the bite point, part way through the pedal coming back —
  // not the instant it is let go.
  clearTimeout(biteTimer)
  biteTimer = setTimeout(() => {
    const found = gearUnderLever()
    if (!found) { setGearStatus('Neutral.', null); return }
    engageGear(found.gear)
  }, BITE_MS)
}

async function engageGear (gear) {
  const provider = gbProvider()
  if (!provider) return
  playEngage()
  const result = await window.meter.setGear(provider.id, gear)
  if (!result || !result.ok) {
    setGearStatus(gearFailure(result), 'slipping')
    return
  }
  gbState = result.gearbox
  // Reverse can drop back into a gear on a different make, so the gate follows
  // the shifter rather than leaving it marked on a plate it is not in.
  if (gbState.providerId !== gbProviderId) {
    gbProviderId = gbState.providerId
    paintMake()
    buildGate()
  }
  markEngaged()
  const home = gbPositions.find(p => p.gear === gbState.gear)
  if (home) { placeLever(home.x, home.y); lever.lane = gbSlots.indexOf(home.x) }
  setGearStatus(result.applied
    ? 'Engaged — ' + result.label + ' written to settings.json'
    : 'Selected ' + result.label + ' — recorded only, see below', 'engaged')
}

function gearFailure (result) {
  const reason = result ? result.reason : 'unknown'
  if (reason === 'nothing_to_reverse_to') return 'Nothing to reverse into yet.'
  if (reason === 'no_settings_file') return 'No settings.json to write to.'
  if (reason === 'malformed_settings') return 'settings.json is not valid JSON — refusing to rewrite it.'
  if (reason === 'unreadable' || reason === 'write_failed') return 'Could not write settings.json.'
  return 'Refused: ' + reason
}

/** Show the make the box is currently set up for, and nothing else. */
function paintMake () {
  const provider = gbProvider()
  if (!provider) return
  gbNodes.makeMark.textContent = provider.emoji || '\u2022'
  gbNodes.makeName.textContent = provider.name
  // Straight into a custom property, so it is confirmed to be a plain hex
  // colour first — a value carrying its own semicolon would otherwise be able
  // to append declarations of its choosing.
  gbNodes.makes.style.setProperty('--make', HEX_COLOR.test(provider.accent || '')
    ? provider.accent
    : 'var(--muted)')
  gbNodes.makes.title = provider.product + ' \u2014 ' + (provider.configurable
    ? 'this dashboard can set its model'
    : 'listed only; this dashboard cannot set its model')
}

/** Step to the next make, wrapping at both ends. */
function stepMake (by) {
  if (gbCatalog.length < 2) return
  const index = gbCatalog.findIndex(p => p.id === gbProviderId)
  const next = (index + by + gbCatalog.length) % gbCatalog.length
  selectMake(gbCatalog[next].id)
}

function selectMake (id) {
  if (gbProviderId === id) return
  gbProviderId = id
  paintMake()
  buildGate()
  const provider = gbProvider()
  gbNodes.note.textContent = provider ? provider.note || '' : ''
  setGearStatus(provider && provider.configurable
    ? 'Click the clutch pedal to shift (or hold Space).'
    : 'Listed only — engaging records the choice without changing ' +
      (provider ? provider.product : 'it') + '.', null)
}

function renderGearbox (data) {
  if (!data.catalog) return
  const first = gbCatalog.length === 0
  gbCatalog = data.catalog
  gbState = data.gearbox || gbState
  if (first || !gbProviderId) gbProviderId = gbState.providerId || gbCatalog[0].id

  if (first) buildGate()
  paintMake()
  markEngaged()
}

function openGearbox () {
  if (latest) renderGearbox(latest)
  gbNodes.panel.removeAttribute('hidden')
  // First time through, say how a clutch works. After that, never again.
  const seen = latest && latest.settings && latest.settings.gearboxHintSeen
  gbNodes.hint.toggleAttribute('hidden', Boolean(seen))
  const provider = gbProvider()
  gbNodes.note.textContent = provider ? provider.note || '' : ''
  setGearStatus('Click the clutch pedal to shift (or hold Space).', gbState.gear !== null ? 'engaged' : null)
}

function closeGearbox () {
  if (clutchDown) releaseClutch()
  gbNodes.panel.setAttribute('hidden', '')
}

gbNodes.gate.addEventListener('pointerdown', event => {
  if (!gbPositions.length) return
  if (!clutchDown) { refuse(); return }
  const point = gatePoint(event)
  if (!point) return
  dragging = true
  // Capture keeps the lever following the pointer past the edge of the gate.
  // It throws if the pointer is already gone, which must not abandon the drag
  // half-set-up — the move handler works without capture, just less smoothly.
  try { gbNodes.gate.setPointerCapture(event.pointerId) } catch { /* no capture */ }
  moveLever(point)
})

gbNodes.gate.addEventListener('pointermove', event => {
  if (!dragging) return
  const point = gatePoint(event)
  if (point) moveLever(point)
})

const endGateDrag = event => {
  if (!dragging) return
  dragging = false
  try { gbNodes.gate.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  // let go mid-slot and the lever settles into the nearest detent, as a sprung
  // gate would; let go on the rail and it stays in neutral
  const found = gearUnderLever()
  if (found) { placeLever(found.x, found.y); describeGear(found) }
}
gbNodes.gate.addEventListener('pointerup', endGateDrag)
gbNodes.gate.addEventListener('pointercancel', endGateDrag)

// Click puts it down and leaves it down; click again to let it up. Holding the
// button instead would leave you with no pointer to shift with.
gbNodes.pedal.addEventListener('pointerdown', event => {
  event.preventDefault()
  if (clutchDown) releaseClutch()
  else pressClutch('latch')
})

// Space is the keyboard clutch and stays momentary — with a keyboard you really
// can hold the clutch and shift at the same time.
document.addEventListener('keydown', event => {
  if (gbNodes.panel.hasAttribute('hidden')) return
  if (event.code === 'Space' && !event.repeat) { event.preventDefault(); pressClutch('hold') }
})
document.addEventListener('keyup', event => {
  if (event.code === 'Space' && clutchDown && clutchMode === 'hold') {
    event.preventDefault()
    releaseClutch()
  }
})
// A held key whose keyup lands in another window would leave the clutch stuck
// down; a latched pedal is meant to stay down, so it survives.
window.addEventListener('blur', () => {
  if (clutchDown && clutchMode === 'hold') releaseClutch()
})

el('btn-gearbox').addEventListener('click', openGearbox)
gbNodes.close.addEventListener('click', closeGearbox)
gbNodes.prev.addEventListener('click', () => stepMake(-1))
gbNodes.next.addEventListener('click', () => stepMake(1))

// ---- the one-time explanation ----

const showHint = () => gbNodes.hint.removeAttribute('hidden')

gbNodes.help.addEventListener('click', showHint)
gbNodes.hintOk.addEventListener('click', () => {
  gbNodes.hint.setAttribute('hidden', '')
  // Recorded in settings, so it is explained once per person rather than once
  // per launch.
  saveSetting('gearboxHintSeen', true)
})

// ---------- settings ----------

/**
 * The panel is a view onto two different things: preferences, which live in
 * main and come back on every push, and read-only facts about the current
 * reading. Both are repainted from the payload, so the panel can never drift
 * out of step with what the app is actually doing.
 */
const setNodes = {
  panel: el('settings'),
  close: el('set-close'),
  account: el('set-account'),
  org: el('set-org'),
  plan: el('set-plan'),
  modelLive: el('set-model-live'),
  provider: el('set-provider'),
  model: el('set-model'),
  switch: el('set-switch'),
  openAccount: el('set-open-account'),
  theme: el('set-theme'),
  opacity: el('set-opacity'),
  opacityVal: el('set-opacity-val'),
  sessions: el('set-sessions'),
  sound: el('set-sound'),
  volume: el('set-volume'),
  volumeVal: el('set-volume-val'),
  ontop: el('set-ontop'),
  login: el('set-login'),
  loginNote: el('set-login-note'),
  source: el('set-source'),
  poll: el('set-poll'),
  records: el('set-records'),
  version: el('set-version'),
  reset: el('set-reset')
}

const setToggle = (node, on) => node.classList.toggle('on', Boolean(on))

// Live-dragging a slider must not be interrupted by the 20-second push
// repainting it from a value the user has already moved past.
const holdsFocus = node => document.activeElement === node

function renderSettings (data) {
  const s = data.settings
  if (!s) return

  // The plan comes off the session, not the account: account.js reads only the
  // display identity out of Claude's config, while the rate-limit tier the plan
  // name is derived from is read by session.js. This row asked `account` for it
  // and so could only ever say "unknown".
  const account = data.account || {}
  const session = data.session || {}
  setNodes.account.textContent = account.email || 'not detected'
  setNodes.account.title = account.email || ''
  setNodes.org.textContent = account.org || 'personal'
  setNodes.plan.textContent = session.plan || 'not detected'
  setNodes.provider.textContent = vendorLabel(data)
  setNodes.model.textContent = data.configuredModel || '—'
  // what settings.json asks for can differ from what the live session runs
  setNodes.modelLive.textContent = session.model || '—'
  setNodes.modelLive.title = session.modelId || ''

  for (const btn of setNodes.theme.children) {
    btn.classList.toggle('on', btn.dataset.theme === s.theme)
  }

  if (!holdsFocus(setNodes.opacity)) setNodes.opacity.value = Math.round(s.opacity * 100)
  setNodes.opacityVal.textContent = Math.round(s.opacity * 100) + '%'
  if (!holdsFocus(setNodes.volume)) setNodes.volume.value = Math.round(s.volume * 100)
  setNodes.volumeVal.textContent = Math.round(s.volume * 100) + '%'

  setToggle(setNodes.sessions, s.showSessions)
  setToggle(setNodes.sound, s.sound)
  setToggle(setNodes.ontop, s.alwaysOnTop)
  setToggle(setNodes.login, s.openAtLogin)

  // Registering a login item only means anything for an installed copy; say so
  // rather than offering a switch that silently does nothing.
  setNodes.login.disabled = !data.canOpenAtLogin
  setNodes.loginNote.hidden = Boolean(data.canOpenAtLogin)

  document.body.classList.toggle('no-sessions', !s.showSessions)
  setSoundLevel(s.sound, s.volume)

  setNodes.source.textContent = data.official && data.official.backingOff
    ? 'local estimate (API throttled)'
    : data.fiveHour.source
  const nextPoll = data.official ? data.official.nextPollAt : 0
  setNodes.poll.textContent = nextPoll > Date.now()
    ? 'in ' + Math.ceil((nextPoll - Date.now()) / 60000) + ' min'
    : 'due now'
  setNodes.records.textContent = String(data.localEvents)
  setNodes.version.textContent = data.appVersion ? 'v' + data.appVersion : '—'
}

function vendorLabel (data) {
  const match = (data.vendors || []).find(v => v.id === data.vendor)
  return (match && match.name) || data.vendor || '—'
}

function openSettings () {
  if (latest) renderSettings(latest)
  setNodes.panel.removeAttribute('hidden')
}

const closeSettings = () => setNodes.panel.setAttribute('hidden', '')

const saveSetting = (key, value) => {
  window.meter.setSetting(key, value).then(result => {
    if (result && result.ok && latest) {
      latest.settings = result.settings
      renderSettings(latest)
    }
  }).catch(() => {})
}

el('btn-settings').addEventListener('click', openSettings)
setNodes.close.addEventListener('click', closeSettings)

setNodes.theme.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn')
  if (btn) saveSetting('theme', btn.dataset.theme)
})

// `input` rather than `change`, so the window fades as the slider moves
setNodes.opacity.addEventListener('input', e => {
  setNodes.opacityVal.textContent = e.target.value + '%'
  saveSetting('opacity', Number(e.target.value) / 100)
})
setNodes.volume.addEventListener('input', e => {
  setNodes.volumeVal.textContent = e.target.value + '%'
  saveSetting('volume', Number(e.target.value) / 100)
})
// releasing the volume slider plays the blip, so the level can be judged by ear
setNodes.volume.addEventListener('change', () => { if (soundEnabled) revEngine() })

const toggleSetting = (node, key) => node.addEventListener('click', () => {
  saveSetting(key, !node.classList.contains('on'))
})
toggleSetting(setNodes.sessions, 'showSessions')
toggleSetting(setNodes.sound, 'sound')
toggleSetting(setNodes.ontop, 'alwaysOnTop')
toggleSetting(setNodes.login, 'openAtLogin')

setNodes.switch.addEventListener('click', () => {
  closeSettings()
  window.meter.lock()
})
setNodes.openAccount.addEventListener('click', () => {
  if (latest && latest.vendor) window.meter.openVendor(latest.vendor)
})
setNodes.reset.addEventListener('click', () => {
  window.meter.resetSettings().then(result => {
    if (result && result.ok && latest) {
      latest.settings = result.settings
      renderSettings(latest)
    }
  }).catch(() => {})
})

// Escape backs out of the panel, the way it backs out of the model menu.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (!gbNodes.panel.hasAttribute('hidden')) closeGearbox()
  else if (!setNodes.panel.hasAttribute('hidden')) closeSettings()
})

// ---------- wiring ----------

nodes.mascot.addEventListener('click', () => {
  // Re-adding the class is not enough to replay a running animation; the
  // reflow read in between is what actually restarts it.
  nodes.mascot.classList.remove('boing')
  void nodes.mascot.offsetWidth
  nodes.mascot.classList.add('boing')
  wakeMascot()
})
nodes.mascot.addEventListener('animationend', e => {
  if (e.animationName === 'boing') nodes.mascot.classList.remove('boing')
})

el('btn-rev').addEventListener('click', revEngine)
let crankTimer = null
el('btn-refresh').addEventListener('click', e => {
  const btn = e.currentTarget
  // The icon keeps turning for as long as the starter does, so the spin reads as
  // the thing making the noise rather than running alongside it. Clicking again
  // restarts both, rather than being swallowed by the class already being set.
  clearTimeout(crankTimer)
  btn.classList.remove('cranking')
  void btn.offsetWidth
  btn.classList.add('cranking')
  crankTimer = setTimeout(() => btn.classList.remove('cranking'), IGNITION_MS)
  playIgnition()
  window.meter.refresh()
})
el('vendor-prev').addEventListener('click', () => stepVendor(-1))
el('vendor-next').addEventListener('click', () => stepVendor(1))
el('btn-lock').addEventListener('click', () => window.meter.lock())
el('btn-close').addEventListener('click', () => window.meter.close())
el('lock-close').addEventListener('click', () => window.meter.close())
nodes.btnCloseMini.addEventListener('click', () => window.meter.close())

// Collapsing is reversible from a visible control, not only from the
// double-click shortcut — a hidden gesture is not a way out of a UI state.
function setCollapsed (collapsed) {
  // the pill has no room for the panel, so collapsing closes it rather than
  // parking it out of sight to reappear on the next expand
  if (collapsed) { closeSettings(); closeGearbox() }
  document.body.classList.toggle('mini', collapsed)
  window.meter.setMini(collapsed)
}
el('btn-collapse').addEventListener('click', () => setCollapsed(true))
el('btn-min').addEventListener('click', () => window.meter.minimize())
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

window.meter.onUpdate(render)
window.meter.ready()
