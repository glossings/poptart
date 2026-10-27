// The DJ desk in the page (public/web/desk.mjs): the desktop's desk ported onto the browser's
// engine, driven here through its routes against the stand-in audio graph. The timing it is
// built on - every song event sent a latency early, the model kept in heard time - is what most of
// these check; how it sounds is checked in a browser (see the report's checklist).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { createEvaluator } from './public/web/evaluate.mjs';
import { createBlockEvaluator } from './public/web/block-eval.mjs';
import { createDesk, DJ_NEUTRAL, SONG_KEYS } from './public/web/desk.mjs';
import { memoryStore } from './public/web/kv.mjs';

const require = createRequire(import.meta.url);
const songSync = require('./song-sync.js');
const linkSync = require('./link-sync.js');

const SR = 48000;
const rigs = new Set();
after(() => { for (const rig of rigs) rig.close(); });

/** A song source that hands out silent songs with the facts a test asks for. */
function fakeSongs(facts) {
  return {
    loads: [],
    async load(path, opts = {}) {
      this.loads.push({ path, ...opts });
      const f = facts[path] ?? {};
      const frames = Math.round((f.seconds ?? 60) * SR);
      return {
        planes: [new Int16Array(16), new Int16Array(16)],
        frames,
        sampleRate: SR,
        channels: 2,
        title: path.split('/').pop(),
        tags: null,
        wave: Promise.resolve({ seconds: frames / SR, detail: { perSec: 75, peaks: [], rms: [], bands: [] }, overview: { peaks: [], rms: [], bands: [] } }),
        facts: Promise.resolve({ bpm: f.bpm ?? null, bpmConfidence: 1, anchorSec: f.anchorSec ?? 0, gridConfidence: 1, key: f.key ?? null, keyConfidence: 1, onsets: [0.5, 1], bpmHint: opts.bpmHint ?? null }),
      };
    },
    async reanalyze() { return null; },
    anchors: new Map(),
    anchorOf(p) { return this.anchors.get(p) ?? null; },
    rememberAnchor(p, s) { if (s == null) this.anchors.delete(p); else this.anchors.set(p, s); },
  };
}

/** Web MIDI as the desk sees it: an output that records what it is sent. */
function fakeMidi() {
  return {
    available: true,
    enabled: true,
    sent: [],
    port: null,
    async enable() {},
    async outputs() { return ['Pad Controller']; },
    async setFeedback(name) { this.port = name; return { active: name ? 'Pad Controller' : null }; },
    feedback(messages) { this.sent.push(...messages); },
  };
}

function makeRig(facts = {}) {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  ctx.currentTime = 10;
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog) });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });
  const songs = fakeSongs(facts);
  const store = memoryStore();
  const midi = fakeMidi();
  const sets = [];
  const desk = createDesk({
    patternCore, engine, transport, songSync, linkSync, store, songs, midi,
    writeSet: async (set, ended) => { sets.push({ entries: set.entries.length, ended: !!ended }); },
    blockEvaluator: (builders) => createBlockEvaluator(patternCore, { hostBuilders: builders }),
  });
  const evaluator = createEvaluator({ patternCore, engine, transport, desk });
  desk.attach(evaluator);
  const call = (key, body = {}, query = '') => desk.routes[key](body, new URLSearchParams(query));
  const rig = {
    ctx, engine, transport, desk, evaluator, songs, store, call, midi, sets,
    // A playing song holds a timer for its end; clearing the decks lets them go.
    close() {
      for (const d of ['a', 'b']) call('POST /api/mix/clear', { deck: d });
      for (const s of evaluator.schedulers.values()) s.stop();
      call('POST /api/mix/eject'); // the FX unit's own clocks, like leaving the desk
      call('POST /api/mix/dj', { on: false });
      transport.rampCps(transport.cps); // ends a tempo ramp eject began: the fake clock never would
    },
  };
  rigs.add(rig);
  return rig;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const playerMessages = (rig, deck) => rig.engine.songs.get(rig.evaluator.trackIds.get(SONG_KEYS[deck])).node.messages;
