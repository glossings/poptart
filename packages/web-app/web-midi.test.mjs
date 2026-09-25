// MIDI in the page: parsing, asking for access once, and MIDI clock out following the
// transport - and the live-note log and recorder the controllers feed.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { createWebMidi, parseMidi } from './public/web/midi.mjs';
import { createLiveNotes } from './public/web/live-notes.mjs';

test('the three messages poptart reads are parsed; the rest are not', () => {
  assert.deepEqual(parseMidi([0x91, 60, 127]), { kind: 'on', channel: 2, num: 60, value: 1 });
  assert.deepEqual(parseMidi([0x90, 60, 0]), { kind: 'off', channel: 1, num: 60, value: 0 }, 'a velocity-0 note-on is an off');
  assert.deepEqual(parseMidi([0x8f, 61, 64]), { kind: 'off', channel: 16, num: 61, value: 64 / 127 });
  assert.deepEqual(parseMidi([0xb0, 12, 127]), { kind: 'cc', channel: 1, num: 12, value: 1 });
  assert.equal(parseMidi([0xf8]), null);
  assert.equal(parseMidi([0xe0, 0, 64]), null);
});

/** A fake MIDI system: one input, one output, and the permission asked for counted. */
function fakeAccess() {
  const sent = [];
  const input = { name: 'Arturia KeyStep 32', state: 'connected', type: 'input', onmidimessage: null };
  const output = { name: 'TR-8S', state: 'connected', type: 'output', send: (bytes, at) => sent.push([bytes[0], at]) };
  let asked = 0;
  const access = { inputs: new Map([['i', input]]), outputs: new Map([['o', output]]), onstatechange: null };
  const requestAccess = async () => { asked += 1; return access; };
  return { requestAccess, input, output, sent, asked: () => asked };
}

test('access is asked for once however many ask, and messages arrive by device name', async () => {
  const fake = fakeAccess();
  const got = [];
  const midi = createWebMidi({ requestAccess: fake.requestAccess, onMessage: (device, msg) => got.push([device, msg.kind, msg.num]), prefs: null });
  assert.equal(midi.enabled, false, 'nothing is asked at creation');
  await Promise.all([midi.enable(), midi.enable(), midi.inputs()]);
  assert.equal(fake.asked(), 1);
  assert.deepEqual(await midi.inputs(), ['Arturia KeyStep 32']);
  fake.input.onmidimessage({ data: [0x90, 60, 100], timeStamp: 0 });
  assert.deepEqual(got, [['Arturia KeyStep 32', 'on', 60]]);
});

test('a browser with no MIDI says which browsers have it', async () => {
  const midi = createWebMidi({ requestAccess: null, prefs: null });
  assert.equal(midi.available, false);
  await assert.rejects(midi.enable(), /Chrome, Edge and Firefox/);
});

test('the clock state does not ask for access by itself', async () => {
  const fake = fakeAccess();
  const midi = createWebMidi({ requestAccess: fake.requestAccess, prefs: null });
  assert.deepEqual(await midi.clockState(), { destinations: [], selected: null, active: null });
  assert.equal(fake.asked(), 0);
});

/** A transport at 120 bpm (cps 0.5), cycle zero at second zero, and a context's clock. */
function clockRig({ paused }) {
  const context = { currentTime: 0, getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: this.currentTime * 1000 }; } };
  const transport = { paused, cps: 0.5, cycleAt: (t) => t * 0.5, secAt: (c) => c / 0.5 };
  return { context, transport };
}

