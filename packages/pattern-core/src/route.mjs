// A chain's wiring, from the tree .split() and .bands() leave on a Sig (Sig#fxRoute).
//
// The tree is what the code says; this is what an engine builds. It is engine-neutral - both
// engines take the same plan and the scheduler drives the same controls - and it is already
// simplified, so neither engine has to know how the code was nested:
//
//   - A split at the very end of a branch is folded into the branch's own sum: its branches'
//     outputs feed the outer sum directly, each scaled by both levels. `b.fx(A).split(...)` as the
//     last thing in a branch adds no sum of its own.
//   - Two terms of one sum that come from the same place are one term (two `x => x` branches are
//     one copy of the signal at their combined level and pan).
//   - A sum with a single term is no sum at all: whatever reads it reads that term instead.
//
// What is left is a small graph:
//
//   plan = {
//     reads: { [slot]: Ref },   // what each effect slot reads, for every slot in the tree
//     keys: { [slot]: Ref },    // what each crossover after a .bands()' first takes as its key
//     out: Ref,                 // what the channel strip reads
//     sums: { [id]: Ref[] },    // each sum, as its terms
//     order: [slot, ...],       // every slot in the tree, in the order its audio runs
//   }
//   Ref = { s: Src, g: gain }  // a signal, at a gain (0 = unity)
//   Src = { k: 'in' } | { k: 'slot', p } | { k: 'rest', p } | { k: 'ap', p } | { k: 'sum', id }
//
// `in` is the chain input (the instrument and the sampler, after .gain()). Gain g > 0 is a pair of
// channel controls, rl<g> (the level) and rp<g> (the pan, the track strip's own law), which the
// scheduler drives like any other control - so a branch's .postgain(lfo()) runs natively, a
// pattern glides, an expression is evaluated in the engine.
//
// A slot is the user's own effect, numbered as the code numbers it (1, 2, ...), or a .bands()
// crossover, 'x1', 'x2', ... - which is never one of the user's: the code does not see it, its
// numbering does not count it, and an engine that has to give it a place in the chain (the
// desktop's track synth) gives it one of its own, by `order`. Crossover k's frequency is the
// channel control xo<k>, as a position on the Crossover's Frequency control (see
// crossoverPosition), so it takes anything a control takes.
//
// A crossover has three outputs: its own (`slot`, the band below its frequency), the rest above it
// (`rest`), and its key through the same filters' all-pass (`ap`). Crossover k splits what
// crossover k - 1 left above it, and band k - 1 is played between the two. The bands below a
// crossover have to be turned in phase exactly as that crossover turns the bands above it, or they
// would not sum back flat, so the bands summed so far are crossover k's key and come back out of
// it as `ap`:
//
//   R1 = band 0       Rk = ap of crossover k (its key R(k-1)) + band k-1       out = RN + band N
//
// Every read is of a slot before the reader in `order`, so neither engine adds a block of delay.
import { Sig, toSignal, multiplyGain, warnPattern } from './signal.mjs';

/** The engines' internal device a .bands() crossover is, and its Frequency control's range in Hz. */
export const CROSSOVER_DEVICE = 'Crossover';
export const CROSSOVER_MIN_HZ = 20;
export const CROSSOVER_MAX_HZ = 20000;
const CROSSOVER_REST_HZ = 1000;

/**
 * A crossover frequency in Hz as a position on the Crossover's Frequency control. The control's
 * range is linear, so this is one straight line whatever the frequency is - a number, a pattern, a
 * modulator or an expression - and a straight line on a modulator folds into its bounds, so it
 * stays native.
 */
export function crossoverPosition(f) {
  const span = CROSSOVER_MAX_HZ - CROSSOVER_MIN_HZ;
  if (typeof f === 'number') return toSignal(Math.min(1, Math.max(0, (f - CROSSOVER_MIN_HZ) / span)));
  return toSignal(f).sub(CROSSOVER_MIN_HZ).div(span);
}

/** Whether a channel control name is one a plan drives (a branch's level or pan, a crossover). */
export function isRouteControl(name) {
  return /^(rl|rp|xo)\d+$/.test(String(name));
}

/** What a route control reads as when nothing drives it: unity level, center pan, 1 kHz. */
export function routeControlDefault(name) {
  const m = /^(rl|rp|xo)\d+$/.exec(String(name));
  if (!m) return undefined;
  if (m[1] === 'xo') return (CROSSOVER_REST_HZ - CROSSOVER_MIN_HZ) / (CROSSOVER_MAX_HZ - CROSSOVER_MIN_HZ);
  return m[1] === 'rl' ? 1 : 0;
}

const UNITY = Object.freeze({ level: null, pan: null });
const isUnity = (g) => g.level == null && g.pan == null;

