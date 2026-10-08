// Tempo — a Clock-app look-alike with a forcing timer wheel.
import { SUIT_NAMES, STACKS, STACK_IDS, entrySteps, computeTargets } from './stacks.js';
import { ForceSequencer, planLanding, splitDigits } from './force.js';

const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Wheel tuning. Everything is derived from elapsed time (performance.now), so a
// 30 fps cap in Low Power Mode changes smoothness, never speed.
// ---------------------------------------------------------------------------
const ROW_DEG = 20.8; // angle between neighbouring rows on the drum
const ROW_RAD = (ROW_DEG * Math.PI) / 180;
const DRUM_R = 90; // drum radius in pt
const ROW_PITCH = DRUM_R * ROW_RAD; // finger travel per row (~32.8 pt)
const SLOTS = 11; // rows rendered per wheel (center ± 5)
const TAU = 420; // momentum time constant (ms): bigger = longer glide
const SETTLE_TAU = 95; // time constant when a slow release settles onto a row
const MOMENTUM_MIN = 0.004; // rows/ms (~130 pt/s): slower releases just settle
const SPIN_MIN = 0.02; // rows/ms (~650 pt/s): a release this fast is a spin (counted, forceable)
const V_MAX = 0.24; // rows/ms cap on launch speed
const VELOCITY_WINDOW = 60; // ms of touch history used for the release velocity
const BLEND = 180; // ms over which a flick eases from its natural path onto the planned one
const REST_EPS = 0.01; // rows (~0.3 pt) from the end: at rest
const CATCH_EPS = 0.2; // rows: touching a wheel this close to stopping counts as rest

// Dim (outside the band) row opacity by |sin(angle)|, measured from iOS 26.
const FADE = [[0, 1], [0.358, 0.957], [0.669, 0.89], [0.891, 0.52], [1, 0.2]];

const mod = (n, m) => ((n % m) + m) % m;
const evTime = (e) => (e.timeStamp > 0 ? e.timeStamp : performance.now());
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const svgUse = (id, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
};

// ---------------------------------------------------------------------------
// Storage (settings, recents and — only if asked — the remembered force)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  },
};

const DEFAULTS = {
  stack: 'mnemonica',
  forceSpin: 3,
  useDouble: false,
  secondSpin: 3,
  useOffset: false,
  offsetType: 'bottom',
  wheel: 's',
  remember: false,
  practice: false,
};
let settings = { ...DEFAULTS, ...store.get('tempo.settings', {}) };
if (!STACKS[settings.stack]) settings.stack = DEFAULTS.stack;
const saveSettings = () => store.set('tempo.settings', settings);

// ---------------------------------------------------------------------------
// Performer state. In memory only: a force quit wipes it.
// ---------------------------------------------------------------------------
let mode = 'normal'; // 'normal' | 'entry'
let entry = null; // { steps, idx, values, suit, buffer } while entering
let entries = null; // committed entries (cards or numbers)
let entrySettings = null; // settings the entries were made under
let sequencer = null;

function sameSteps(a, b) {
  const sa = entrySteps(a).map((s) => s.kind + s.force).join();
  const sb = entrySteps(b).map((s) => s.kind + s.force).join();
  return sa === sb;
}

function buildSequencer(targets) {
  sequencer = new ForceSequencer({
    targets,
    firstSpin: settings.forceSpin,
    secondSpin: settings.secondSpin,
    wheel: settings.wheel,
  });
}

function rememberForce() {
  if (settings.remember && entries) store.set('tempo.force', { settings: entrySettings, entries });
  else store.del('tempo.force');
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------
const NORMAL_TABS = [
  { id: 'worldclock', label: 'World Clock', icon: 'i-globe' },
  { id: 'alarms', label: 'Alarms', icon: 'i-alarm' },
  { id: 'stopwatch', label: 'Stopwatch', icon: 'i-stopwatch' },
  { id: 'timers', label: 'Timers', icon: 'i-timer' },
];
const SUIT_ICONS = { C: 'i-club', S: 'i-spade', H: 'i-heart', D: 'i-diamond' };
const SUIT_TABS = ['C', 'S', 'H', 'D'].map((s) => ({ id: 'suit-' + s, suit: s, label: SUIT_NAMES[s], icon: SUIT_ICONS[s] }));
const NUMBER_TAB = { id: 'number', label: 'Number', icon: 'i-number' };
const TIMERS_TAB = NORMAL_TABS[3];

const tabbar = $('#tabbar');
const tbItems = $('#tb-items');
const tbCap = $('#tb-cap');
let tabs = [];
let activeTab = 'timers';
let currentPage = null;

function currentTabs() {
  if (mode !== 'entry') return NORMAL_TABS;
  return settings.stack === 'number' ? [NUMBER_TAB, TIMERS_TAB] : [...SUIT_TABS, TIMERS_TAB];
}

function renderTabs() {
  tabs = currentTabs();
  tbItems.textContent = '';
  for (const t of tabs) {
    const b = el('button', 'tb-item');
    b.type = 'button';
    b.dataset.tab = t.id;
    b.appendChild(svgUse(t.icon));
    b.appendChild(el('span', null, t.label));
    tbItems.appendChild(b);
  }
  layoutTabs(true);
}

function layoutTabs(instant = false) {
  const W = tabbar.clientWidth;
  const n = tabs.length;
  const inner = W - 8;
  const capW = Math.min(inner, (inner / n) * 1.166);
  const step = n > 1 ? (inner - capW) / (n - 1) : 0;
  const width = Math.max(step, inner / n);
  [...tbItems.children].forEach((b, i) => {
    const cx = 4 + capW / 2 + i * step;
    b.style.left = cx - width / 2 + 'px';
    b.style.width = width + 'px';
    b._cx = cx;
  });
  tbCap.style.width = capW + 'px';
  tbCap._w = capW;
  placeCap(instant);
}

function placeCap(instant) {
  const b = tbItems.querySelector(`[data-tab="${activeTab}"]`);
  [...tbItems.children].forEach((x) => x.classList.toggle('active', x === b));
  if (!b) return;
  if (instant) {
    tbCap.classList.add('instant');
    tbCap.getBoundingClientRect();
  }
  tbCap.style.left = b._cx - tbCap._w / 2 + 'px';
  if (instant) requestAnimationFrame(() => tbCap.classList.remove('instant'));
}

function selectTab(id, instant = false) {
  activeTab = id;
  placeCap(instant);
  if (id.startsWith('suit-')) {
    entry.suit = id.slice(5);
    showPage('entry');
    updateEntryTitle();
  } else if (id === 'number') {
    showPage('entry');
    updateEntryTitle();
  } else {
    showPage(id);
  }
}

function showPage(id) {
  if (currentPage === id) return;
  currentPage = id;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + id));
  if (id === 'entry') renderKeypad();
  if (id === 'worldclock') renderWorldClock();
  if (id === 'stopwatch') renderStopwatch();
  if (id === 'timers') picker.layout();
}

