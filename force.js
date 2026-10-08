// Force logic for Tempo: how a forced number is laid out on the wheels, which spin
// delivers it, and how a flick is bent to land on it. No DOM in here, so it can be
// unit-tested in Node (see tests/).

export const WHEELS = ['h', 'm', 's'];
export const RANGE = { h: [0, 23], m: [0, 59], s: [0, 59] };

const fits = (w, v) => v >= RANGE[w][0] && v <= RANGE[w][1];

/**
 * Lay a number out on the wheels so the display reads as that number.
 *
 * If it fits the force wheel it goes there alone. Otherwise its digits are split
 * across neighbouring wheels, read left to right: 125 on the seconds wheel becomes
 * 1 min 25 sec; card 52 on the hours wheel becomes 5 hours 2 min. No part may
 * need a leading zero, because the wheels never show one.
 *
 * Returns e.g. { m: 1, s: 25 }, or null if the number can't be shown.
 */
export function splitDigits(n, wheel = 's') {
  if (!Number.isInteger(n) || n < 0) return null;
  if (fits(wheel, n)) return { [wheel]: n };

  const digits = String(n);
  const wi = WHEELS.indexOf(wheel);
  // Runs of adjacent wheels that include the force wheel: pairs first, then all three.
  // Prefer extending to the left (minutes before seconds reads naturally).
  const groups = [];
  if (wi > 0) groups.push(WHEELS.slice(wi - 1, wi + 1));
  if (wi < 2) groups.push(WHEELS.slice(wi, wi + 2));
  groups.push(WHEELS);

  for (const group of groups) {
    const best = bestCut(digits, group, wheel);
    if (best) return best;
  }
  return null;
}

// Try every way of cutting `digits` into group.length parts; keep the one that
// puts the most digits on the force wheel.
function bestCut(digits, group, wheel) {
  let best = null;
  let bestScore = -1;
  const cuts = (start, k) => {
    if (k === 1) return [[digits.slice(start)]];
    const out = [];
    for (let end = start + 1; end <= digits.length - (k - 1); end++) {
      for (const rest of cuts(end, k - 1)) out.push([digits.slice(start, end), ...rest]);
    }
    return out;
  };
  for (const parts of cuts(0, group.length)) {
    if (parts.some((p) => p.length > 1 && p[0] === '0')) continue;
    const values = parts.map(Number);
    if (!values.every((v, i) => fits(group[i], v))) continue;
    const score = parts[group.indexOf(wheel)].length;
    if (score > bestScore) {
      bestScore = score;
      best = Object.fromEntries(group.map((w, i) => [w, values[i]]));
    }
  }
  return best;
}

/**
 * Decides which flick is forced.
 *
 * - Only flicks of the force wheel count as spins.
 * - The force lands on spin `firstSpin`. With a second target, the second force
 *   lands `secondSpin` spins after the first one has landed.
 * - When a number is split across wheels, the other wheels involved also land on
 *   their part on any flick once the force is due, until every part is showing.
 * - cancel() resets the count for the force that is pending. Once every force has
 *   landed, cancel() re-arms the whole sequence.
 */
export class ForceSequencer {
  constructor({ targets = [], firstSpin = 3, secondSpin = 3, wheel = 's' } = {}) {
    this.targets = targets.filter((n) => Number.isInteger(n));
    this.firstSpin = Math.max(1, firstSpin | 0);
    this.secondSpin = Math.max(1, secondSpin | 0);
    this.wheel = wheel;
    this.phase = 0; // index of the pending force
    this.count = 0; // completed force-wheel spins toward the pending force
    this.landed = false; // force wheel has landed on its part for the pending force
  }

  configure({ firstSpin, secondSpin, wheel }) {
    if (firstSpin != null) this.firstSpin = Math.max(1, firstSpin | 0);
    if (secondSpin != null) this.secondSpin = Math.max(1, secondSpin | 0);
    if (wheel && wheel !== this.wheel) {
      this.wheel = wheel;
      this.landed = false;
    }
  }