// The strip's pan law (Balance2 x sqrt(2) on the desktop, panGains in the web engine): each side's
// gain for a pan from -1 to 1, referenced to the center.
function panSides(pan) {
  const p = Math.min(1, Math.max(-1, Number(pan) || 0));
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

// A level and a pan back out of the two sides' gains. Any pair of the same sign is one, since the
// law's sides square-sum to 2; a pair of opposite signs is not, and keeps the larger side's sign.
function fromSides(l, r) {
  const sign = Math.abs(l) >= Math.abs(r) ? Math.sign(l) || 1 : Math.sign(r) || 1;
  const level = sign * Math.sqrt((l * l + r * r) / 2);
  if (level === 0) return [0, 0];
  const angle = Math.atan2(Math.abs(r), Math.abs(l));
  return [level, Math.min(1, Math.max(-1, (angle * 4) / Math.PI - 1))];
}

const read = (sig, fallback, t, cps, pos) => {
  if (!sig) return fallback;
  const v = sig.sample(t, cps, pos);
  return v == null ? fallback : Number(v);
};

// The two sides of a list of gains summed, as functions of time.
function sidesAt(gains, t, cps, pos) {
  let l = 0;
  let r = 0;
  for (const g of gains) {
    const level = read(g.level, 1, t, cps, pos);
    const [pl, pr] = g.pan ? panSides(read(g.pan, 0, t, cps, pos)) : [1, 1];
    l += level * pl;
    r += level * pr;
  }
  return [l, r];
}

const constOf = (sig) => (sig == null ? null : typeof sig.constVal === 'number' ? sig.constVal : null);

// One gain standing for `gains` summed - the terms of a merge.
function summed(gains) {
  if (gains.length === 1) return gains[0];
  const allConst = gains.every((g) => (g.level == null || constOf(g.level) != null) && (g.pan == null || constOf(g.pan) != null));
  if (allConst) {
    const [l, r] = sidesAt(gains, 0, 1, 0);
    const [level, pan] = fromSides(l, r);
    return { level: level === 1 ? null : toSignal(level), pan: pan === 0 ? null : toSignal(pan) };
  }
  return {
    level: new Sig((t, cps, pos) => fromSides(...sidesAt(gains, t, cps, pos))[0]),
    pan: new Sig((t, cps, pos) => fromSides(...sidesAt(gains, t, cps, pos))[1]),
  };
}

// One gain after another: the levels multiply (natively, where one of them is a number) and the
// pans compose side by side.
function compose(a, b) {
  if (isUnity(a)) return b;
  if (isUnity(b)) return a;
  const level = a.level && b.level ? multiplyGain(a.level, b.level) : a.level ?? b.level;
  if (!(a.pan && b.pan)) return { level, pan: a.pan ?? b.pan };
  // Two pans in a row: each side is the product of both laws, read back as one level and pan.
  const sides = (t, cps, pos) => {
    const [al, ar] = panSides(read(a.pan, 0, t, cps, pos));
    const [bl, br] = panSides(read(b.pan, 0, t, cps, pos));
    return fromSides(al * bl, ar * br);
  };
  const panLevel = new Sig((t, cps, pos) => sides(t, cps, pos)[0]);
  return {
    level: level ? multiplyGain(level, panLevel) : panLevel,
    pan: new Sig((t, cps, pos) => sides(t, cps, pos)[1]),
  };
}

const srcKey = (s) => (s.k === 'in' ? 'in' : s.k === 'sum' ? `m${s.id}` : `${s.k}${s.p}`);

/**
 * The plan for a chain, and the controls it adds, or null for a chain with no tree (a plain line
 * of slots, which every engine already plays). `controls` holds rl/rp for each gain, as Sigs for
 * the scheduler to drive.
 */
export function routePlan(sig) {
  const route = sig?.fxRoute;
  if (!route) return null;
  const reads = {};
  const keys = {};
  const sums = {};
  const order = [];
  const xo = {};
  let nextSum = 0;
  let nextCrossover = 0;

  // Terms gathered per sum before they are merged: id -> Map(srcKey -> { s, gains: [] }).
  const pending = new Map();
  const open = () => {
    const id = String(nextSum++);
    pending.set(id, new Map());
    return id;
  };
  const addTerm = (id, ref) => {
    const terms = pending.get(id);
    const key = srcKey(ref.s);
    const held = terms.get(key);
    if (held) held.gains.push(ref.gain);
    else terms.set(key, { s: ref.s, gains: [ref.gain] });
  };

  // A sum is done once all its branches are walked: its terms merged, and a sum of one term
  // dissolved into that term (the reader reads the term, at its gain) - unless it is a crossover's
  // key, which is read as a sum whatever it holds.
  const finish = (id, { keep = false } = {}) => {
    const terms = [...pending.get(id).values()].map((t) => ({ s: t.s, gain: summed(t.gains) }));
    pending.delete(id);
    if (terms.length === 1 && !keep) return terms[0];
    sums[id] = terms;
    return { s: { k: 'sum', id }, gain: UNITY };
  };

  const branchGain = (b) => ({ level: b.level ?? null, pan: b.pan ?? null });
  const scaled = (ref, g) => ({ s: ref.s, gain: compose(ref.gain, g) });

  // One branch walked from `start`, everything it ends in poured into `into` at its own level.
  // (A function declaration, so it and walk can call each other.)
  function pour(b, start, into) {
    const g = branchGain(b);
    const end = walk(b.items, start, (ref) => into(scaled(ref, g)));
    if (end) into(scaled(end, g));
  }

  // Walks one list of items from `from`, recording what each slot reads. Returns where the list
  // ends, or null when its last item poured itself into `sink` (a split at the end of a branch).
  function walk(items, from, sink) {
    let cur = from;
    items.forEach((item, idx) => {
      const last = idx === items.length - 1;
      if (typeof item === 'number') {
        reads[item] = cur;
        order.push(item);
        cur = { s: { k: 'slot', p: item }, gain: UNITY };
        return;
      }
      if (item.split) {
        if (last && sink) {
          item.split.forEach((b) => pour(b, cur, sink));
          cur = null;
          return;
        }
        const id = open();
        item.split.forEach((b) => pour(b, cur, (ref) => addTerm(id, ref)));
        cur = finish(id);
        return;
      }
      if (item.bands) {
        const tail = last && sink;
        const { freqs, branches } = item.bands;
        const slots = freqs.map((f) => {
          const id = `x${++nextCrossover}`;
          xo[`xo${nextCrossover}`] = crossoverPosition(f);
          return id;
        });
        const outId = tail ? null : open();
        const intoOut = tail ? sink : (ref) => addTerm(outId, ref);
        let rest = cur;
        let key = null;
        slots.forEach((p, k) => {
          reads[p] = rest;
          order.push(p);
          const final = k === slots.length - 1;
          const id = final ? null : open();
          const into = final ? intoOut : (ref) => addTerm(id, ref);
          if (key) {
            keys[p] = key;
            into({ s: { k: 'ap', p }, gain: UNITY });
          }
          pour(branches[k], { s: { k: 'slot', p }, gain: UNITY }, into);
          if (!final) key = finish(id, { keep: true });
          rest = { s: { k: 'rest', p }, gain: UNITY };
        });
        pour(branches[slots.length], rest, intoOut);
        cur = tail ? null : finish(outId);
      }
    });
    return cur;
  }

  const out = walk(route, { s: { k: 'in' }, gain: UNITY }, null);

  // A sum that is only ever a term of other sums - the clean branch of a split whose input is a
  // split nothing else reads - is spelled out into its own terms there, at the term's gain: the
  // same signal, and one less thing for an engine to make on its own.
  const isRead = (id) => [...Object.values(reads), ...Object.values(keys)].some((r) => r.s.k === 'sum' && r.s.id === id)
    || (out?.s.k === 'sum' && out.s.id === id);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, terms] of Object.entries(sums)) {
      const next = [];
      for (const t of terms) {
        if (t.s.k === 'sum' && !isRead(t.s.id) && sums[t.s.id]) {
          for (const inner of sums[t.s.id]) next.push(scaled(inner, t.gain));
          changed = true;
        } else next.push(t);
      }
      if (next.length !== terms.length || changed) {
        const merged = new Map();
        for (const t of next) {
          const key = srcKey(t.s);
          if (merged.has(key)) merged.get(key).gains.push(t.gain);
          else merged.set(key, { s: t.s, gains: [t.gain] });
        }
        sums[id] = [...merged.values()].map((t) => ({ s: t.s, gain: summed(t.gains) }));
      }
    }
    for (const id of Object.keys(sums)) {
      const used = isRead(id) || Object.values(sums).some((ts) => ts.some((t) => t.s.k === 'sum' && t.s.id === id));
      if (!used) delete sums[id];
    }
  }

  // Every gain that is not unity becomes a numbered pair of controls. The same pair of signals is
  // the same gain, wherever it is read.
  const controls = { ...xo };
  const gainIndex = new Map();
  const index = (gain) => {
    if (isUnity(gain)) return 0;
    for (const [g, k] of gainIndex) if (g.level === gain.level && g.pan === gain.pan) return k;
    const k = gainIndex.size + 1;
    gainIndex.set(gain, k);
    controls[`rl${k}`] = gain.level ?? toSignal(1);
    controls[`rp${k}`] = gain.pan ?? toSignal(0);
    return k;
  };
  const ref = (r) => ({ s: r.s, g: index(r.gain) });

  const plan = {
    reads: Object.fromEntries(Object.entries(reads).map(([p, r]) => [p, ref(r)])),
    keys: Object.fromEntries(Object.entries(keys).map(([p, r]) => [p, ref(r)])),
    out: ref(out ?? { s: { k: 'in' }, gain: UNITY }),
    sums: Object.fromEntries(Object.entries(sums).map(([id, terms]) => [id, terms.map(ref)])),
    order,
  };
  return { plan, controls };
}