const LAT = 0.12;

test('a song loads onto its deck\'s own track, born wearing the desk', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 128, key: 'Am', seconds: 90 } });
  await rig.call('POST /api/mix/dj', { on: true });
  await rig.call('POST /api/mix/set', { name: 'xf', value: -1 });
  const res = await rig.call('POST /api/song/load', { deck: 'b', path: '/music/a.wav' });
  assert.equal(res.key, 'b:#song');
  assert.equal(res.duration, 90);
  const track = rig.engine.tracks.get(rig.evaluator.trackIds.get('b:#song'));
  assert.ok(track.deckGain.gain.landedOn(0), 'a deck the crossfader has closed arrives silent');
  assert.ok(playerMessages(rig, 'b').some((m) => m.kind === 'load'));
  await settle();
  const desk = await rig.call('GET /api/mix');
  assert.equal(desk.song.b.bpm, 128);
  assert.equal(desk.song.b.musicalKey, 'Am');
  assert.equal(desk.song.b.sync, true, 'a song with a tempo opens synced');
  assert.deepEqual(desk.tracks.map((t) => t.key), ['b:#song']);
});

test('the first synced song takes the grid: the room plays at its tempo, on its bar', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 126 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  const res = await rig.call('POST /api/song/play', { deck: 'a' });
  assert.equal(res.master, true);
  assert.equal(rig.transport.cps * 240, 126);
  assert.equal(rig.transport.paused, false);
  const start = playerMessages(rig, 'a').find((m) => m.kind === 'start');
  // The player starts a latency before the song is heard to start.
  assert.ok(Math.abs(start.time - (10 + 0.15 - LAT)) < 1e-9);
  assert.equal(start.rate, 1);
});

test('a second synced song joins on the next bar line, at the rate that matches the room', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 128 }, '/music/b.wav': { bpm: 124, anchorSec: 0.25 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await rig.call('POST /api/song/load', { deck: 'b', path: '/music/b.wav' });
  await settle();
  await rig.call('POST /api/song/play', { deck: 'a' });
  rig.ctx.advance(1.3);
  const res = await rig.call('POST /api/song/play', { deck: 'b', pos: 0.25 });
  assert.equal(res.master, false);
  assert.ok(Math.abs(res.rate - 128 / 124) < 1e-9);
  const { songDecks } = rig.desk.state();
  // B's downbeat (its anchor) lands on a cycle boundary of the room's clock: a bar line.
  const atCycle = rig.transport.cycleAt(songDecks.b.startSec);
  assert.ok(Math.abs(atCycle - Math.round(atCycle)) < 1e-6, `starts on a bar, at cycle ${atCycle}`);
  assert.ok(songDecks.b.startSec > rig.ctx.currentTime, 'and waits for it rather than cutting in');
});

test('a rate change is rebased where it is heard, so the playhead never jumps', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/meta', { deck: 'a', sync: false });
  await rig.call('POST /api/song/play', { deck: 'a', now: true });
  rig.ctx.advance(2);
  const before = rig.desk.songPlayheadSec('a', rig.ctx.currentTime + 0.5);
  await rig.call('POST /api/mix/decktempo', { deck: 'a', frac: 1 }); // +6%
  const s = rig.desk.state().songDecks.a;
  assert.ok(Math.abs(s.rate - 1.06) < 1e-9);
  assert.ok(Math.abs(s.startSec - (rig.ctx.currentTime + LAT)) < 1e-9, 'rebased at the heard moment');
  // Continuous across the change: the old rate until it is heard, the new one after.
  const now = rig.ctx.currentTime;
  const at = (t) => rig.desk.songPlayheadSec('a', t);
  assert.ok(Math.abs(at(now + LAT) - at(now + LAT - 1e-6)) < 1e-5);
  assert.ok(Math.abs((at(now + LAT + 1) - at(now + LAT)) - 1.06) < 1e-9);
  assert.ok(Math.abs(at(now + 0.5) - before) > 0, 'the playhead moved on');
  const rate = playerMessages(rig, 'a').filter((m) => m.kind === 'rate').at(-1);
  assert.equal(rate.time, now, 'the player is told now');
  // The editor's mirror is one line: while the change is on its way it is drawn from now, so the
  // pane's playhead keeps moving rather than waiting out the latency.
  const desk = await rig.call('GET /api/mix');
  assert.ok(Math.abs(desk.song.a.posSec - at(now)) < 1e-9);
  assert.ok(Math.abs(desk.song.a.startSec - Date.now() / 1000) < 1);
});