  get done() {
    return this.phase >= this.targets.length;
  }

  get spinsNeeded() {
    return this.phase === 0 ? this.firstSpin : this.secondSpin;
  }

  /** The wheel values the pending force needs, e.g. { s: 23 }. */
  get parts() {
    if (this.done) return null;
    return splitDigits(this.targets[this.phase], this.wheel);
  }

  /** True when the next force-wheel flick is the forced one. */
  get due() {
    return !this.done && this.count >= this.spinsNeeded - 1;
  }

  /** Value wheel `w` must land on for the flick that is starting, or null for a free spin. */
  forcedValueFor(w) {
    const parts = this.parts;
    if (!parts || !(w in parts) || !this.due) return null;
    return parts[w];
  }

  /**
   * Report that wheel `w` came to rest after a flick.
   * `values` is every wheel's value now; `forced` says whether the flick was planned
   * onto a forced value (false if it couldn't reach it).
   * Returns true when this rest completed a force.
   */
  onFlickRest(w, values, forced) {
    if (this.done) return false;
    const parts = this.parts;
    if (w === this.wheel) {
      if (!this.due) this.count++;
      else if (forced) this.landed = true;
      // Due but not forced (an unreachable target on a bounded wheel): the force
      // waits for the next flick, so this one doesn't count.
    }
    if (this.landed && parts && Object.entries(parts).every(([k, v]) => values[k] === v)) {
      this.phase++;
      this.count = 0;
      this.landed = false;
      return true;
    }
    return false;
  }

  cancel() {
    if (this.done) this.phase = 0;
    this.count = 0;
    this.landed = false;
  }
}

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Plan where a flick comes to rest. All units are rows and milliseconds.
 *
 *   pos     current (fractional) row index; row k shows value k (cyclic: k mod count)
 *   v       release velocity in rows/ms, positive toward higher values
 *   tau     deceleration time constant; the wheel follows
 *           pos(t) = pos + d * (1 - exp(-t / tau))
 *   target  forced value, or null for a free spin
 *
 * A free spin travels v * tau and is rounded to the nearest row. A forced spin
 * picks the row showing `target` (in the flick direction) whose travel is closest
 * in ratio to the natural travel, then splits the difference mostly into the glide
 * time and a little into the launch speed, so it looks like the same flick.
 *
 * Returns { to, tau, forced } or, for a forced spin that can't reach the target
 * (bounded wheel, wrong direction), null.
 */
export function planLanding({ pos, v, tau, target = null, cyclic = false, min = 0, max = 59 }) {
  const natural = v * tau;
  if (target == null) {
    return { to: Math.round(pos + natural), tau, forced: false };
  }
  const dir = Math.sign(v) || 1;
  const D = Math.max(Math.abs(natural), 0.5);
  const candidates = [];
  if (cyclic) {
    // Row k shows target whenever k ≡ target (mod count). Start at least half a
    // row ahead of pos and collect the next few laps in the flick direction.
    const count = max - min + 1;
    const start = dir > 0 ? Math.ceil(pos + 0.5) : Math.floor(pos - 0.5);
    let k = dir > 0 ? start + mod(target - start, count) : start - mod(start - target, count);
    for (let i = 0; i < 6; i++, k += dir * count) candidates.push(k);
  } else {
    const k = target;
    if ((k - pos) * dir < 0.5) return null;
    if ((k - pos) * dir / D < 0.2) return null; // would look like the flick died instantly
    candidates.push(k);
  }
  let best = candidates[0];
  let bestErr = Infinity;
  for (const k of candidates) {
    const err = Math.abs(Math.log(Math.abs(k - pos) / D));
    if (err < bestErr) { bestErr = err; best = k; }
  }
  // Put most of the change into glide time (friction) and little into launch
  // speed: a 3x longer travel becomes ~1.25x speed and ~2.4x glide.
  const r = Math.abs(best - pos) / D;
  const tau2 = Math.min(Math.max(tau * Math.pow(r, 0.8), tau * 0.3), tau * 4);
  return { to: best, tau: tau2, forced: true };
}