// Long-press Timers (about a second) opens the settings sheet.
let lpTimer = null;
let lpFired = false;
let lpStart = null;
tbItems.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.tb-item');
  lpFired = false; // iOS may or may not send a click after a long press
  if (!b || b.dataset.tab !== 'timers') return;
  lpStart = { x: e.clientX, y: e.clientY };
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    lpFired = true;
    openSettings(true);
  }, 1000);
});
const lpCancel = () => clearTimeout(lpTimer);
tbItems.addEventListener('pointerup', lpCancel);
tbItems.addEventListener('pointercancel', lpCancel);
tbItems.addEventListener('pointermove', (e) => {
  if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 12) lpCancel();
});
tbItems.addEventListener('click', (e) => {
  const b = e.target.closest('.tb-item');
  if (!b) return;
  if (lpFired) {
    lpFired = false;
    return;
  }
  selectTab(b.dataset.tab);
});

// ---------------------------------------------------------------------------
// Picker wheels
// ---------------------------------------------------------------------------
function fade(u) {
  for (let i = 1; i < FADE.length; i++) {
    const [u1, o1] = FADE[i];
    if (u <= u1) {
      const [u0, o0] = FADE[i - 1];
      return o0 + ((u - u0) / (u1 - u0)) * (o1 - o0);
    }
  }
  return FADE[FADE.length - 1][1];
}

class Wheel {
  constructor(key, { min, max, cyclic, anchor, unit, unitOne }) {
    Object.assign(this, { key, min, max, cyclic, anchor, unit, unitOne });
    this.count = max - min + 1;
    this.pos = 0;
    this.anim = null;
    this.drag = null;
    this.flick = false;
    this.forced = false;
    this.dim = [];
    this.sel = [];
    const dimLayer = $('#picker-dim');
    const selLayer = $('#picker-sel');
    for (let i = 0; i < SLOTS; i++) {
      const a = el('div', 'p-row');
      const b = el('div', 'p-row');
      dimLayer.appendChild(a);
      selLayer.appendChild(b);
      this.dim.push(a);
      this.sel.push(b);
    }
    this.unitEl = el('div', 'p-unit', unit);
    selLayer.appendChild(this.unitEl);
  }

  get value() {
    const k = Math.round(this.pos);
    return this.cyclic ? this.min + mod(k - this.min, this.count) : clamp(k, this.min, this.max);
  }

  set value(v) {
    this.anim = null;
    this.pos = v;
    this.render();
  }

  layout(cx) {
    const left = cx + this.anchor - 2.3 - 80;
    for (const r of [...this.dim, ...this.sel]) r.style.left = left + 'px';
    this.unitEl.style.left = cx + this.anchor + 2.3 + 'px';
    this.render(true);
  }

  labelFor(k) {
    if (this.cyclic) return this.min + mod(k - this.min, this.count);
    return k >= this.min && k <= this.max ? k : null;
  }

  render(force = false) {
    if (!force && this._drawn === this.pos) return;
    this._drawn = this.pos;
    const base = Math.floor(this.pos) - (SLOTS >> 1);
    for (let j = 0; j < SLOTS; j++) {
      const k = base + j;
      const theta = (k - this.pos) * ROW_RAD;
      const label = this.labelFor(k);
      const show = label != null && Math.abs(theta) < Math.PI / 2 - 0.01;
      const a = this.dim[j];
      const b = this.sel[j];
      if (!show) {
        if (a._shown) { a.style.visibility = b.style.visibility = 'hidden'; a._shown = false; }
        continue;
      }
      if (!a._shown) { a.style.visibility = b.style.visibility = 'visible'; a._shown = true; }
      if (a._label !== label) { a.textContent = b.textContent = label; a._label = label; }
      const t = `translate3d(0,0,${-DRUM_R}px) rotateX(${(-theta).toFixed(5)}rad) translate3d(0,0,${DRUM_R}px)`;
      a.style.transform = b.style.transform = t;
      a.style.opacity = fade(Math.abs(Math.sin(theta))).toFixed(3);
    }
    const unit = this.unitOne && this.value === 1 ? this.unitOne : this.unit;
    if (this.unitEl._t !== unit) { this.unitEl.textContent = unit; this.unitEl._t = unit; }
  }

  // ----- touch -----
  down(e, now) {
    let caught = this.anim != null;
    if (this.anim && this.remaining(now) < CATCH_EPS) {
      // Visually stopped: finish it, so the spin still counts.
      this.anim.t0 -= 1e7;
      this.step(now);
      caught = false;
    }
    if (this.anim) this.step(now, true); // freeze where it is; an interrupted flick never "rests"
    this.anim = null;
    this.flick = false;
    this.forced = false;
    this.drag = {
      id: e.pointerId,
      y0: e.clientY,
      pos0: this.pos,
      raw: this.pos,
      t0: now,
      moved: caught,
      samples: [{ t: evTime(e), p: this.pos }],
    };
  }

  move(e, now) {
    const d = this.drag;
    const dy = e.clientY - d.y0;
    if (Math.abs(dy) > 4) d.moved = true;
    d.raw = d.pos0 - dy / ROW_PITCH;
    this.pos = this.rubber(d.raw);
    const t = evTime(e);
    d.samples.push({ t, p: d.raw });
    while (d.samples.length > 2 && t - d.samples[0].t > 160) d.samples.shift();
    this.render();
  }

