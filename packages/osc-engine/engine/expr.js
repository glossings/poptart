'use strict';

// Param expressions ('/poptart/setParamExpr'). A `.param()` value that combines signals - audio
// from another track, modulators, polled values, constants - in a way no single modulator covers
// is sent as a tree and evaluated per sample by one synth per (track, slot, name). Its inputs are
// buses like every other driver's: each `in` leaf is fed by an ordinary param call on the leaf name
// "~i~name" (so an LFO, an envelope, a cc, a polled value all reach it through the code that already
// runs them), or, for a `source` leaf, by an audio route from that track or bus. The output drives
// the real control as an audio-rate envelope does: mapAudio onto a device, a control bus onto a
// plugin parameter or a channel control.
//
// One SynthDef per tree SHAPE and output kind, built by ../synthdef (exprDef). Constants are named
// controls (c0, c1, ... in walk order), so a tree that differs only in its numbers is a set on the
// running synth, never a rebuild. Ported from poptart.scd (see core.js for the conventions).

const synthdef = require('../synthdef');
const { sendDefs } = require('../server/defs');
const { Synth, Bus } = require('../server/objects');

const errorString = (err) => (err && err.message ? err.message : String(err));

// The one place an expression's def is made: swap the builder here.
function buildExprDef(tree, outKind, rates, warn) {
  return synthdef.exprDef(tree, { outKind, rates, warn });
}