/**
 * Where each of the user's effect slots sits in a chain's branches, for a host drawing the chain:
 * `{ [slot]: { depth, branch } }` - depth 0 on the trunk and one more inside each
 * .split()/.bands(), branch the 1-based branch it is in (null on the trunk). Crossovers are not
 * the user's and are not listed. Null for a plain chain, which has nothing to say past its slot
 * numbers.
 */
export function routeSlots(sig) {
  const route = sig?.fxRoute;
  if (!route) return null;
  const out = {};
  const walk = (items, depth, branch) => {
    for (const item of items) {
      if (typeof item === 'number') {
        out[item] = { depth, branch };
        continue;
      }
      const branches = item.split ?? item.bands?.branches ?? [];
      branches.forEach((b, i) => walk(b.items, depth + 1, i + 1));
    }
  };
  walk(route, 0, null);
  return out;
}

/** Every Ref a plan holds, with where it is read: [where, ref]. */
export function planRefs(plan) {
  const out = [];
  const slotOf = (p) => (/^\d+$/.test(p) ? Number(p) : p);
  for (const [p, r] of Object.entries(plan.reads)) out.push([{ k: 'read', p: slotOf(p) }, r]);
  for (const [p, r] of Object.entries(plan.keys ?? {})) out.push([{ k: 'key', p: slotOf(p) }, r]);
  out.push([{ k: 'out' }, plan.out]);
  for (const [id, terms] of Object.entries(plan.sums)) terms.forEach((r, t) => out.push([{ k: 'term', id, t }, r]));
  return out;
}