  up(e, now, picker) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved && now - d.t0 < 400) {
      // Tap on a row above/below the band scrolls to it.
      const dy = e.clientY - picker.centerY();
      if (Math.abs(dy) > 17) {
        const rows = Math.round(Math.asin(clamp(dy / DRUM_R, -1, 1)) / ROW_RAD);
        this.tweenTo(this.clampRow(Math.round(this.pos) + rows), 260);
      } else {
        this.settle(0, now);
      }
      return;
    }
    const v = this.releaseVelocity(d, evTime(e));
    if (!this.cyclic && (this.pos < this.min || this.pos > this.max)) {
      this.tweenTo(this.pos < this.min ? this.min : this.max, 380);
      return;
    }
    if (Math.abs(v) >= MOMENTUM_MIN) this.fling(v, now, Math.abs(v) >= SPIN_MIN);
    else this.settle(v, now);
  }

  // Rows still to travel in the current animation (Infinity if unknown).
  remaining(now) {
    const a = this.anim;
    if (!a) return 0;
    const t = now - a.t0;
    if (a.type === 'decay' && t > BLEND) return Math.abs(a.d * Math.exp(-t / a.tau));
    return Infinity;
  }

  // Release velocity: least-squares slope of the last VELOCITY_WINDOW ms of touch
  // samples, timed by the events' own timestamps (immune to main-thread lag).
  releaseVelocity(d, upTime) {
    const s = d.samples;
    const last = s[s.length - 1];
    if (upTime - last.t > 70) return 0; // finger stopped before lifting
    let pts = s.filter((q) => last.t - q.t <= VELOCITY_WINDOW);
    if (pts.length < 2 || last.t - pts[0].t < 12) pts = s.slice(-3);
    if (pts.length < 2) return 0;
    const n = pts.length;
    const mt = pts.reduce((a, q) => a + q.t, 0) / n;
    const mp = pts.reduce((a, q) => a + q.p, 0) / n;
    let num = 0;
    let den = 0;
    for (const q of pts) {
      num += (q.t - mt) * (q.p - mp);
      den += (q.t - mt) ** 2;
    }
    if (den < 1) return 0;
    return clamp(num / den, -V_MAX, V_MAX);
  }

  rubber(raw) {
    if (this.cyclic) return raw;
    const dim = 2.4;
    const band = (x) => (1 - 1 / ((x * 0.55) / dim + 1)) * dim;
    if (raw < this.min) return this.min - band(this.min - raw);
    if (raw > this.max) return this.max + band(raw - this.max);
    return raw;
  }

  clampRow(k) {
    return this.cyclic ? k : clamp(k, this.min, this.max);
  }

  // Momentum after release. A spin (fast enough to count) may be forced: the
  // planner picks a landing near where this flick would naturally stop, and the
  // motion eases from the natural path onto the planned one over BLEND ms, so
  // the launch speed always matches the finger.
  fling(v, now, isSpin) {
    const target = isSpin && sequencer ? sequencer.forcedValueFor(this.key) : null;
    const opts = { pos: this.pos, v, tau: TAU, cyclic: this.cyclic, min: this.min, max: this.max };
    let plan = target != null ? planLanding({ ...opts, target }) : null;
    if (!plan) plan = planLanding(opts);
    this.flick = isSpin;
    this.forced = plan.forced;
    if (!this.cyclic && (plan.to < this.min || plan.to > this.max)) {
      this.bounceAnim(v, now);
    } else {
      this.anim = { type: 'decay', t0: now, from: this.pos, d: plan.to - this.pos, tau: plan.tau, v0: v };
    }
    picker.kick();
  }

  settle(v, now) {
    const to = this.clampRow(Math.round(this.pos + v * SETTLE_TAU));
    this.anim = { type: 'decay', t0: now, from: this.pos, d: to - this.pos, tau: SETTLE_TAU };
    picker.kick();
  }

  tweenTo(to, dur) {
    this.flick = false;
    this.anim = { type: 'tween', t0: performance.now(), from: this.pos, to, dur };
    picker.kick();
  }

  // Free spin into the end of a bounded wheel: decay until the end, then a short
  // damped overshoot back onto it (iOS's bounce).
  bounceAnim(v, now) {
    const edge = v > 0 ? this.max : this.min;
    const d = v * TAU;
    const frac = (edge - this.pos) / d; // fraction of the natural travel before the end
    const tb = -TAU * Math.log(1 - clamp(frac, 0, 0.999));
    const vb = clamp((d / TAU) * Math.exp(-tb / TAU), -0.035, 0.035);
    this.anim = { type: 'bounce', t0: now, from: this.pos, d, tb, edge, vb, ts: 48 };
  }

  // Advance to time `now`; returns true while still moving.
  step(now, freeze = false) {
    const a = this.anim;
    if (!a) return false;
    const t = now - a.t0;
    let done = false;
    if (a.type === 'decay') {
      const rem = a.d * Math.exp(-t / a.tau);
      this.pos = a.from + a.d - rem;
      if (a.v0 != null && t < BLEND) {
        // ease from the natural (unplanned) path onto the planned one
        const natural = a.v0 * TAU * (1 - Math.exp(-t / TAU));
        const u = t / BLEND;
        const w = 1 - u * u * (3 - 2 * u);
        this.pos += w * (a.from + natural - this.pos);
      }
      if (t >= BLEND && Math.abs(rem) < REST_EPS) { this.pos = a.from + a.d; done = true; }
    } else if (a.type === 'tween') {
      const p = Math.min(1, t / a.dur);
      const e = 1 - Math.pow(1 - p, 3);
      this.pos = a.from + (a.to - a.from) * e;
      if (p >= 1) done = true;
    } else if (a.type === 'bounce') {
      if (t < a.tb) {
        this.pos = a.from + a.d * (1 - Math.exp(-t / TAU));
      } else {
        const u = t - a.tb;
        this.pos = a.edge + a.vb * u * Math.exp(-u / a.ts);
        if (u > a.ts * 9) { this.pos = a.edge; done = true; }
      }
    }
    if (freeze) return false;
    this.render();
    if (done) {
      this.anim = null;
      if (this.cyclic) this.pos = this.min + mod(Math.round(this.pos) - this.min, this.count);
      else this.pos = Math.round(this.pos);
      this.render(true);
      if (this.flick) {
        this.flick = false;
        picker.onFlickRest(this);
      }
      picker.onSettled();
    }
    return !done;
  }
}