function install(E) {
  const S = E.S;

  E.exprKey = (slot, name) => `slot${slot}_${name}`;
  E.exprsOf = (track) => (track.exprs ??= new Map());
  E.exprFeedsOf = (track) => (track.exprFeeds ??= new Map());

  // What drives input i of the expression on (slot, name): a control bus and an audio bus, -1 for
  // none - recorded whether or not the expression exists yet, since the leaf's modulator may land
  // first, and handed to the synth when it is there. An input reads the sum of the two (only one is
  // ever set), so a leaf can change from a polled value to an envelope without a rebuild.
  E.exprFeed = (track, slot, name, i, rate, bus) => {
    const feeds = E.exprFeedsOf(track);
    const fk = `${slot}|${name}|${i}`;
    const f = feeds.get(fk) ?? { kr: -1, ar: -1 };
    f[rate] = bus;
    feeds.set(fk, f);
    const e = E.exprsOf(track).get(E.exprKey(slot, name));
    if (e == null) return;
    const now = f.ar >= 0 ? 'ar' : 'kr';
    // Only an audio driver onto an input read at control rate needs the rebuild: one read at audio
    // rate reads a control driver as well, through its own input.
    if (now === 'ar' && (e.rates ?? [])[i] !== 'ar') {
      // The input is driven at the other rate now: the expression is rebuilt to read it.
      let key = null;
      for (const [k, t] of E.tracks) if (t === track) { key = k; break; }
      if (key != null) {
        E.exprRun(key, slot, name, async () => {
          const cur = E.exprsOf(track).get(E.exprKey(slot, name));
          if (cur != null) await E.installExpr(key, track, slot, name, cur.json);
        });
      }
    } else {
      e.synth?.set(`k${i}`, f.kr, `a${i}`, f.ar);
    }
  };

  E.exprFeedArgs = (track, slot, name, inputs) => {
    const feeds = E.exprFeedsOf(track);
    return inputs.flatMap((input) => {
      const f = feeds.get(`${slot}|${name}|${input.i}`) ?? { kr: -1, ar: -1 };
      return [`k${input.i}`, f.kr, `a${input.i}`, f.ar];
    });
  };

  E.exprShape = synthdef.exprShape;
  E.exprConsts = synthdef.exprConsts;
  E.exprInputs = synthdef.exprInputs;

  // Installs (or updates) an expression. It may wait for the track, the slot's plugin and a
  // SynthDef, and is also what a re-opened plugin calls to get its expression back.
  E.installExpr = async (key, track, slot, name, json) => {
    const tree = JSON.parse(json);
    const target = slot === -1 ? E.paramTarget(track, slot, name) : await E.awaitTarget(track, slot, name, 'setParamExpr');
    if (target == null) return;
    const exprs = E.exprsOf(track);
    const k = E.exprKey(slot, name);
    const feeds = E.exprFeedsOf(track);
    // What drives each input, which decides the rate it is read at: audio where the tree says so or
    // where an audio driver is already on it.
    const rates = synthdef.exprRates(tree, (i) => {
      const f = feeds.get(`${slot}|${name}|${i}`);
      return f != null && f.ar >= 0;
    });
    let outKind;
    // A channel control with audio in its expression is driven per sample, as the browser drives
    // it (poptart.scd's chanIn): 'channelAr', an audio bus. Otherwise a control bus.
    if (target.kind === 'channel') outKind = target.audio && rates.includes('ar') ? 'channelAr' : 'channel';
    else if (target.audio) outKind = 'device';
    else outKind = 'plugin';
    const shape = `${E.exprShape(tree)}|${outKind}|${rates.join(',')}`;
    const consts = E.exprConsts(tree);
    const inputs = E.exprInputs(tree);
    const constArgs = consts.flatMap((v, j) => [`c${j}`, v]);
    const existing = exprs.get(k);
    let entry = null;
    if (existing != null && existing.shape === shape) {
      // Only numbers (or nothing) changed: in place, no rebuild.
      if (constArgs.length) existing.synth.set(...constArgs);
      existing.json = json;
      entry = existing;
    } else {
      let defName = E.exprDefs.get(shape);
      if (defName == null) {
        const made = buildExprDef(tree, outKind, rates, (t) => E.warn(`poptart: ${t}`));
        // The def has to be on the server before the synth is made of it.
        await sendDefs(S, [made]);
        E.defs.add(made.name, made.meta);
        E.exprDefs.set(shape, made.name);
        defName = made.name;
      }
      // The track may have gone (or the expression been cleared) while the def was built.
      if (E.tracks.get(key) === track) {
        const out = outKind === 'device' ? Bus.audio(S, 2) : outKind === 'channelAr' ? Bus.audio(S, 1) : Bus.control(S, 1);
        // Before the chain: after every modulator feeding it (they go at the head of the group) and
        // before the device that reads it.
        const synth = Synth.new(S, defName, ['out', out.index, ...constArgs, ...E.exprFeedArgs(track, slot, name, inputs)],
          track.chain, 'addBefore');
        E.nodeOwns?.(synth.nodeID, `the expression on '${name}'`);
        // The control it drives was polled until now: that ramp goes.
        E.dropRamp(key, track, k);
        // A plugin parameter goes back where it was when the expression comes off. Asked BEFORE the
        // map below, so the server answers with the value it had until now.
        let resting;
        if (outKind === 'plugin' && existing == null) {
          resting = {};
          track.controllers.get(slot).get(target.index, (v) => { resting.value = v; });
        } else {
          resting = existing?.resting ?? null;
        }
        // A channel leaving the sample rate (its audio input gone) comes off the audio bus it was
        // on; the control bus below takes over.
        if (outKind === 'channel' && existing?.outKind === 'channelAr') E.setChanAr(track, name, -1);
        if (outKind === 'device' || outKind === 'channelAr') target.mapAudio(out, 1, 0); else target.map(out);
        if (existing != null) {
          E.freeModulatorLater(key, track.group, existing.synth, existing.out);
          E.exprDefDone(existing.def);
        }
        E.exprDefUse.set(defName, (E.exprDefUse.get(defName) ?? 0) + 1);
        entry = {
          synth, out, shape, outKind, json, slot, name, def: defName, rates,
          index: target.index, sources: existing?.sources ?? new Map(), resting,
        };
        exprs.set(k, entry);
      }
    }
    if (entry == null) return;
    // Inputs read only under a .smooth() take polled values as steps: their ramps, made before or
    // after this, go to zero time; the rest keep the usual glide.
    entry.stepped = new Set(inputs.filter((x) => x.step).map((x) => x.i));
    for (const input of inputs) {
      track.ramps?.get(`slot${slot}_~${input.i}~${name}`)?.synth.set('time', entry.stepped.has(input.i) ? 0 : E.LEAF_RAMP_SEC ?? 0.03);
    }
    const wanted = new Map();
    // Even an unchanged entry re-maps: a re-opened plugin has lost its mappings.
    if (entry === existing) {
      if (outKind === 'device' || outKind === 'channelAr') target.mapAudio(entry.out, 1, 0); else target.map(entry.out);
    }
    // Source inputs are audio routes onto the leaf; one whose source changed is re-wired.
    for (const input of inputs) if (input.source != null) wanted.set(input.i, input.source);
    for (const i of [...entry.sources.keys()]) {
      if (wanted.get(i) !== entry.sources.get(i)) {
        E.unwireParamRoute(key, slot, `~${i}~${name}`);
        entry.sources.delete(i);
      }
    }
    for (const [i, src] of wanted) {
      if (entry.sources.get(i) == null) {
        entry.sources.set(i, src);
        E.wireParamRoute(key, slot, `~${i}~${name}`, src, 1, 0);
      }
    }
  };

  E.clearExpr = (key, track, slot, name) => {
    const exprs = E.exprsOf(track);
    const k = E.exprKey(slot, name);
    const e = exprs.get(k);
    exprs.delete(k);
    if (e == null) return;
    const target = E.paramTarget(track, slot, name, slot >= 0 ? e.index : null);
    for (const i of e.sources.keys()) E.unwireParamRoute(key, slot, `~${i}~${name}`);
    if (target != null) {
      if (e.outKind === 'device' || e.outKind === 'channelAr') {
        target.unmapAudio?.();
      } else {
        target.unmap();
        const v = (e.resting ?? {}).value;
        if (v != null) track.controllers.get(slot)?.set(e.index, v);
      }
    }
    const feeds = E.exprFeedsOf(track);
    for (const fk of [...feeds.keys()]) if (fk.startsWith(`${slot}|${name}|`)) feeds.delete(fk);
    E.freeModulatorLater(key, track.group, e.synth, e.out);
    E.exprDefDone(e.def);
  };

  // One expression less on a def; with none left, the def is freed on the server (after the synth
  // that used it has had time to go) and forgotten here, so a long set that tries a hundred
  // expressions does not keep a hundred defs.
  E.exprDefDone = (defName) => {
    if (defName == null) return;
    const n = (E.exprDefUse.get(defName) ?? 1) - 1;
    if (n > 0) {
      E.exprDefUse.set(defName, n);
      return;
    }
    E.exprDefUse.delete(defName);
    for (const [shape, d] of [...E.exprDefs]) if (d === defName) E.exprDefs.delete(shape);
    E.freeDefsLater([defName]);
  };

  // Defs made for one use, freed on the server once nothing runs them. A def's name follows its
  // shape, so one wanted again inside the wait is in use again and stays.
  E.freeDefsLater = (names) => {
    E.sched(2, () => {
      for (const n of names) {
        if (E.exprDefUse.has(n) || [...E.exprDefs.values()].includes(n)) continue;
        S.send(['/d_free', n]);
        E.defs.remove(n);
      }
      return null;
    });
  };

  // A plugin or device opened into a slot starts with its mappings cleared and its controls at their
  // defaults: each expression aimed at the slot goes back on (rebuilt if the slot changed between a
  // plugin and a device, which changes how it is read).
  E.reassertExprs = (key, track, slot) => {
    for (const e of [...E.exprsOf(track).values()].filter((x) => x.slot === slot)) {
      E.exprRun(key, slot, e.name, async () => {
        // Still the same expression: it may have been cleared or replaced while queued.
        const now = E.exprsOf(track).get(E.exprKey(slot, e.name));
        if (now != null) await E.installExpr(key, track, slot, e.name, now.json);
      });
    }
  };

  // Installs and clears for one control run one at a time, in arrival order: an install can wait on
  // a SynthDef build, and a constants-only update or a clear sent meanwhile has to land after it,
  // not race it. A failure is said and does not stall the ones behind.
  E.exprRun = (key, slot, name, job) => {
    const qk = `${key}|${slot}|${name}`;
    const go = () => {
      E.fork(async () => {
        try {
          await job();
        } catch (err) {
          E.warn(`poptart: param expression on '${name}': ${errorString(err)}`);
        }
        const q = E.exprQueue.get(qk).slice(1);
        if (q.length === 0) E.exprQueue.delete(qk);
        else { E.exprQueue.set(qk, q); q[0](); }
      });
    };
    const q = [...(E.exprQueue.get(qk) ?? []), go];
    E.exprQueue.set(qk, q);
    if (q.length === 1) go();
  };

  E.on('/poptart/setParamExpr', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(Number(msg[2]));
    const name = String(msg[3]);
    const json = String(msg[4]);
    E.exprRun(key, slot, name, async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) E.warn(`poptart: setParamExpr: no track ${key}`);
      else await E.installExpr(key, track, slot, name, json);
    });
  });

  // [trackId, slot, name]: the expression comes off, and the control goes back to its own value.
  E.on('/poptart/clearParamExpr', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(Number(msg[2]));
    const name = String(msg[3]);
    E.exprRun(key, slot, name, async () => {
      const track = E.tracks.get(key);
      if (E.isTrack(track)) E.clearExpr(key, track, slot, name);
    });
  });
}

module.exports = { install, buildExprDef };