test('a held nudge pushes the deck and the place it gained stays', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/meta', { deck: 'a', sync: false });
  await rig.call('POST /api/song/play', { deck: 'a', now: true });
  rig.ctx.advance(1);
  await rig.call('POST /api/song/nudge', { deck: 'a', hold: 1 });
  assert.ok(Math.abs(rig.desk.state().songDecks.a.rate - 1.04) < 1e-9);
  rig.ctx.advance(1);
  await rig.call('POST /api/song/nudge', { deck: 'a', hold: 0 });
  assert.equal(rig.desk.state().songDecks.a.rate, 1);
  // One second held at +4%: 40 ms ahead of where it would have been.
  const t = rig.ctx.currentTime + 1;
  assert.ok(Math.abs(rig.desk.songPlayheadSec('a', t) - (t - (10 + 0.15) + 0.04)) < 1e-6);
});

test('cue on a paused deck sets the cue point on the grid and auditions; letting go goes home', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120, anchorSec: 0 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/seek', { deck: 'a', pos: 10.2 });
  const press = await rig.call('POST /api/song/cue', { deck: 'a', hold: true });
  assert.equal(press.cueSec, 10, 'the nearest beat of the song\'s own grid (120 bpm: half seconds)');
  assert.equal(press.playing, true);
  rig.ctx.advance(1);
  const release = await rig.call('POST /api/song/cue', { deck: 'a', hold: false });
  assert.equal(release.playing, false);
  assert.equal(rig.desk.state().songDecks.a.posSec, 10, 'home: the next play starts from the cue');
});

test('a song runs to its end and stops there; play from the end starts from the top', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120, seconds: 3 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/meta', { deck: 'a', sync: false });
  await rig.call('POST /api/song/play', { deck: 'a', now: true, pos: 2.6 });
  const s = rig.desk.state().songDecks.a;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(s.playing, false);
  assert.equal(s.posSec, 3);
  const stop = playerMessages(rig, 'a').filter((m) => m.kind === 'stop').at(-1);
  // Heard end = start + 0.4 s; the release is over by it, and the player does it a latency early.
  assert.ok(Math.abs(stop.time - (10 + 0.15 + 0.4 - 0.05 - LAT)) < 1e-9);
  const again = await rig.call('POST /api/song/play', { deck: 'a', now: true });
  assert.equal(again.pos, 0);
});

test('the crossfader and the channel faders are each deck\'s one gain, curved by the swap toggle', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 }, '/music/b.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await rig.call('POST /api/song/load', { deck: 'b', path: '/music/b.wav' });
  const gain = (deck) => rig.engine.tracks.get(rig.evaluator.trackIds.get(SONG_KEYS[deck])).deckGain.gain.value;
  await rig.call('POST /api/mix/set', { name: 'xf', value: 0 });
  assert.equal(gain('a'), 0.707, 'constant power: each side about -3 dB at the center');
  await rig.call('POST /api/mix/swap', { on: true });
  assert.equal(gain('a'), 1, 'swap mode holds both decks full through the center');
  await rig.call('POST /api/mix/set', { deck: 'b', name: 'fader', value: 0.5 });
  assert.equal(gain('b'), 0.5, 'the channel fader scales its deck\'s side');
  await rig.call('POST /api/mix/set', { name: 'xf', value: -1 });
  assert.equal(gain('b'), 0);
});