const picker = {
  el: $('#picker'),
  wheels: {},
  running: false,
  touches: new Map(),

  init() {
    this.wheels.h = new Wheel('h', { min: 0, max: 23, cyclic: false, anchor: -110.9, unit: 'hours', unitOne: 'hour' });
    this.wheels.m = new Wheel('m', { min: 0, max: 59, cyclic: true, anchor: -0.9, unit: 'min' });
    this.wheels.s = new Wheel('s', { min: 0, max: 59, cyclic: true, anchor: 108.9, unit: 'sec' });
    const saved = store.get('tempo.picker', { h: 0, m: 5, s: 0 });
    for (const k of ['h', 'm', 's']) this.wheels[k].pos = clamp(saved[k] | 0, this.wheels[k].min, this.wheels[k].max);

    this.el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.el.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.el.addEventListener('pointercancel', (e) => this.pointerUp(e));
    this.el.addEventListener('lostpointercapture', (e) => this.pointerUp(e));
    this.layout();
  },

  layout() {
    const cx = this.el.clientWidth / 2;
    if (!cx) return;
    for (const w of Object.values(this.wheels)) w.layout(cx);
    this.publish();
  },

  centerY() {
    const r = this.el.getBoundingClientRect();
    return r.top + r.height / 2;
  },

  wheelAt(x) {
    const r = this.el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    if (dx < -55) return this.wheels.h;
    if (dx > 54) return this.wheels.s;
    return this.wheels.m;
  },

  pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const w = this.wheelAt(e.clientX);
    if (w.drag) return; // one finger per wheel
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.touches.set(e.pointerId, w);
    w.down(e, performance.now());
    w.render();
    e.preventDefault();
  },

  pointerMove(e) {
    const w = this.touches.get(e.pointerId);
    if (!w || !w.drag) return;
    w.move(e, performance.now());
    e.preventDefault();
  },

  pointerUp(e) {
    const w = this.touches.get(e.pointerId);
    if (!w) return;
    this.touches.delete(e.pointerId);
    if (e.type === 'pointerup') {
      w.up(e, performance.now(), this);
    } else if (w.drag) {
      // The system took the touch (e.g. a home-indicator swipe): just settle.
      w.drag = null;
      if (!w.cyclic && (w.pos < w.min || w.pos > w.max)) w.tweenTo(w.pos < w.min ? w.min : w.max, 380);
      else w.settle(0, performance.now());
    }
  },

  kick() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame((t) => this.frame(t));
  },

  frame() {
    const now = performance.now();
    let moving = false;
    for (const w of Object.values(this.wheels)) if (w.step(now)) moving = true;
    if (moving) requestAnimationFrame((t) => this.frame(t));
    else this.running = false;
  },

  values() {
    return { h: this.wheels.h.value, m: this.wheels.m.value, s: this.wheels.s.value };
  },

  // Bring any wheel still gliding to its landing row now (rests still count).
  finishAll() {
    const now = performance.now();
    for (const w of Object.values(this.wheels)) {
      if (!w.anim) continue;
      w.anim.t0 -= 1e7;
      if (w.anim.type === 'bounce') w.anim.tb = Math.min(w.anim.tb, 0);
      w.step(now);
    }
  },

  set(values) {
    for (const k of ['h', 'm', 's']) if (values[k] != null) this.wheels[k].value = values[k];
    this.publish();
  },

  totalSeconds() {
    const v = this.values();
    return v.h * 3600 + v.m * 60 + v.s;
  },

  onFlickRest(w) {
    if (sequencer) sequencer.onFlickRest(w.key, this.values(), w.forced);
    w.forced = false;
  },

  onSettled() {
    this.publish();
  },

  publish() {
    const v = this.values();
    this.el.dataset.value = `${v.h}:${v.m}:${v.s}`;
    timerUI.syncStart();
  },
};

// ---------------------------------------------------------------------------
// Timer (setup, running, finished)
// ---------------------------------------------------------------------------
const fmtClock = (secs) => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtWords = (secs) => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts = [];
  if (h) parts.push(plural(h, 'hr', 'hrs'));
  if (m) parts.push(plural(m, 'min', 'mins'));
  if (s) parts.push(plural(s, 'sec', 'secs'));
  return parts.join(', ') + '.';
};

let hour12 = true;
try {
  hour12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1') ?? true;
} catch { /* default */ }
const fmtTimeOfDay = (date, timeZone) => {
  const opts = { hour: 'numeric', minute: '2-digit', hour12, timeZone };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  const hh = parts.find((p) => p.type === 'hour').value;
  const mm = parts.find((p) => p.type === 'minute').value;
  const ap = parts.find((p) => p.type === 'dayPeriod');
  return { digits: `${hour12 ? Number(hh) : hh}:${mm}`, ampm: ap ? ap.value.toUpperCase() : '' };
};

const timerUI = {
  state: 'idle', // idle | running | paused
  total: 0,
  endAt: 0,
  remaining: 0,
  raf: 0,
  cancelBtn: $('#t-cancel'),
  startBtn: $('#t-start'),
  run: $('#timer-run'),
  ringFill: $('#ring-fill'),
  runTime: $('#run-time'),
  runEnd: $('#run-end'),
  circumference: 2 * Math.PI * 136,

  init() {
    this.ringFill.style.strokeDasharray = String(this.circumference);
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.startBtn.addEventListener('click', () => {
      if (this.state === 'idle') {
        picker.finishAll();
        this.start(picker.totalSeconds());
      }
      else if (this.state === 'running') this.pause();
      else this.resume();
    });
    this.renderButtons();
  },

  syncStart() {
    if (this.state === 'idle') this.startBtn.disabled = picker.totalSeconds() === 0;
  },

  renderButtons() {
    const s = this.startBtn;
    const label = { idle: 'Start', running: 'Pause', paused: 'Resume' }[this.state];
    s.firstElementChild.textContent = label;
    s.classList.toggle('btn-green', this.state !== 'running');
    s.classList.toggle('btn-orange', this.state === 'running');
    this.cancelBtn.classList.toggle('is-disabled', this.state === 'idle');
    this.syncStart();
    if (this.state !== 'idle') s.disabled = false;
  },

  start(secs) {
    if (!secs) return;
    unlockAudio();
    store.set('tempo.picker', picker.values());
    this.total = secs * 1000;
    this.endAt = Date.now() + this.total;
    this.state = 'running';
    recents.add(secs);
    $('#picker').hidden = true;
    this.run.hidden = false;
    this.runEnd.textContent = (() => {
      const t = fmtTimeOfDay(new Date(this.endAt));
      return t.ampm ? `${t.digits} ${t.ampm}` : t.digits;
    })();
    this.renderButtons();
    this.tick();
  },

  pause() {
    this.remaining = Math.max(0, this.endAt - Date.now());
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    this.renderButtons();
  },

  resume() {
    this.endAt = Date.now() + this.remaining;
    this.state = 'running';
    const t = fmtTimeOfDay(new Date(this.endAt));
    this.runEnd.textContent = t.ampm ? `${t.digits} ${t.ampm}` : t.digits;
    this.renderButtons();
    this.tick();
  },

  cancel() {
    // Cancel always resets the spin counter, even when it looks disabled.
    if (sequencer) sequencer.cancel();
    if (this.state === 'idle') return;
    this.stopRunning();
  },

  stopRunning() {
    cancelAnimationFrame(this.raf);
    this.state = 'idle';
    this.run.hidden = true;
    $('#picker').hidden = false;
    picker.layout();
    this.renderButtons();
  },

  tick() {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (this.state !== 'running') return;
      const left = this.endAt - Date.now();
      if (left <= 0) {
        this.finish();
        return;
      }
      this.draw(left);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  },

  draw(left) {
    const secs = Math.ceil(left / 1000);
    const txt = fmtClock(secs);
    if (this.runTime.textContent !== txt) this.runTime.textContent = txt;
    const frac = 1 - left / this.total;
    this.ringFill.style.strokeDashoffset = String(-this.circumference * frac);
  },

  finish() {
    this.stopRunning();
    alertUI.show(this.total / 1000);
  },

  // Called when the app comes back to the foreground.
  catchUp() {
    if (this.state === 'running' && Date.now() >= this.endAt) this.finish();
  },
};