/**
 * How late each slot's output reaches the track output, by slot, given each slot's own delay
 * (`per`, seconds, the engines' slotLatencies): the longest path, since a sum waits for nothing and
 * the latest of its terms is what is heard last. Index 0 is the whole chain, as Scheduler's
 * compensation reads it. A crossover's three outputs all leave its slot, so they count as one.
 */
export function routeLatencies(plan, per) {
  const own = (p) => (Number(per?.[p]) > 0 ? Number(per[p]) : 0);
  const nodeKey = (s) => (s.k === 'rest' || s.k === 'ap' ? `slot${s.p}` : srcKey(s));
  const consumers = new Map(); // nodeKey -> [consumer]
  const add = (src, c) => {
    const key = nodeKey(src);
    if (!consumers.has(key)) consumers.set(key, []);
    consumers.get(key).push(c);
  };
  // A plan's keys are strings; a user's slot is a number and a crossover's an id ('x1').
  const slotOf = (p) => (/^\d+$/.test(p) ? Number(p) : p);
  for (const [p, r] of Object.entries(plan.reads)) add(r.s, { k: 'slot', p: slotOf(p) });
  for (const [p, r] of Object.entries(plan.keys ?? {})) add(r.s, { k: 'slot', p: slotOf(p) });
  add(plan.out.s, { k: 'out' });
  for (const [id, terms] of Object.entries(plan.sums)) for (const r of terms) add(r.s, { k: 'sum', id });
  const memo = new Map();
  const after = (src) => {
    const key = nodeKey(src);
    if (memo.has(key)) return memo.get(key);
    memo.set(key, 0);
    let worst = 0;
    for (const c of consumers.get(key) ?? []) {
      let v = 0;
      if (c.k === 'slot') v = own(c.p) + after({ k: 'slot', p: c.p });
      else if (c.k === 'sum') v = after({ k: 'sum', id: c.id });
      worst = Math.max(worst, v);
    }
    memo.set(key, worst);
    return worst;
  };
  const last = Math.max(per?.length ?? 0, ...Object.keys(plan.reads).filter((p) => /^\d+$/.test(p)).map((p) => Number(p) + 1));
  const outArr = new Array(last + 1).fill(0);
  outArr[0] = own(0) + after({ k: 'in' });
  for (let p = 1; p < last; p++) outArr[p] = own(p) + after({ k: 'slot', p });
  return outArr;
}
