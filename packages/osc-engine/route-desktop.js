'use strict';

// A track's chain as the desktop runs it: a row of nodes in one group, joined by private buses
// (see routeApply and sharedTrackDef in sc/poptart.scd), laid out from a routing plan
// (pattern-core's route.mjs - the branches of .split(), the bands of .bands()) or, with none, the
// plain line of the track's effects.
//
//   steps   in the order the audio runs, each with the buses it reads and writes:
//             { k: 'fx', slot, in, out[, loop] }                    an effect's own node; `loop`
//                                                                   is where a looped Delay
//                                                                   sends its repeats
//             { k: 'ret', slot, in }                                what a looped Delay's return
//                                                                   reads, a block late
//             { k: 'xover', id, xo, in, key, out, rest, ap }        a .bands() crossover
//             { k: 'term', in, out, g }                             a signal into a sum or a
//                                                                   reader, at route gain g
//                                                                   (0 = unity)
//             { k: 'send', i, in }                                  what .bus() send i, written
//                                                                   inside the chain, taps
//   out     the bus the strip reads
//   buses   every private bus the steps name, by id, and its channel count; 'chain' is the one
//           the head writes, which the track already has
//
// Every read is of something earlier in `steps`, so the chain is one pass through a block with no
// delay anywhere - except a `ret`, which closes a loop through a Delay's chain and is read the block
// before (InFeedback). Its terms come last, after everything they read. A sum is a bus its terms all add into, read once they all have; a read at a gain
// is a term into a bus of the reader's own. Nothing here is a node that holds a device but the
// effects and the crossovers, and those are named by slot and id, so the engine keeps them across
// any change of layout. A send step holds nothing either: it says which bus the track's tap for
// that send reads instead of the strip's output (see stripTap), for as long as this layout stands.

const CHAIN = 'chain';

const srcKey = (s) => (s.k === 'in' ? 'in' : s.k === 'sum' ? `m${s.id}` : `${s.k}${s.p}`);

/** The bus a source is written on. */
function busOf(s) {
  if (s.k === 'in') return CHAIN;
  if (s.k === 'sum') return `m:${s.id}`;
  if (s.k === 'slot') return `o:${s.p}`;
  if (s.k === 'loop') return `l:${s.p}`;
  return `${s.k === 'rest' ? 'r' : 'a'}:${s.p}`;
}

/** The plain line of `count` effects: each reading the one before it. */
function linearChain(count) {
  const steps = [];
  const buses = {};
  let prev = CHAIN;
  for (let slot = 1; slot <= count; slot++) {
    const out = `o:${slot}`;
    buses[out] = 2;
    steps.push({ k: 'fx', slot, in: prev, out });
    prev = out;
  }
  return { steps, out: prev, buses, warnings: [] };
}

/**
 * The desktop chain for `plan`, or the plain line of `count` effects where there is none.
 * `crossover` is the Crossover device's control list as loadDevice takes it, passed along for the
 * engine to open each crossover with.
 */
function desktopRouting(plan, { count = 0, crossover = null } = {}) {
  if (!plan || typeof plan !== 'object' || !plan.reads || !plan.out) {
    return { ...linearChain(Math.max(0, Number(count) || 0)), ...(crossover ? { crossover } : {}) };
  }
  const steps = [];
  const buses = {};
  const warnings = [];
  const sums = plan.sums ?? {};
  const bus = (id) => { if (id !== CHAIN) buses[id] = 2; return id; };
  const made = new Set(); // sums whose terms are already in `steps`

  // A sum's terms, each a term node into the sum's bus - after its own inner sums.
  const makeSum = (id) => {
    if (made.has(id)) return;
    made.add(id);
    const terms = sums[id];
    if (!terms) {
      warnings.push(`a branch reads a sum the plan does not have, so it is silent (sum ${id}).`);
      return;
    }
    for (const t of terms) if (t.s.k === 'sum') makeSum(t.s.id);
    for (const t of terms) steps.push({ k: 'term', in: bus(busOf(t.s)), out: bus(`m:${id}`), g: t.g || 0 });
  };
  // What a reader reads: the source's bus, or - for a sum, or anything at a gain - the bus made for
  // it, its terms put in first.
  let nextRead = 0;
  const readOf = (r) => {
    if (!r) return 'none';
    if (r.s.k === 'sum') makeSum(r.s.id);
    const src = bus(busOf(r.s));
    if (!r.g) return src;
    const own = bus(`g:${nextRead++}`);
    steps.push({ k: 'term', in: src, out: own, g: r.g });
    return own;
  };

  const order = Array.isArray(plan.order)
    ? plan.order
    : Object.keys(plan.reads).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (const p of order) {
    const read = plan.reads[p];
    if (typeof p === 'string' && p.startsWith('x')) {
      const key = plan.keys?.[p];
      steps.push({
        k: 'xover',
        id: p,
        xo: Number(p.slice(1)),
        in: readOf(read),
        key: key ? readOf(key) : 'none',
        out: bus(`o:${p}`),
        rest: bus(`r:${p}`),
        ap: bus(`a:${p}`),
      });
    } else {
      const looped = plan.returns?.[p] != null;
      steps.push({ k: 'fx', slot: Number(p), in: readOf(read), out: bus(`o:${p}`), ...(looped ? { loop: bus(`l:${p}`) } : {}) });
    }
  }
  const out = readOf(plan.out);
  for (const [i, r] of Object.entries(plan.sends ?? {})) steps.push({ k: 'send', i: Number(i), in: readOf(r) });
  for (const [p, r] of Object.entries(plan.returns ?? {})) steps.push({ k: 'ret', slot: Number(p), in: readOf(r) });
  return { steps, out, buses, warnings, ...(crossover ? { crossover } : {}) };
}

/**
 * How late the chain in each looped device's feedback loop is, from its devices alone, by slot:
 * the longest way from the device's loop output to what its return reads, each device on the way
 * adding `latencyOf(slot)` seconds. The engine adds its own block on top (the return is read a
 * block late). A device inside the loop that has a loop of its own counts for its input only: its
 * own loop is its own to take off.
 */
function loopLatencies(plan, latencyOf) {
  const out = {};
  if (!plan?.returns) return out;
  const slotOf = (p) => (/^\d+$/.test(String(p)) ? Number(p) : p);
  const own = (p) => { const v = Number(latencyOf(slotOf(p))); return v > 0 ? v : 0; };
  for (const p of Object.keys(plan.returns)) {
    const memo = new Map();
    const from = (s) => {
      const key = srcKey(s);
      if (memo.has(key)) return memo.get(key);
      memo.set(key, -Infinity);
      let v = -Infinity;
      if (s.k === 'loop' && String(s.p) === String(p)) v = 0;
      else if (s.k === 'sum') for (const t of plan.sums?.[s.id] ?? []) v = Math.max(v, from(t.s));
      else if (s.k !== 'in') {
        const reads = [plan.reads?.[s.p], plan.keys?.[s.p]].filter(Boolean);
        for (const r of reads) v = Math.max(v, from(r.s));
        if (v > -Infinity) v += own(s.p);
      }
      memo.set(key, v);
      return v;
    };
    const v = from(plan.returns[p].s);
    out[slotOf(p)] = v > 0 ? v : 0;
  }
  return out;
}

module.exports = { desktopRouting, linearChain, srcKey, loopLatencies };