const alertUI = {
  root: $('#alert'),
  secs: 0,
  init() {
    $('#alert-stop').addEventListener('click', () => this.hide());
    $('#alert-repeat').addEventListener('click', () => {
      this.hide();
      timerUI.start(this.secs);
    });
  },
  show(secs) {
    this.secs = secs;
    $('#alert-time').textContent = '0:00';
    this.root.hidden = false;
    startRinging();
  },
  hide() {
    this.root.hidden = true;
    stopRinging();
  },
};

// Radial-ish chime, synthesised (no audio files).
let audio = null;
let ringTimer = null;
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio ??= new AC();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio */ }
}
function chime(t, freq) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + 0.36);
}
function startRinging() {
  if (!audio) return;
  const notes = [1318.5, 1568, 1760, 1568, 1975.5, 1568];
  const play = () => {
    const t0 = audio.currentTime + 0.03;
    notes.forEach((f, i) => chime(t0 + i * 0.13, f));
  };
  play();
  clearInterval(ringTimer);
  ringTimer = setInterval(play, 1400);
}
function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------
const recents = {
  list: store.get('tempo.recents', null) ?? [356, 300],
  root: $('#recents'),
  add(secs) {
    this.list = [secs, ...this.list.filter((s) => s !== secs)].slice(0, 6);
    store.set('tempo.recents', this.list);
    this.render();
  },
  render() {
    this.root.textContent = '';
    for (const secs of this.list) {
      const row = el('div', 'recent');
      const time = el('div', 'clock-time');
      time.appendChild(el('span', 'digits', fmtClock(secs)));
      row.appendChild(time);
      row.appendChild(el('div', 'recent-cap', fmtWords(secs)));
      const play = el('button', 'recent-play');
      play.type = 'button';
      play.setAttribute('aria-label', 'Start');
      play.appendChild(svgUse('i-play'));
      play.addEventListener('click', () => {
        if (timerUI.state !== 'idle') timerUI.stopRunning();
        timerUI.start(secs);
      });
      row.appendChild(play);
      this.root.appendChild(row);
    }
  },
};

// ---------------------------------------------------------------------------
// World Clock
// ---------------------------------------------------------------------------
const CITY_POOL = [
  ['Asia/Taipei', 'Taipei'],
  ['Pacific/Auckland', 'Auckland'],
  ['Europe/London', 'London'],
  ['America/New_York', 'New York'],
];
let localZone = 'UTC';
try { localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* UTC */ }
const localCity = (() => {
  const name = localZone.split('/').pop().replace(/_/g, ' ');
  return /^(UTC|GMT|Etc)/.test(localZone) ? 'Cupertino' : name;
})();
const cities = [[localZone, localCity], ...CITY_POOL.filter(([z]) => z !== localZone).slice(0, 2)];

function wallClock(date, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
}

