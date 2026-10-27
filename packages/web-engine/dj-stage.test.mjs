// The DJ desk's half of the engine: every track's DJ stage, the headphone cue and its routes,
// the deck meters, and the FX unit's insert - wired against the stand-in graph (see
// fake-context.mjs). What it sounds like is checked in a browser; what is connected to what, and
// what a control lands on, is checked here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { DJ_NEUTRAL, SUPPORTED_CHANNELS } from './src/engine/track.mjs';
import { bandShare } from './src/engine/desk-audio.mjs';

function makeEngine({ channels = 2 } = {}) {
  const ctx = new FakeAudioContext();
  ctx.destination.maxChannelCount = channels;
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    routeWaitMs: 1,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

test('every control of the DJ stage is a channel control here, as it is on the desktop', () => {
  for (const name of [...Object.keys(DJ_NEUTRAL), 'mdeck']) assert.ok(SUPPORTED_CHANNELS.includes(name), name);
  const { engine, warnings } = makeEngine();
  engine.createTrack('t');
  for (const [name, value] of Object.entries(DJ_NEUTRAL)) engine.setParam('t', -1, name, value, 0);
  assert.deepEqual(warnings, []);
});

test('a track nobody mixes carries no EQ or filter at all, and plays straight through', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  assert.equal(track.djEq, null);
  assert.equal(track.djFilter, null);
  assert.ok(track.panner.reaches(engine.master), 'the strip still reaches the master');
  // Setting the neutral values explicitly builds nothing either.
  engine.setParam('t', -1, 'eqlo', 1, 0);
  engine.setParam('t', -1, 'djf', 0, 0);
  assert.equal(track.djEq, null);
  assert.equal(track.djFilter, null);
});

test('moving a band builds the isolator and crossfades it in; back at neutral it crossfades out', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'eqlo', 1, 0); // the first value of a control steps; this one is neutral
  engine.setParam('t', -1, 'eqlo', 0, 0);
  const eq = track.djEq;
  assert.ok(eq, 'built on the first move away from neutral');
  // Twelve Butterworths: a Linkwitz-Riley pair on each side of each crossover, and the low band's
  // all-pass pair.
  const biquads = eq.nodes.filter((n) => n.kind === 'biquad');
  assert.equal(biquads.length, 12);
  assert.ok(biquads.every((b) => Math.abs(b.Q.value - 20 * Math.log10(Math.SQRT1_2)) < 1e-9), 'Butterworth Q, in decibels');
  assert.deepEqual([...new Set(biquads.map((b) => b.frequency.value))].sort((a, b) => a - b), [250, 2500]);
  assert.ok(eq.lo.gain.landedOn(0), 'the low band is killed');
  assert.ok(eq.wet.gain.landedOn(1) && eq.dry.gain.landedOn(0), 'the isolator is in the path');
  assert.ok(track.djTrim.reaches(eq.lo) && eq.wet.reaches(track.djLive));
  engine.setParam('t', -1, 'eqlo', 1, 0);
  assert.ok(eq.wet.gain.rampedTo(0) && eq.dry.gain.rampedTo(1), 'neutral again: out of the path');
});

test('the filter sweeps a low-pass one way and a high-pass the other, with its resonance apart', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'djf', 0, 0);
  engine.setParam('t', -1, 'djf', -1, 0);
  const f = track.djFilter;
  assert.ok(f);
  const lastValue = (param) => param.calls.filter((c) => c.kind !== 'hold' && c.kind !== 'cancel').at(-1)?.value;
  assert.equal(Math.round(lastValue(f.lp.frequency)), 20, 'all the way down closes to 20 Hz');
  assert.equal(Math.round(lastValue(f.hp.frequency)), 20, 'the high-pass stays open');
  engine.setParam('t', -1, 'djf', 1, 0);
  assert.equal(Math.round(lastValue(f.lp.frequency)), 18000);
  assert.equal(Math.round(lastValue(f.hp.frequency)), 18000);
  // Resonance: rq 1 - 0.62 x res, as a Web Audio Q in decibels. None is a plain two-pole (0 dB).
  assert.equal(lastValue(f.lp.Q), 0);
  engine.setParam('t', -1, 'djres', 1, 0);
  assert.ok(Math.abs(lastValue(f.lp.Q) - -20 * Math.log10(0.38)) < 1e-9);
  assert.ok(f.wet.gain.landedOn(1));
  engine.setParam('t', -1, 'djf', 0, 0);
  assert.ok(f.wet.gain.rampedTo(0) && f.dry.gain.rampedTo(1), 'the center detent takes it out');
});

test('the fader gates the direct path and the sends; the deck gain only the direct path', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'fader', 0, 0);
  engine.setParam('t', -1, 'deck', 0.5, 0);
  assert.ok(track.faderGain.gain.landedOn(0));
  assert.ok(track.sendFader.gain.landedOn(0), 'a gated stem leaves whatever it was feeding too');
  assert.ok(track.deckGain.gain.landedOn(0.5));
  assert.ok(!track.sendFader.reaches(track.deckGain), 'a crossfade is applied once, at the end of a path');
  engine.setBusSends('t', [{ name: 'verb', amount: 1 }]);
  assert.ok(track.sendFader.reaches(engine.buses.get('verb')), 'the sends leave after the fader');
});