test('a deck-wide control reaches every stem of that deck and none of the other\'s', async () => {
  const rig = makeRig({});
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('kick: s("bd*4")', { deck: 'a' });
  rig.evaluator.evaluate('kick: s("bd*4")\n\nhat: s("hh*8")', { deck: 'b' });
  assert.deepEqual([...rig.evaluator.schedulers.keys()].sort(), ['b:hat', 'b:kick', 'kick']);
  await rig.call('POST /api/mix/set', { deck: 'b', name: 'eqlo', value: 0 });
  const track = (key) => rig.engine.tracks.get(rig.evaluator.trackIds.get(key));
  assert.ok(track('b:kick').djEq && track('b:hat').djEq);
  assert.equal(track('kick').djEq, null);
  // A stem born later wears the deck's setting from its first sample.
  rig.evaluator.evaluate('kick: s("bd*4")\n\nhat: s("hh*8")\n\nclap: s("cp*2")', { deck: 'b' });
  assert.ok(track('b:clap').djEq);
});

test('in DJ mode a deck\'s setbpm is its native tempo, not a move of the room', async () => {
  const rig = makeRig({});
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('setbpm(128)\n\nkick: s("bd*4")', { deck: 'a' });
  assert.equal(rig.transport.cps * 240, 128, 'the first track of a set sets the room');
  rig.evaluator.evaluate('setbpm(140)\n\nkick: s("bd*4")', { deck: 'b' });
  assert.equal(rig.transport.cps * 240, 128, 'the second deck does not drag the room');
  const desk = await rig.call('GET /api/mix');
  assert.equal(desk.deckBpm.b, 140);
  await rig.call('POST /api/mix/livesync', { deck: 'b', sync: false });
  assert.equal(rig.desk.clockOf('b').cps * 240, 140, 'sync off: the deck runs at its own tempo');
  assert.equal(rig.transport.cps * 240, 128);
});

test('gate, solo and swap act on stems, and a solo ends back where it began', async () => {
  const rig = makeRig({});
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('kick: s("bd*4")\n\nhat: s("hh*8")', { deck: 'a' });
  rig.evaluator.evaluate('kick: s("bd*2")', { deck: 'b' });
  const fader = (key) => rig.engine.tracks.get(rig.evaluator.trackIds.get(key)).faderGain.gain.value;
  await rig.call('POST /api/mix/solo', { key: 'hat' });
  assert.equal(fader('kick'), 0);
  assert.equal(fader('hat'), 1);
  assert.equal(fader('b:kick'), 1, 'a solo is deck-local');
  await rig.call('POST /api/mix/solo', { key: 'hat' });
  assert.equal(fader('kick'), 1, 'the last soloed stem leaving restores the deck');
  await rig.call('POST /api/mix/swap', { on: true });
  const res = await rig.call('POST /api/mix/gate', { key: 'b:kick', on: true });
  assert.equal(res.countered, 'kick', 'gating one in throws its twin out');
  assert.equal(fader('kick'), 0);
  await assert.rejects(() => rig.call('POST /api/mix/gate', { key: 'nothing', on: true }), /no playing track/);
});

test('clearing a deck empties it and leaves the desk; eject resets the desk to its home', async () => {
  const rig = makeRig({ '/music/b.wav': { bpm: 120 } });
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('kick: s("bd*4")', { deck: 'a' });
  await rig.call('POST /api/song/load', { deck: 'b', path: '/music/b.wav' });
  await rig.call('POST /api/mix/set', { name: 'xf', value: 0.5 });
  await rig.call('POST /api/mix/clear', { deck: 'b' });
  let desk = await rig.call('GET /api/mix');
  assert.equal(desk.song.b, null);
  assert.equal(desk.xf, 0.5, 'clearing one deck is part of the set, not the end of it');
  await rig.call('POST /api/mix/eject');
  desk = await rig.call('GET /api/mix');
  assert.equal(desk.xf, 0);
  assert.deepEqual(desk.faders, { a: 1, b: 1 });
  assert.deepEqual([...rig.evaluator.schedulers.keys()], ['kick'], 'deck A plays on');
});