function renderWorldClock() {
  const root = $('#wc-list');
  const now = new Date();
  const here = wallClock(now, localZone);
  root.textContent = '';
  for (const [zone, city] of cities) {
    const there = wallClock(now, zone);
    const diffMin = Math.round((there - here) / 60000);
    const dayDiff = Math.round((Math.floor(there / 86400000) - Math.floor(here / 86400000)));
    const day = dayDiff === 0 ? 'Today' : dayDiff > 0 ? 'Tomorrow' : 'Yesterday';
    const sign = diffMin < 0 ? '-' : '+';
    const a = Math.abs(diffMin);
    const off = a % 60 ? `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}` : String(a / 60);
    const row = el('div', 'wc-row');
    row.appendChild(el('div', 'wc-caption', `${day}, ${sign}${off}HRS`));
    row.appendChild(el('div', 'wc-city', city));
    const t = fmtTimeOfDay(now, zone);
    const time = el('div', 'clock-time');
    time.appendChild(el('span', 'digits', t.digits));
    if (t.ampm) time.appendChild(el('span', 'ampm', t.ampm));
    row.appendChild(time);
    root.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Alarms (static, toggles work)
// ---------------------------------------------------------------------------
const ALARMS = [
  { time: '6:30', ampm: 'AM', label: 'Alarm, weekdays', on: true },
  { time: '8:00', ampm: 'AM', label: 'Alarm, weekends', on: false },
];
function renderAlarms() {
  const root = $('#al-list');
  for (const a of ALARMS) {
    const row = el('div', 'al-row' + (a.on ? '' : ' off'));
    const time = el('div', 'clock-time');
    time.appendChild(el('span', 'digits', a.time));
    if (hour12) time.appendChild(el('span', 'ampm', a.ampm));
    else time.firstChild.textContent = a.ampm === 'PM' ? a.time.replace(/^\d+/, (h) => String(Number(h) + 12)) : a.time.padStart(5, '0');
    row.appendChild(time);
    row.appendChild(el('div', 'al-sub', a.label));
    const tg = el('button', 'toggle' + (a.on ? ' on' : ''));
    tg.type = 'button';
    tg.addEventListener('click', () => {
      a.on = !a.on;
      tg.classList.toggle('on', a.on);
      row.classList.toggle('off', !a.on);
    });
    row.appendChild(tg);
    root.appendChild(row);
  }
  if (!hour12) {
    const t = $('.al-sleep .clock-time');
    t.innerHTML = '<span class="digits">05:00</span>';
  }
}

// ---------------------------------------------------------------------------
// Stopwatch
// ---------------------------------------------------------------------------
const sw = {
  running: false,
  base: 0, // ms accumulated before the current run
  startAt: 0,
  laps: [], // completed lap durations (ms)
  lapBase: 0, // elapsed at the start of the current lap
  raf: 0,
  display: $('#sw-display'),
  left: $('#sw-left'),
  right: $('#sw-right'),
  lapsEl: $('#sw-laps'),

  elapsed() {
    return this.base + (this.running ? performance.now() - this.startAt : 0);
  },

  fmt(ms) {
    const cs = Math.floor(ms / 10);
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
    return h ? `${h}:${mmss}` : mmss;
  },

  show(ms) {
    const text = this.fmt(ms);
    if (text === this.shown) return;
    this.shown = text;
    if (!this.cells || this.cells.length !== text.length) {
      this.display.textContent = '';
      this.cells = [...text].map((ch) => this.display.appendChild(el(/\d/.test(ch) ? 'b' : 'i')));
      const fit = Math.min(90, (this.display.clientWidth || 361) / (text.replace(/\D/g, '').length * 0.5778 + text.replace(/\d/g, '').length * 0.2));
      this.display.style.fontSize = fit + 'px';
    }
    [...text].forEach((ch, i) => { if (this.cells[i].textContent !== ch) this.cells[i].textContent = ch; });
  },

  init() {
    this.show(0);
    this.right.addEventListener('click', () => (this.running ? this.stop() : this.start()));
    this.left.addEventListener('click', () => (this.running ? this.lap() : this.reset()));
  },

  start() {
    this.running = true;
    this.startAt = performance.now();
    this.loop();
    this.renderButtons();
    this.renderLaps();
  },

  stop() {
    this.base = this.elapsed();
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.show(this.base);
    this.renderButtons();
    this.renderLaps();
  },

  lap() {
    const now = this.elapsed();
    this.laps.push(now - this.lapBase);
    this.lapBase = now;
    this.renderLaps();
  },

  reset() {
    this.base = 0;
    this.laps = [];
    this.lapBase = 0;
    this.show(0);
    this.renderButtons();
    this.renderLaps();
  },

  loop() {
    cancelAnimationFrame(this.raf);
    const f = () => {
      if (!this.running) return;
      const e = this.elapsed();
      this.show(e);
      if (this.curLap) this.curLap.textContent = this.fmt(e - this.lapBase);
      this.raf = requestAnimationFrame(f);
    };
    f();
  },

  renderButtons() {
    const L = this.left.firstElementChild;
    const R = this.right.firstElementChild;
    if (this.running) {
      L.textContent = 'Lap';
      this.left.disabled = false;
      R.textContent = 'Stop';
      this.right.className = 'round-btn btn-red';
    } else {
      const fresh = this.elapsed() === 0;
      L.textContent = fresh ? 'Lap' : 'Reset';
      this.left.disabled = fresh;
      R.textContent = 'Start';
      this.right.className = 'round-btn btn-green';
    }
  },

  renderLaps() {
    this.lapsEl.textContent = '';
    this.curLap = null;
    const total = this.elapsed();
    if (total === 0 && !this.running) return;
    const best = this.laps.length > 1 ? Math.min(...this.laps) : null;
    const worst = this.laps.length > 1 ? Math.max(...this.laps) : null;
    const row = (n, ms, cls) => {
      const r = el('div', 'lap' + (cls ? ' ' + cls : ''));
      r.appendChild(el('span', null, `Lap ${n}`));
      const t = el('span', null, this.fmt(ms));
      r.appendChild(t);
      this.lapsEl.appendChild(r);
      return t;
    };
    this.curLap = row(this.laps.length + 1, total - this.lapBase);
    for (let i = this.laps.length - 1; i >= 0; i--) {
      const ms = this.laps[i];
      row(i + 1, ms, ms === best ? 'best' : ms === worst ? 'worst' : '');
    }
  },
};
function renderStopwatch() {
  sw.cells = null;
  sw.shown = null;
  sw.show(sw.elapsed());
  if (sw.running) sw.loop();
}

// ---------------------------------------------------------------------------
// Card entry (performer)
// ---------------------------------------------------------------------------
const CARD_KEYS = [['A', 'wide'], '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const NUMBER_KEYS = [['Enter', 'wide small'], '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', ['Delete', 'half small']];

function enterEntryMode() {
  entry = { steps: entrySteps(settings), idx: 0, values: [], suit: 'C', buffer: '' };
  mode = 'entry';
  renderTabs();
  activeTab = 'timers';
  placeCap(true);
  currentPage = null;
  showPage('timers');
}

function finishEntry() {
  entries = entry.values.slice();
  entrySettings = { ...settings };
  buildSequencer(computeTargets(settings, entries));
  rememberForce();
  entry = null;
  mode = 'normal';
  activeTab = 'timers';
  renderTabs();
  currentPage = null;
  showPage('timers');
  if (settings.practice) setTimeout(flash, 340);
}

function updateEntryTitle() {
  if (!entry) return;
  const step = entry.steps[entry.idx];
  const title = $('#entry-title');
  if (step.kind === 'number') {
    title.textContent = entry.buffer || 'Number';
  } else {
    const prefix = step.kind === 'peek' ? (settings.offsetType === 'top' ? '(Top) ' : '(Bottom) ') : '';
    title.textContent = prefix + SUIT_NAMES[entry.suit];
  }
  const dots = $('#entry-steps');
  dots.textContent = '';
  if (settings.useDouble) {
    for (let i = 0; i < 2; i++) dots.appendChild(el('i', i === step.force ? 'on' : ''));
  }
}

function renderKeypad() {
  const pad = $('#keypad');
  pad.textContent = '';
  const keys = settings.stack === 'number' ? NUMBER_KEYS : CARD_KEYS;
  for (const k of keys) {
    const [label, cls] = Array.isArray(k) ? k : [k, ''];
    const b = el('button', 'key' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.dataset.key = label;
    pad.appendChild(b);
  }
  updateEntryTitle();
}

$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('.key');
  if (!b || !entry) return;
  const key = b.dataset.key;
  const step = entry.steps[entry.idx];
  if (step.kind === 'number') {
    if (key === 'Delete') entry.buffer = entry.buffer.slice(0, -1);
    else if (key === 'Enter') {
      const n = entry.buffer === '' ? NaN : Number(entry.buffer);
      if (!Number.isInteger(n) || !splitDigits(n, settings.wheel)) {
        nudgeTitle();
        return;
      }
      commitEntry(n);
      return;
    } else if (entry.buffer.length < 6) {
      entry.buffer = entry.buffer === '0' ? key : entry.buffer + key;
    }
    updateEntryTitle();
    return;
  }
  commitEntry(key + entry.suit);
});

function commitEntry(value) {
  entry.values[entry.idx] = value;
  entry.idx++;
  entry.buffer = '';
  if (settings.practice) flash();
  if (entry.idx >= entry.steps.length) finishEntry();
  else updateEntryTitle();
}

function nudgeTitle() {
  const t = $('#entry-title');
  t.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 220 });
}

