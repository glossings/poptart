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
 *                a Crossover, `rest` and `ap` (its other two outputs) and `key` ({ node, input })
 *   gainStage(k) the persistent controls for gain k: { level, panL, panR } nodes to connect from
 */
export function buildRouting(ctx, plan, { input, output, slotIO, gainStage }) {
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

  return {
    teardown() {
      for (const [from, param] of fed) { try { from.disconnect(param); } catch { /* already detached */ } }
      for (const node of made) { try { node.disconnect(); } catch { /* already detached */ } }
    },
  };
}