test('clock out sends 24 ticks a beat on the transport, starting from the top with a start', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const fake = fakeAccess();
    const { context, transport } = clockRig({ paused: false });
    context.currentTime = -0.01;
    const midi = createWebMidi({ requestAccess: fake.requestAccess, transport, context, prefs: null });
    const answer = await midi.setClock('tr-8');
    assert.equal(answer.active, 'TR-8S');
    mock.timers.tick(20);
    const ticks = fake.sent.filter(([b]) => b === 0xf8);
    // 0.1 s ahead at 48 ticks a second: ticks 0..4.
    assert.equal(ticks.length, 5);
    assert.ok(Math.abs(ticks[1][1] - ticks[0][1] - 1000 / 48) < 1e-6, 'a beat is 500 ms, a tick a 24th of it');
    const firstReal = fake.sent.findIndex(([b]) => b !== 0xfc);
    assert.equal(fake.sent[firstReal][0], 0xfa, 'from tick 0: a plain start, then the tick');
    assert.equal(fake.sent[firstReal + 1][0], 0xf8);
    midi.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('stopping sends a stop, and a later start relocates on the next sixteenth', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const fake = fakeAccess();
    const { context, transport } = clockRig({ paused: true });
    const midi = createWebMidi({ requestAccess: fake.requestAccess, transport, context, prefs: null });
    await midi.setClock('TR');
    context.currentTime = 1;
    mock.timers.tick(20);
    assert.ok(fake.sent.some(([b]) => b === 0xf8), 'ticks while stopped - the tempo still reaches the gear');
    fake.sent.length = 0;
    // Playing from half a cycle in. The next sixteenth (every 6th tick) is tick 54, at 1.125 s,
    // which comes inside the lookahead one wake later.
    transport.paused = false;
    context.currentTime = 1.005;
    mock.timers.tick(20);
    context.currentTime = 1.04;
    mock.timers.tick(20);
    const kinds = fake.sent.map(([b]) => b);
    const at = kinds.indexOf(0xf2);
    assert.ok(at > 0, 'a song position is sent');
    assert.equal(kinds[at - 1], 0xfc, 'after a stop');
    assert.equal(kinds[at + 1], 0xfb, 'then a continue');
    assert.equal(kinds[at + 2], 0xf8, 'then the tick itself');
    transport.paused = true;
    context.currentTime = 1.2;
    mock.timers.tick(20);
    assert.ok(fake.sent.some(([b]) => b === 0xfc));
    midi.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('a destination that is not there is refused, naming what is', async () => {
  const fake = fakeAccess();
  const midi = createWebMidi({ requestAccess: fake.requestAccess, transport: clockRig({ paused: true }).transport, context: clockRig({}).context, prefs: null });
  await assert.rejects(midi.setClock('Digitakt'), /connected: TR-8S/);
});

// --- the live-note log and the recorder ------------------------------------------------------

function notesRig() {
  let now = 0;
  const timers = [];
  const log = createLiveNotes({
    nowCycle: () => now,
    recordStartCycle: (arm, cycles, phrase) => Math.ceil(arm / phrase) * phrase,
    snapshot: () => ({ cps: 0.5 }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  return { log, at: (c) => { now = c; }, tick: () => log.tick() };
}

test('a note waits for its off, and keys still down are closed at now', () => {
  const { log, at } = notesRig();
  at(1); log.edge('keys', 60, 0.8, true);
  at(1.5); log.edge('keys', 60, 0, false);
  at(2); log.edge('keys', 62, 1, true);
  const evs = log.eventsFor('keys', -Infinity, 2.25);
  assert.deepEqual(evs.map((e) => [e.note, e.start, e.end, !!e.held]), [[60, 1, 1.5, false], [62, 2, 2.25, true]]);
});

test('the recorder arms, records on the phrase and hands back the take in its window', () => {
  const { log, at, tick } = notesRig();
  at(1);
  const armed = log.start({ cycles: 4, grid: 16 });
  assert.equal(armed.phase, 'armed');
  assert.equal(armed.startCycle, 4);
  at(4.5); log.edge('keys', 64, 1, true); tick();
  assert.equal(log.status().phase, 'recording');
  assert.equal(log.status().events.keys.length, 1, 'the take so far shows as it is played');
  at(9); tick();
  const done = log.status();
  assert.equal(done.phase, 'done');
  assert.deepEqual(done.results.map((r) => [r.label, r.events[0].note, r.events[0].end]), [['keys', 64, 8]], 'a held key rings to the end of the window');
  assert.throws(() => { log.cancel(); log.start({}); log.start({}); }, /already armed/);
});