function flash() {
  const f = $('#flash');
  f.classList.remove('go');
  f.getBoundingClientRect();
  f.classList.add('go');
}

// ---------------------------------------------------------------------------
// Settings sheet (performer)
// ---------------------------------------------------------------------------
const sheet = $('#sheet');
const sheetBackdrop = $('#sheet-backdrop');
let sheetOpen = false;
let resetArmed = false;

function openSettings(fromLongPress = false) {
  if (sheetOpen) return;
  sheetOpen = true;
  resetArmed = false;
  renderSettings();
  if (fromLongPress) {
    // The finger that long-pressed is still down: don't let its release tap the sheet.
    sheet.style.pointerEvents = sheetBackdrop.style.pointerEvents = 'none';
    const release = () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      setTimeout(() => { sheet.style.pointerEvents = sheetBackdrop.style.pointerEvents = ''; }, 120);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  }
  sheet.classList.remove('closing');
  sheetBackdrop.classList.remove('closing');
  sheet.hidden = false;
  sheetBackdrop.hidden = false;
  $('#sheet-scroll').scrollTop = 0;
}

function closeSettings(then) {
  if (!sheetOpen) return;
  sheetOpen = false;
  closeMenu();
  sheet.classList.add('closing');
  sheetBackdrop.classList.add('closing');
  setTimeout(() => {
    sheet.hidden = true;
    sheetBackdrop.hidden = true;
    if (then) then();
  }, 300);
}

$('#sheet-close').addEventListener('click', () => closeSettings());
$('#sheet-done').addEventListener('click', () => closeSettings());
sheetBackdrop.addEventListener('click', () => closeSettings());

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (['forceSpin', 'secondSpin', 'wheel'].includes(key) && sequencer) {
    sequencer.configure({ firstSpin: settings.forceSpin, secondSpin: settings.secondSpin, wheel: settings.wheel });
  }
  if (['stack', 'useOffset', 'useDouble', 'offsetType'].includes(key) && entries && sameSteps(settings, entrySettings)) {
    // Same entry shape: re-derive the numbers (e.g. a different stack or peek type).
    entrySettings = { ...settings };
    buildSequencer(computeTargets(settings, entries));
  }
  if (key === 'remember' || key === 'stack' || key === 'offsetType') rememberForce();
  if (mode === 'entry' && ['stack', 'useOffset', 'useDouble'].includes(key)) {
    // Entry in progress: restart it with the new shape.
    enterEntryMode();
  }
  renderSettings();
}

function statusText() {
  if (mode === 'entry') return 'Waiting for card entry.';
  if (!sequencer || !sequencer.targets.length) return 'No force set. Tap Re-enter Cards.';
  if (entrySettings && !sameSteps(settings, entrySettings)) return 'Settings changed since entry. Re-enter Cards to apply them.';
  const n = sequencer.targets.length;
  const nums = settings.practice ? ` (${sequencer.targets.join(', ')})` : '';
  if (sequencer.done) return `All forces have landed${nums}. Cancel on the Timers screen re-arms them.`;
  const which = n > 1 ? `Force ${sequencer.phase + 1} of ${n}` : 'Force';
  return `${which}${nums} lands on spin ${sequencer.spinsNeeded}; ${sequencer.count} spin${sequencer.count === 1 ? '' : 's'} so far.`;
}

const WHEEL_NAMES = { h: 'Hours', m: 'Minutes', s: 'Seconds' };
const OFFSET_NAMES = { top: 'Peek Top Card', bottom: 'Peek Bottom Card' };