test('the cue sends the stage itself, pre-fader; a monitored track goes to it in full and nowhere else', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  assert.ok(track.cueGain.reaches(engine.desk.cueBus));
  engine.setParam('t', -1, 'fader', 0, 0);
  engine.setParam('t', -1, 'cue', 1, 0);
  assert.ok(track.cueGain.gain.landedOn(1), 'heard in the headphones with the fader down');
  engine.setParam('t', -1, 'cue', 0, 0);
  engine.setParam('t', -1, 'mon', 1, 0);
  assert.ok(track.cueGain.gain.landedOn(1), 'a monitored track is cued whatever its cue says');
  assert.ok(track.monGate.gain.landedOn(0) && track.sendMain.gain.landedOn(0), 'and the room hears none of it');
});

test('a track reports to the deck meter it is told to, and a group member to none', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'mdeck', 1, 0);
  assert.ok(track.djLive.reaches(engine.desk.deckMeters[1]));
  assert.ok(!track.djLive.reaches(engine.desk.deckMeters[0]));
  engine.setParam('t', -1, 'mdeck', -1, 0);
  assert.ok(!track.djLive.reaches(engine.desk.deckMeters[1]));
});

test('the FX unit is an insert: what the send opens, the direct path closes', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setFxSend('t', '#fxa', 1);
  assert.ok(track.fx.send.gain.rampedTo(1));
  assert.ok(track.fxDirect.gain.rampedTo(0));
  assert.ok(track.fx.fader.reaches(engine.buses.get('#fxa')));
  assert.ok(!track.fx.fader.reaches(track.deckGain), 'the return wears the crossfader, not the send');
  engine.setParam('t', -1, 'fader', 0, 0);
  assert.ok(track.fx.fader.gain.landedOn(0), 'a gated stem leaves the FX feed with the mix');
  engine.setFxSend('t', '', 0);
  assert.ok(track.fxDirect.gain.rampedTo(1));
});

test('the headphone knobs: mix crosses from the cue to the main mix, level is squared', () => {
  const { engine } = makeEngine();
  const d = engine.desk;
  engine.setHeadphones(1, 0);
  assert.ok(d.cueAmt.gain.rampedTo(1) && d.mainAmt.gain.rampedTo(0), 'mix 0: the cue only');
  engine.setHeadphones(0.5, 0.5);
  assert.ok(d.cueAmt.gain.rampedTo(1) && d.mainAmt.gain.rampedTo(1), 'centered: both at full');
  assert.ok(d.hpLevel.gain.rampedTo(0.25));
  engine.setHeadphones(1, 1);
  assert.ok(d.cueAmt.gain.rampedTo(0) && d.mainAmt.gain.rampedTo(1), 'mix 1: the main mix only');
});

test('a cue on a pair of this output plays there, and no pattern can reach that pair', () => {
  const { engine, ctx } = makeEngine({ channels: 4 });
  engine.createTrack('t');
  engine.setParam('t', -1, 'out', 2, 0); // .o(2) asks for channels 3/4
  engine.setCueRoute({ pair: 1 });
  assert.equal(engine.outputChannels, 4, 'the output is widened to the pair');
  assert.deepEqual(engine.cueRoute(), { pair: 1 });
  const merge = engine.desk._routeNodes.find((n) => n.kind === 'merger');
  assert.ok(merge.reaches(ctx.destination));
  assert.deepEqual(engine.desk._routeNodes.find((n) => n.kind === 'splitter').links.map((l) => l.input), [2, 3]);
  // With the cue on 3/4 there is one pair left for the room, and `.o(2)` wraps onto it.
  assert.equal(engine.tracks.get('t')._outPair, 0);
  engine.setCueRoute(null);
  assert.equal(engine.cueRoute(), null);
  assert.equal(engine.tracks.get('t')._outPair, 1, 'the pair is the room\'s again');
});

test('a cue to another device is a node the host carries away', () => {
  const { engine, ctx } = makeEngine();
  const away = ctx.createGain();
  engine.setCueRoute({ node: away });
  assert.ok(engine.desk.out.reaches(away));
  assert.deepEqual(engine.cueRoute(), { device: true });
});

test('a pair the output does not have is refused, not silently dropped', () => {
  const { engine } = makeEngine({ channels: 2 });
  assert.throws(() => engine.setCueRoute({ pair: 1 }), /no channels 3\/4/);
});

test('the deck meters exist only while somebody is looking, and read level and band balance', () => {
  const { engine, ctx } = makeEngine();
  assert.equal(engine.deckLevels(), null);
  engine.deckMeters(true);
  for (const a of ctx.created.filter((n) => n.kind === 'analyser')) a.feed(0.5, -20);
  const read = engine.deckLevels();
  assert.equal(read.a.p, 0.5);
  assert.equal(read.a.r, 0.5);
  assert.equal(read.a.b.length, 3);
  assert.ok(read.m);
  engine.deckMeters(false);
  assert.equal(engine.deckLevels(), null);
  assert.deepEqual(bandShare([0, 0, 0]), [0, 1, 0], 'silence reads as a neutral balance');
  assert.deepEqual(bandShare([1, 1, 2]), [0.25, 0.25, 0.5]);
});
