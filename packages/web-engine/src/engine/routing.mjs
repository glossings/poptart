// A track's chain as branches: the node graph for a routing plan (pattern-core's route.mjs).
//
// The plan says what each effect slot reads, what the channel strip reads, and which sums add up
// which signals at what level and pan. All of it is built here out of stock nodes, on ONE track,
// so every device in every branch is a slot of this track like any other - its notes, its
// modulators and its panel are where they always are. A .bands() is no exception: each of its
// crossovers is a Crossover device in a slot (devices/crossover.mjs), and the plan reads its three
// outputs and feeds its key like any other slot's.
//
// Levels and pans are channel controls (rl<k>, rp<k>), so each is a constant source the track
// keeps for its whole life, as it keeps its wet controls: a modulator or an expression connected
// to one stays connected however often the branches are rebuilt around it.

const srcKey = (s) => (s.k === 'in' ? 'in' : s.k === 'sum' ? `m${s.id}` : `${s.k}${s.p}`);

/**
 * Builds the graph for `plan` and returns what it made, so the next build can take it down.
 *
 *   input        the chain input (the `gain` control's node)
 *   output       where the strip starts (the `postgain` node)
 *   slotIO(p)    the slot's ends, built fresh for this wiring: { input: [nodes], output } and, for
 *                a Crossover, `rest` and `ap` (its other two outputs) and `key` ({ node, input });
 *                for a device with a feedback loop, `loop` (its second output) and `ret` ({ node,
 *                input }, where the loop's chain comes back in)
 *   gainStage(k) the persistent controls for gain k: { level, panL, panR } nodes to connect from
 *   sendPoint(i) where .bus() send i, written inside the chain, leaves from: a node the track
 *                keeps, which this wiring feeds with what the plan says the send taps
 */
export function buildRouting(ctx, plan, { input, output, slotIO, gainStage, sendPoint = null }) {
  const made = [];       // nodes this build created, disconnected wholesale by the next one
  const fed = [];        // [persistent node, AudioParam] links into this build's nodes
  const make = (node) => { made.push(node); return node; };
  const gainNode = (v = 1) => { const g = make(ctx.createGain()); g.gain.value = v; return g; };
  const memo = new Map();
  const slots = new Map(); // slot -> its ends, wired once

  // A signal at a gain: the level, then each side by the pan law - the track strip's own order
  // and law, so a branch panned hard right plays its right channel at +3 dB as a track does.
  const atGain = (from, k) => {
    if (!k) return from;
    const ctl = gainStage(k);
    const level = gainNode(0);
    level.channelCount = 2;
    level.channelCountMode = 'explicit';
    level.channelInterpretation = 'speakers';
    ctl.level.connect(level.gain);
    fed.push([ctl.level, level.gain]);
    const split = make(ctx.createChannelSplitter(2));
    const sides = [gainNode(0), gainNode(0)];
    const merge = make(ctx.createChannelMerger(2));
    from.connect(level);
    level.connect(split);
    [ctl.panL, ctl.panR].forEach((law, side) => {
      law.connect(sides[side].gain);
      fed.push([law, sides[side].gain]);
      split.connect(sides[side], side);
      sides[side].connect(merge, 0, side);
    });
    return merge;
  };

  const refNode = (ref) => atGain(srcNode(ref.s), ref.g);

  // A slot's ends, with what it reads (and, for a crossover, its key) wired in on first use.
  const slotOf = (p) => {
    if (slots.has(p)) return slots.get(p);
    const io = slotIO(p);
    slots.set(p, io);
    const read = plan.reads[p];
    const from = read ? refNode(read) : input;
    for (const into of io.input) from.connect(into);
    const key = plan.keys?.[p];
    if (key && io.key) refNode(key).connect(io.key.node, 0, io.key.input);
    return io;
  };

  const srcNode = (s) => {
    const key = srcKey(s);
    if (memo.has(key)) return memo.get(key);
    let node;
    if (s.k === 'in') node = input;
    else if (s.k === 'slot') node = slotOf(s.p).output;
    // A crossover's other two outputs - silence from a slot that is not one, or not loaded yet.
    else if (s.k === 'rest') node = slotOf(s.p).rest ?? gainNode(0);
    else if (s.k === 'ap') node = slotOf(s.p).ap ?? gainNode(0);
    // A looped device's repeats, on their way into its loop's chain.
    else if (s.k === 'loop') node = slotOf(s.p).loop ?? gainNode(0);
    else if (s.k === 'sum') {
      node = gainNode(1);
      memo.set(key, node);
      for (const term of plan.sums[s.id] ?? []) refNode(term).connect(node);
      return node;
    } else node = gainNode(0);
    memo.set(key, node);
    return node;
  };

  refNode(plan.out).connect(output);
  // The sends written inside the chain, each through a node of this build so the next one can
  // take the feed away without touching the point itself.
  for (const [i, ref] of Object.entries(plan.sends ?? {})) {
    const point = sendPoint?.(Number(i));
    if (!point) continue;
    const feed = gainNode(1);
    refNode(ref).connect(feed);
    feed.connect(point);
  }

  // Each loop's chain back into its device. The edge closes a cycle, so it goes through a delay of
  // 0, which every browser holds to one render quantum (see route-graph.mjs) - the block the device
  // is told about (see loopLatencies).
  for (const [p, ref] of Object.entries(plan.returns ?? {})) {
    const io = slotOf(/^\d+$/.test(p) ? Number(p) : p);
    if (!io.ret) continue;
    const back = make(ctx.createDelay(0.05));
    back.delayTime.value = 0;
    refNode(ref).connect(back);
    back.connect(io.ret.node, 0, io.ret.input);
  }

  return {
    teardown() {
      for (const [from, param] of fed) { try { from.disconnect(param); } catch { /* already detached */ } }
      for (const node of made) { try { node.disconnect(); } catch { /* already detached */ } }
    },
  };
}

/**
 * How late the chain in each looped device's feedback loop is, from its devices alone, by slot:
 * the longest way from the device's loop output to what its return reads, each device on the way
 * adding `latencyOf(slot)` seconds. The track adds the render quantum the return is held to. A
 * device inside the loop with a loop of its own counts for its input only: its own loop is its
 * own to take off. The desktop's route-desktop.js works it out the same way.
 */
export function loopLatencies(plan, latencyOf) {
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
        for (const r of [plan.reads?.[s.p], plan.keys?.[s.p]]) if (r) v = Math.max(v, from(r.s));
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