test('complete-mix promotes deck B into deck A without touching the engine', async () => {
  const rig = makeRig({});
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('kick: s("bd*4")', { deck: 'a' });
  rig.evaluator.evaluate('bass: n("0 3")', { deck: 'b' });
  const id = rig.evaluator.trackIds.get('b:bass');
  const sch = rig.evaluator.schedulers.get('b:bass');
  const res = await rig.call('POST /api/mix/complete');
  assert.deepEqual(res.promoted, ['bass']);
  assert.equal(rig.evaluator.trackIds.get('bass'), id, 'the same engine track');
  assert.equal(rig.evaluator.schedulers.get('bass'), sch, 'the same scheduler, still playing');
  assert.equal(rig.evaluator.schedulers.has('kick'), false, 'the outgoing deck is gone');
});

test('the loop button holds the next beats of a song and resizes around where it began', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120, anchorSec: 0 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/seek', { deck: 'a', pos: 4.3 });
  const on = await rig.call('POST /api/mix/loop', { deck: 'a', on: true, beats: 4 });
  assert.deepEqual([on.from, on.to], [4, 6], 'from the beat the playhead is in, four beats at 120');
  const bigger = await rig.call('POST /api/mix/loop', { deck: 'a', scale: 2 });
  assert.deepEqual([bigger.from, bigger.to], [4, 8]);
  const off = await rig.call('POST /api/mix/loop', { deck: 'a', on: false });
  assert.equal(off.on, false);
});

test('keylock and quantize are the deck\'s facts; keylock moves the engine\'s path at once', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  const calls = [];
  const was = rig.engine.songKeylock.bind(rig.engine);
  rig.engine.songKeylock = (tid, on, at) => { calls.push(on); return was(tid, on, at); };
  const res = await rig.call('POST /api/song/meta', { deck: 'a', keylock: true, quantize: false });
  assert.equal(res.keylock, true);
  assert.equal(res.quantize, false);
  assert.deepEqual(calls, [true]);
  await assert.rejects(() => rig.call('POST /api/song/meta', { deck: 'a', syncMult: 3 }), /syncMult/);
});

test('the FX unit refuses a chain that does not build, and switches a saved one in on its deck', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/mix/dj', { on: true });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await assert.rejects(() => rig.call('POST /api/mix/fxchain', { save: 'x', code: 'fx("Filter")' }), /starts with a dot/);
  await assert.rejects(() => rig.call('POST /api/mix/fxchain', { save: 'x', code: '.fx(' }));
  const saved = await rig.call('POST /api/mix/fxchain', { save: 'dark', code: '.fx("Filter")' });
  assert.deepEqual(saved.chains, ['dark']);
  const sends = [];
  rig.engine.setFxSend = (tid, bus, level) => sends.push({ tid, bus, level });
  const state = await rig.call('POST /api/mix/fx', { chain: 'dark', on: true, assign: 'a' });
  assert.equal(state.chain, 'dark');
  const songTid = rig.evaluator.trackIds.get('#song');
  assert.deepEqual(sends.filter((s) => s.tid === songTid).at(-1), { tid: songTid, bus: '#fxa', level: 1 });
  assert.ok(rig.evaluator.trackIds.has('#fx') && rig.evaluator.trackIds.has('b:#fx'), 'a return on each deck');
  // Kept for the next session.
  assert.deepEqual(Object.keys((await rig.store.get('settings/dj-fx')).chains), ['dark']);
  await rig.call('POST /api/mix/eject');
  assert.equal((await rig.call('GET /api/mix')).fx.chain, null, 'leaving the desk takes the unit out');
});