function renderSettings() {
  const root = $('#sheet-scroll');
  const keep = root.scrollTop;
  root.textContent = '';
  const group = (header, rows, footer) => {
    if (header) root.appendChild(el('div', 's-header', header));
    const g = el('div', 's-group');
    rows.filter(Boolean).forEach((r) => g.appendChild(r));
    root.appendChild(g);
    if (footer) root.appendChild(el('div', 's-footer', footer));
  };
  const row = (label, right, { disabled = false, tap = null } = {}) => {
    const r = el('div', 's-row' + (disabled ? ' disabled' : '') + (tap ? ' tap' : ''));
    r.appendChild(el('span', 's-label', label));
    if (right) r.appendChild(right);
    if (tap) r.addEventListener('click', () => tap(r));
    return r;
  };
  const toggle = (key) => {
    const t = el('button', 'toggle' + (settings[key] ? ' on' : ''));
    t.type = 'button';
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      setSetting(key, !settings[key]);
    });
    return t;
  };
  const stepper = (key, min, max) => {
    const wrap = el('span', 's-value');
    wrap.appendChild(el('span', 's-num', String(settings[key])));
    const s = el('div', 'stepper');
    const minus = el('button', null, '−');
    const plus = el('button', null, '+');
    minus.type = plus.type = 'button';
    minus.addEventListener('click', () => setSetting(key, clamp(settings[key] - 1, min, max)));
    plus.addEventListener('click', () => setSetting(key, clamp(settings[key] + 1, min, max)));
    s.append(minus, el('i'), plus);
    wrap.appendChild(s);
    return wrap;
  };
  const menuValue = (text) => {
    const v = el('span', 's-value', text);
    v.appendChild(svgUse('i-updown'));
    return v;
  };
  const menuRow = (label, key, options, disabled = false) =>
    row(label, menuValue(options[settings[key]]), {
      disabled,
      tap: (r) => openMenu(r, options, settings[key], (v) => setSetting(key, v)),
    });

  const stackOptions = Object.fromEntries(STACK_IDS.map((id) => [id, STACKS[id].name]));
  const numberMode = settings.stack === 'number';

  group('Deck', [menuRow('Stack', 'stack', stackOptions)],
    numberMode ? 'Number mode: enter any number on the # tab. Offset does not apply.' : 'Check the stack order in stacks.js against your deck.');
  group('Force', [
    row('Force On Spin', stepper('forceSpin', 1, 20)),
    menuRow('Force Wheel', 'wheel', WHEEL_NAMES),
  ]);
  group('Double Force', [
    row('Use Double Force', toggle('useDouble')),
    row('Second Force On Spin', stepper('secondSpin', 1, 20), { disabled: !settings.useDouble }),
  ], 'The second force counts spins from when the first one lands.');
  group('Offset', [
    row('Use Offset', toggle('useOffset'), { disabled: numberMode }),
    menuRow('Offset Type', 'offsetType', OFFSET_NAMES, numberMode || !settings.useOffset),
  ]);
  group('Performance', [
    row('Remember Force on Quit', toggle('remember')),
    row('Practice Mode', toggle('practice')),
  ], statusText());

  const reenter = el('div', 's-row s-button tap', 'Re-enter Cards');
  reenter.addEventListener('click', () => closeSettings(() => enterEntryMode()));
  group(null, [reenter]);
  root.lastElementChild.style.marginTop = '26px';

  const reset = el('div', 's-row s-button danger tap', resetArmed ? 'Tap Again to Reset Everything' : 'Reset');
  reset.addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      renderSettings();
      setTimeout(() => {
        if (resetArmed) { resetArmed = false; if (sheetOpen) renderSettings(); }
      }, 3000);
      return;
    }
    resetArmed = false;
    settings = { ...DEFAULTS };
    saveSettings();
    entries = null;
    entrySettings = null;
    sequencer = null;
    store.del('tempo.force');
    closeSettings(() => enterEntryMode());
  });
  group(null, [reset]);
  root.lastElementChild.style.marginTop = '26px';

  root.appendChild(el('div', 's-version', `Tempo ${VERSION}`));
  root.scrollTop = keep;
}

// Pop-up menu (iOS 26 style)
const menu = $('#menu');
const menuBackdrop = $('#menu-backdrop');
function openMenu(anchorRow, options, current, onPick) {
  menu.textContent = '';
  for (const [value, label] of Object.entries(options)) {
    const b = el('button', value === current ? 'checked' : '');
    b.type = 'button';
    b.appendChild(svgUse('i-check'));
    b.appendChild(el('span', null, label));
    b.addEventListener('click', () => {
      closeMenu();
      if (value !== current) onPick(value);
    });
    menu.appendChild(b);
  }
  menu.hidden = false;
  menuBackdrop.hidden = false;
  const r = anchorRow.getBoundingClientRect();
  const appR = $('#app').getBoundingClientRect();
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  let top = r.bottom - appR.top + 4;
  if (top + mh > appR.height - 20) top = Math.max(20, r.top - appR.top - mh - 4);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(16, r.right - appR.left - mw - 16) + 'px';
}
function closeMenu() {
  menu.hidden = true;
  menuBackdrop.hidden = true;
}
menuBackdrop.addEventListener('click', closeMenu);

// ---------------------------------------------------------------------------
// Large-title collapse + scroll-edge effect
// ---------------------------------------------------------------------------
document.querySelectorAll('.page').forEach((page) => {
  const sc = page.querySelector('.scroller');
  if (!sc) return;
  sc.addEventListener('scroll', () => {
    page.classList.toggle('scrolled', sc.scrollTop > 1);
    page.classList.toggle('titled', sc.scrollTop > 40);
  }, { passive: true });
});

// ---------------------------------------------------------------------------
// Device behaviour: wake lock, privacy shield, no zoom/selection/callouts
// ---------------------------------------------------------------------------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}
let wakeTried = false;
function wakeLockSoon() {
  if (wakeTried && wakeLock) return;
  wakeTried = true;
  requestWakeLock();
}

const shield = $('#shield');
function onHide() {
  if (mode === 'entry' || sheetOpen) shield.classList.add('on');
}
function onShow() {
  requestWakeLock();
  timerUI.catchUp();
  if (currentPage === 'worldclock') renderWorldClock();
  requestAnimationFrame(() => requestAnimationFrame(() => shield.classList.remove('on')));
}
document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? onHide() : onShow()));
window.addEventListener('pagehide', onHide);
window.addEventListener('pageshow', onShow);
window.addEventListener('blur', onHide);
window.addEventListener('focus', onShow);

const stop = (e) => e.preventDefault();
['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'selectstart', 'dragstart'].forEach((t) =>
  document.addEventListener(t, stop, { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('pointerdown', wakeLockSoon, { passive: true });

window.addEventListener('resize', () => {
  layoutTabs(true);
  picker.layout();
});

setInterval(() => {
  if (currentPage === 'worldclock' && document.visibilityState === 'visible') renderWorldClock();
}, 1000);

// ---------------------------------------------------------------------------
// Boot: a cold launch always lands on Timers in entry mode, unless a remembered
// force exists.
// ---------------------------------------------------------------------------
picker.init();
timerUI.init();
alertUI.init();
sw.init();
recents.render();
renderAlarms();

const remembered = settings.remember ? store.get('tempo.force', null) : null;
if (remembered && Array.isArray(remembered.entries) && remembered.settings) {
  entries = remembered.entries;
  entrySettings = { ...settings, ...remembered.settings };
  buildSequencer(computeTargets(entrySettings, entries));
  mode = 'normal';
  renderTabs();
  selectTab('timers', true);
} else {
  enterEntryMode();
}
picker.layout();
requestWakeLock();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline-only niceties */ });
}