test('the desk frame carries every field the editor\'s desk reads, with times on the wall clock', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/play', { deck: 'a' });
  const desk = await rig.call('GET /api/mix');
  for (const key of ['dj', 'swap', 'solo', 'playing', 'perDeck', 'deckBpm', 'tempo', 'deckTempo', 'loops', 'deckLoop', 'deckJog',
    'playedN', 'fx', 'link', 'transport', 'deckTransport', 'live', 'xf', 'faders', 'headphones', 'cue', 'midi', 'neutral', 'song']) {
    assert.ok(key in desk, key);
  }
  assert.deepEqual(desk.neutral, DJ_NEUTRAL);
  const wall = Date.now() / 1000;
  assert.ok(Math.abs(desk.song.a.startSec - wall) < 5, 'a song\'s start time is on the clock the editor mirrors with');
  assert.ok(Math.abs(desk.transport.baseSec - wall) < 5);
});

test('the push channel sends the desk at once and on every change, and meters only while heard', async () => {
  const rig = makeRig({});
  const frames = [];
  let metering = null;
  const was = rig.engine.deckMeters.bind(rig.engine);
  rig.engine.deckMeters = (on) => { metering = on; return was(on); };
  const close = rig.desk.subscribe((kind, data) => frames.push({ kind, data }));
  assert.equal(metering, true);
  await settle();
  assert.equal(frames[0].kind, 'message');
  await rig.call('POST /api/mix/set', { name: 'xf', value: 0.3 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(frames.some((f) => f.kind === 'message' && f.data.xf === 0.3));
  close();
  assert.equal(metering, false);
});

test('the headphone knobs are kept for the next visit', async () => {
  const rig = makeRig({});
  const res = await rig.call('POST /api/mix/headphones', { level: 0.6, mix: 0.25 });
  assert.equal(res.level, 0.6);
  assert.equal(res.cuePair, false, 'no cue route chosen yet');
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(await rig.store.get('settings/headphones'), { level: 0.6, mix: 0.25 });
});

// --- a controller, through Web MIDI --------------------------------------------------------------

const cc = (num, raw, channel = 1) => ({ kind: 'cc', channel, num, value: raw / 127 });
const noteOn = (num, channel = 1) => ({ kind: 'on', channel, num, value: 1 });
const noteOff = (num, channel = 1) => ({ kind: 'off', channel, num, value: 0 });

test('a desk control is learned from the next message that suits it, kept, and driven from then on', async () => {
  const rig = makeRig({});
  const learning = rig.call('POST /api/mix/midilearn', { target: 'xf' });
  await settle();
  // A pad is not a crossfader: a note is passed over, and the arm stands.
  assert.equal(rig.desk.handleMidi('Ctl', noteOn(40)), true);
  assert.equal(rig.desk.handleMidi('Ctl', cc(7, 64)), true);
  const { learned } = await learning;
  assert.deepEqual(learned, { device: 'Ctl', channel: 1, kind: 'cc', num: 7 });
  assert.deepEqual((await rig.store.get('settings/mix-midi')).map.xf, learned);
  assert.equal(rig.desk.handleMidi('Ctl', cc(7, 127)), true, 'a learned control is the desk\'s alone');
  assert.equal(rig.desk.state().mixState.xf, 1);
  assert.equal(rig.desk.handleMidi('Ctl', cc(8, 127)), false, 'anything else goes on to the patterns');
});

test('a pad plays a song deck, and a deck of code hears its press as the editor\'s to act on', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/mix/dj', { on: true });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  const learning = rig.call('POST /api/mix/midilearn', { target: 'a:play' });
  await settle();
  rig.desk.handleMidi('Ctl', noteOn(11));
  await learning;
  rig.desk.handleMidi('Ctl', noteOff(11));
  rig.desk.handleMidi('Ctl', noteOn(11));
  assert.equal(rig.desk.state().songDecks.a.playing, true, 'the press edge plays it');
  rig.desk.handleMidi('Ctl', noteOn(11));
  assert.equal(rig.desk.state().songDecks.a.playing, true, 'a pad restating itself is not a second press');
  // Deck B holds code: the press goes to the editor, which evaluates the buffer.
  const actions = [];
  const close = rig.desk.subscribe((kind, data) => { if (kind === 'action') actions.push(data); });
  const learnB = rig.call('POST /api/mix/midilearn', { target: 'b:play' });
  await settle();
  rig.desk.handleMidi('Ctl', noteOn(12));
  await learnB;
  rig.desk.handleMidi('Ctl', noteOff(12));
  rig.desk.handleMidi('Ctl', noteOn(12));
  assert.deepEqual(actions, [{ deck: 'b', action: 'play', value: null }]);
  close();
});

test('the platter bends a playing song, and the bend dies away when the hand rests', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await settle();
  await rig.call('POST /api/song/meta', { deck: 'a', sync: false });
  await rig.call('POST /api/song/play', { deck: 'a', now: true });
  const learning = rig.call('POST /api/mix/midilearn', { target: 'a:bend' });
  await settle();
  rig.desk.handleMidi('Ctl', cc(33, 64));
  await learning;
  for (let i = 0; i < 4; i++) rig.desk.handleMidi('Ctl', cc(33, 70)); // a forward turn
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(rig.desk.state().songDecks.a.rate > 1, 'turning forward speeds the deck up');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(rig.desk.state().songDecks.a.rate, 1, 'and it comes back to its rate');
});

test('a high-resolution tempo fader is read as one 14-bit control, plus at the bottom', async () => {
  const rig = makeRig({});
  const learning = rig.call('POST /api/mix/midilearn', { target: 'a:tempo' });
  await settle();
  rig.desk.handleMidi('Ctl', cc(0, 64));
  await learning;
  // Coarse 127 then its fine half: the fader's highest value, which is the plus end.
  rig.desk.handleMidi('Ctl', cc(0, 127));
  assert.equal(rig.desk.handleMidi('Ctl', cc(32, 127)), true, 'the fine half refines the control rather than being one');
  assert.equal(rig.desk.state().mixState.deckTempo.a.frac, 1);
});

test('a switch is learned in one sweep, its positions in the order they came', async () => {
  const rig = makeRig({});
  const sweep = rig.call('POST /api/mix/midiswitch', { targets: ['fxassigna', 'fxassignab', 'fxassignb'] });
  await settle();
  for (const n of [20, 21, 22]) rig.desk.handleMidi('Ctl', noteOn(n));
  const { learned } = await sweep;
  assert.deepEqual(learned.map((l) => [l.target, l.num]), [['fxassigna', 20], ['fxassignab', 21], ['fxassignb', 22]]);
  rig.desk.handleMidi('Ctl', noteOn(22));
  assert.equal(rig.desk.state().mixState.fx.assign, 'b');
});

test('talk-back lights the pads that are on, and puts them out when the port changes', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  const learning = rig.call('POST /api/mix/midilearn', { target: 'a:play' });
  await settle();
  rig.desk.handleMidi('Ctl', noteOn(11, 2));
  await learning;
  const res = await rig.call('POST /api/mix/feedback', { device: 'Pad' });
  assert.equal(res.active, 'Pad Controller');
  rig.midi.sent.length = 0;
  await rig.call('POST /api/song/play', { deck: 'a', now: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(rig.midi.sent.at(-1), ['note', 1, 11, 127], 'the play pad lit, on the port\'s 0-15 channel');
  await rig.call('POST /api/mix/feedback', { device: null });
  assert.deepEqual(rig.midi.sent.at(-1), ['note', 1, 11, 0]);
});

test('unbinding a control lets its messages go back to the patterns', async () => {
  const rig = makeRig({});
  const learning = rig.call('POST /api/mix/midilearn', { target: 'a:djf' });
  await settle();
  rig.desk.handleMidi('Ctl', cc(9, 64));
  await learning;
  await rig.call('POST /api/mix/midilearn', { target: 'a:djf', clear: true });
  assert.equal(rig.desk.handleMidi('Ctl', cc(9, 10)), false);
  const monitor = await rig.call('POST /api/mix/midilearn', { monitor: true });
  assert.deepEqual(monitor.bound, []);
});

// --- the set's tracklist ----------------------------------------------------------------------------

test('a set writes a tracklist line for a deck that stayed in the room, and closes with the desk', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/mix/dj', { on: true });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await rig.call('POST /api/song/play', { deck: 'a', now: true });
  const realNow = Date.now;
  try {
    rig.desk.state(); // the leader is sampled on every desk frame and on a timer
    await rig.call('GET /api/mix'); // starts this deck's run
    Date.now = () => realNow() + 9000; // past the confirm window: a track of the set, not an audition
    await rig.call('GET /api/mix');
    assert.deepEqual(rig.sets.at(-1), { entries: 1, ended: false });
    await rig.call('POST /api/mix/dj', { on: false });
    assert.deepEqual(rig.sets.at(-1), { entries: 1, ended: true });
  } finally {
    Date.now = realNow;
  }
});

// --- a deck's own tempo for its devices -----------------------------------------------------------

test('a deck of code with its sync off tells its own tracks\' devices its own tempo', async () => {
  const rig = makeRig({});
  await rig.call('POST /api/mix/dj', { on: true });
  rig.evaluator.evaluate('setbpm(128)\n\nkick: s("bd*4")', { deck: 'a' });
  rig.evaluator.evaluate('setbpm(140)\n\nkick: s("bd*4")', { deck: 'b' });
  const told = [];
  const was = rig.engine.setTempo.bind(rig.engine);
  rig.engine.setTempo = (bpm, anchor, scope) => { told.push({ bpm, scope }); return was(bpm, anchor, scope); };
  await rig.call('POST /api/mix/livesync', { deck: 'b', sync: false });
  const bId = rig.evaluator.trackIds.get('b:kick');
  const own = told.filter((t) => t.scope?.only).at(-1);
  assert.equal(own.bpm, 140);
  assert.deepEqual(own.scope.only, [bId]);
  assert.ok(told.some((t) => t.bpm === 128 && t.scope?.except?.includes(bId)), 'the room\'s tempo for everybody else');
  assert.equal(rig.engine.trackTempo.get(bId).bpm, 140, 'and a device built on it later starts there');
});

// --- an FX chain's device window ---------------------------------------------------------------

test('an FX device window opens on the unit\'s return, and what is set there is written into the chain', async () => {
  const rig = makeRig({ '/music/a.wav': { bpm: 120 } });
  await rig.call('POST /api/mix/dj', { on: true });
  await rig.call('POST /api/song/load', { deck: 'a', path: '/music/a.wav' });
  await rig.call('POST /api/mix/fxchain', { save: 'dark', code: '.fx("Filter").fx("Delay")' });
  await rig.call('POST /api/mix/fx', { chain: 'dark' });
  const res = await rig.call('POST /api/mix/fx', { editor: 2 });
  assert.deepEqual(res.editor, { trackId: '#fx', slot: 2 });
  await assert.rejects(() => rig.call('POST /api/mix/fx', { editor: 3 }), /2 effects - there is no slot 3/);
  await rig.call('POST /api/mix/fx', { assign: 'b' });
  assert.deepEqual((await rig.call('POST /api/mix/fx', { editor: true })).editor, { trackId: 'b:#fx', slot: 1 });
  assert.ok(rig.desk.isFxKey('#fx') && rig.desk.isFxKey('b:#fx') && !rig.desk.isFxKey('#song'));
  // The window closes: slot 2's state lands on the second call, and the chain is kept so.
  const written = await rig.desk.fxPinState(2, 'abc=');
  assert.equal(written, '.fx("Filter").fx("Delay", { state: "abc=" })');
  assert.equal((await rig.store.get('settings/dj-fx')).chains.dark.code, written);
  assert.equal(await rig.desk.fxPinState(2, 'abc='), null, 'the same state again changes nothing');
});
