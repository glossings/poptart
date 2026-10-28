'use strict';

// The Node engine's MIDI, OSC-input and clock sections (engine/midi.js, osc-in.js, clock.js), on
// the fake engine (no scsynth) with the MIDI worker's in-memory backend: what reaches the server
// directly from the worker is caught on a UDP socket standing in for scsynth, and what goes to the
// devices is reported back by the fake backend. The same behavior the *-sclang tests hold the
// sclang engine to: the clock mirror, the talk-back port, a route's teardown, and setTempo
// reaching every open plugin. Plus what is new here: knobs and keys played from the worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const osc = require('osc');
const { fakeEngine } = require('./test-support/fake-engine');
const { MidiIO } = require('./server/midi-io');

const SERVER_PORT = 57431; // stands in for scsynth: the worker's direct sends land here
const OSC_IN_PORT = 57432;

const SRC = { uid: 101, device: 'Fake Keys', name: 'Port 1' };
const DST = { uid: 202, device: 'Fake Surface', name: 'Lamps' };
const CLOCK = { uid: 303, device: 'Fake Drum Machine', name: 'In' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(5);
  }
};

/** A UDP socket on SERVER_PORT collecting every message as [address, ...args]. */
async function fakeScsynth() {
  const got = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf) => {
    const walk = (p) => { if (p.packets) p.packets.forEach(walk); else got.push([p.address, ...(p.args ?? [])]); };
    walk(osc.readPacket(buf, { metadata: false }));
  });
  await new Promise((r) => sock.bind(SERVER_PORT, '127.0.0.1', r));
  return { got, close: () => sock.close() };
}

/** A plugin controller stand-in that records what it is sent. */
function fakeVst({ vst3 = false, node = 3000, index = 18 } = {}) {
  const calls = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  return {
    calls,
    synth: { nodeID: node },
    synthIndex: index,
    sendMidi() {},
    info: { sdkVersion: vst3 ? 'VST 3.7.6' : 'VST 2.4' },
    midi: { noteOn: rec('noteOn'), noteOff: rec('noteOff'), control: rec('control'), bend: rec('bend'), touch: rec('touch'), polyTouch: rec('polyTouch') },
    setTempo: rec('setTempo'),
    setTransportPos: rec('setTransportPos'),
  };
}

function rig(t, { sections = ['tracks', 'routing', 'loads', 'ids', 'midi', 'clock', 'osc-in'] } = {}) {
  const io = new MidiIO({ backend: 'fake', serverPort: SERVER_PORT, fakeDevices: { sources: [SRC], destinations: [DST, CLOCK] } });
  const fe = fakeEngine({ sections, config: { midiIO: io, oscInPort: OSC_IN_PORT, server: { port: SERVER_PORT } } });
  const devSent = [];
  io.onSent((m) => { if (m.op === 'fakeSent') devSent.push(m); });
  t.after(async () => { fe.E.stop(); await io.close(); });
  return { ...fe, io, devSent };
}

/** A track as buildTrack leaves it, holding `ctl` in slot 0 (no server needed). */
function addTrack(E, key, ctl) {
  const track = {
    key, controllers: new Map(), loaded: new Map(), envs: new Map(), lfos: new Map(), ccs: new Map(), oscs: new Map(),
    ramps: new Map(), held: 0, sounding: new Map(), midiRoute: null, nodes: new Map(),
    head: { nodeID: ctl?.synth?.nodeID ?? 2999 },
  };
  if (ctl) { track.controllers.set(0, ctl); track.loaded.set(0, 'plugin'); }
  E.tracks.set(key, track);
  return track;
}

test('the host clock mirror follows Node\'s tempo, position and events', async (t) => {
  const { E, io } = rig(t);
  const starts = [];
  io.clockStart = (o) => starts.push(o);
  // A running sync: 120 bpm, beat 8 due in 0.15 s -> the mirror sits at 8 - 0.3 now.
  E.hostClockSync(120, 8, 0.15, true, 'sync');
  assert.equal(Math.round(E.hostClock.tempo * 60), 120);
  assert.ok(Math.abs(E.hostClock.beats - 7.7) < 1e-3, `beats ${E.hostClock.beats}`);
  assert.equal(E.clockRunning, true);
  // Paused: the tempo follows, the position does not.
  const b0 = E.hostClock.beats;
  E.hostClockSync(90, 0, 0.15, false, 'sync');
  assert.equal(Math.round(E.hostClock.tempo * 60), 90);
  assert.ok(Math.abs(E.hostClock.beats - b0) < 0.02, 'a paused sync must never move the position');
  assert.equal(E.clockRunning, false);
  // Events: with a destination, start and rebase hand the ticker a locate; stop sends the stop.
  assert.equal(await E.midiClockSet('drum machine'), 'Fake Drum Machine In');
  starts.length = 0;
  E.hostClockSync(90, 0, 0.15, true, 'start');
  E.hostClockSync(90, 4, 0.15, true, 'rebase');
  assert.deepEqual(starts, [{ locate: true }, { locate: true }], 'start and rebase relocate the tick train');
  E.hostClockSync(90, 0, 0.15, false, 'stop');
  // Tick math (24 per beat).
  assert.deepEqual([E.clockNextTick(0, 0), E.clockNextTick(0.5, 0.02), E.clockNextTick((2 / 24) - 0.1, 0.1), E.clockNextTick(-0.3, 0.1)],
    [1, 13, 3, -4]);
});

test('a stop is sent stamped one clock lead on; the talk-back port writes each quadruple at once', async (t) => {
  const { E, io, devSent } = rig(t);
  assert.equal(await E.midiClockSet('drum'), 'Fake Drum Machine In');
  devSent.length = 0;
  const before = io.now();
  E.clockOut.stop();
  const stop = await until(() => devSent.find((m) => m.bytes[0] === 0xFC));
  assert.ok(Math.abs(stop.at - (before + E.clockOutLatency)) < 0.01, 'the stop carries the clock lead');
  await E.midiClockSet('');

  assert.equal(await E.midiFeedbackSet('surface'), 'Fake Surface Lamps');
  devSent.length = 0;
  E.dispatch('/poptart/midiOut', [0, 0, 2, 100, 0, 1, 2, 64, 1, 0, 17, 127, 1, 0, 18, 0]);
  E.dispatch('/poptart/midiOut', [0, 0, 200, 999, 1, 0, 11, -5]);
  await until(() => devSent.length >= 6);
  assert.deepEqual(devSent.map((m) => [m.uid, ...m.bytes]), [
    [202, 0xB0, 2, 100], [202, 0xB1, 2, 64], [202, 0x90, 17, 127], [202, 0x90, 18, 0],
    [202, 0xB0, 127, 127], [202, 0x90, 11, 0],
  ]);
  assert.ok(devSent.every((m) => m.at == null), 'lamps and meters go out at once (latency 0)');
  // Nothing chosen: a no-op, not an error.
  await E.midiFeedbackSet('');
  E.dispatch('/poptart/midiOut', [0, 0, 2, 100]);
});

test('a live route plays from the worker, keeps the books here, and its teardown releases by name', async (t) => {
  const server = await fakeScsynth();
  t.after(() => server.close());
  const { E, io, told } = rig(t);
  for (const vst3 of [true, false]) {
    const ctl = fakeVst({ vst3 });
    const key = vst3 ? 'three' : 'two';
    const track = addTrack(E, key, ctl);
    const gates = [];
    track.envs.set('slot0_cutoff', { synth: { set: (...a) => gates.push(a) } });
    // Transposed up 2 and onto C major: incoming 60 sounds as 62, 64 on channel 4 as 65.
    E.dispatch('/poptart/midiRoute', [key, 'fake keys', 0, '0,2,4,5,7,9,11', 2, 0]);
    await until(() => track.midiRoute);
    server.got.length = 0;
    io.fakeIn(SRC.uid, 0x90, 60, 100);
    io.fakeIn(SRC.uid, 0x93, 63, 90); // 63 + 2 = 65, in the scale
    await until(() => track.held === 2);
    // The worker sent both notes straight to the plugin's UGen.
    const notes = server.got.filter((m) => m[0] === '/u_cmd' && m[3] === '/midi_msg').map((m) => [...m[4]]);
    assert.deepEqual(notes, [[0x90, 62, 100], [0x93, 65, 90]]);
    assert.deepEqual(server.got[0].slice(1, 3), [3000, 18], 'addressed to the slot\'s UGen');
    assert.ok(told.some((m) => m.address === '/poptart/midiNoteIn' && m.args[0] === key && m.args[1] === 62));
    assert.deepEqual(gates.at(-1), ['gate', 1, 't_retrig', 1], 'a key opens the env gate');
    // Teardown: the held notes released at the pitches played, VST2 also gets CC 123 everywhere.
    E.dispatch('/poptart/clearMidiRoute', [key]);
    const offs = ctl.calls.filter((c) => c[0] === 'noteOff').map((c) => c.slice(1));
    assert.deepEqual(offs.sort(), [[0, 62, 0], [3, 65, 0]].sort());
    const ccs = ctl.calls.filter((c) => c[0] === 'control' && c[2] === 123);
    assert.equal(ccs.length, vst3 ? 0 : 16);
    assert.equal(track.midiRoute, null);
    assert.equal(track.held, 0);
    assert.deepEqual(gates.at(-1), ['gate', 0]);
    // After the teardown nothing more is played by the worker.
    server.got.length = 0;
    io.fakeIn(SRC.uid, 0x90, 60, 100);
    await wait(80);
    assert.equal(server.got.length, 0);
  }
  // No route: a no-op.
  const quiet = addTrack(E, 'unrouted', fakeVst());
  quiet.held = 2;
  E.dispatch('/poptart/clearMidiRoute', ['unrouted']);
  E.dispatch('/poptart/clearMidiRoute', ['nosuchtrack']);
  assert.equal(quiet.held, 2);
});

test('a route follows the slot to a reloaded instrument, and a note-off releases what its on played', async (t) => {
  const server = await fakeScsynth();
  t.after(() => server.close());
  const { E, io } = rig(t);
  const track = addTrack(E, 'lead', fakeVst({ node: 3000 }));
  E.dispatch('/poptart/midiRoute', ['lead', 'keys', 0, '', 0, 0]);
  await until(() => track.midiRoute);
  io.fakeIn(SRC.uid, 0x90, 60, 100);
  await until(() => track.held === 1);
  // The route is re-sent with a transpose while 60 is held: the off still releases 60.
  E.dispatch('/poptart/midiRoute', ['lead', 'keys', 0, '', 5, 0]);
  await wait(30);
  // ...and the instrument in the slot is swapped for another node meanwhile.
  track.controllers.set(0, fakeVst({ node: 4000 }));
  await wait(30);
  server.got.length = 0;
  io.fakeIn(SRC.uid, 0x80, 60, 0);
  io.fakeIn(SRC.uid, 0x90, 60, 100);
  await until(() => server.got.length >= 2);
  assert.deepEqual(server.got.map((m) => [m[1], ...m[4]]), [[4000, 0x80, 60, 0], [4000, 0x90, 65, 100]]);
});

test('midicc writes its bus from the worker and keeps the knob position for a range edit', async (t) => {
  const server = await fakeScsynth();
  t.after(() => server.close());
  const { E, io, sent } = rig(t);
  const track = addTrack(E, 'pad', fakeVst());
  const maps = [];
  E.awaitTarget = async () => ({ kind: 'control', index: 4, map: (bus) => maps.push(bus.index), unmap() {} });
  E.paramTarget = () => ({ unmap() {} });
  E.dispatch('/poptart/setParamCC', ['pad', 1, 'Cutoff', 'fake keys', 74, 0, 0.2, 0.6]);
  await until(() => track.ccs.size === 1);
  const entry = track.ccs.get('slot1_Cutoff');
  assert.deepEqual(maps, [entry.bus.index]);
  server.got.length = 0;
  io.fakeIn(SRC.uid, 0xB0, 74, 127);
  const set = await until(() => server.got.find((m) => m[0] === '/c_set'));
  assert.equal(set[1], entry.bus.index);
  assert.ok(Math.abs(set[2] - 0.6) < 1e-6, 'top of the knob is the top of the range');
  await until(() => entry.last === 1);
  // A range edit rescales the knob's last position onto the new range, and the worker follows.
  sent.length = 0;
  E.dispatch('/poptart/setParamCC', ['pad', 1, 'Cutoff', 'fake keys', 74, 0, 0, 0.5]);
  await until(() => sent.some((m) => m[0] === '/c_set'));
  assert.ok(Math.abs(sent.find((m) => m[0] === '/c_set')[2] - 0.5) < 1e-6);
  server.got.length = 0;
  io.fakeIn(SRC.uid, 0xB0, 74, 0);
  const low = await until(() => server.got.find((m) => m[0] === '/c_set'));
  assert.ok(Math.abs(low[2]) < 1e-6);
  // Another cc number, or another channel filter, is not this knob.
  server.got.length = 0;
  io.fakeIn(SRC.uid, 0xB0, 75, 64);
  await wait(60);
  assert.equal(server.got.length, 0);
  E.dispatch('/poptart/clearParamCC', ['pad', 1, 'Cutoff']);
  assert.equal(track.ccs.size, 0);
  io.fakeIn(SRC.uid, 0xB0, 74, 64);
  await wait(60);
  assert.equal(server.got.length, 0, 'a cleared knob writes nothing');
});

test('the input feed forwards ccs and both note edges to Node', async (t) => {
  const { E, io, told } = rig(t);
  await E.midiEnable();
  io.fakeIn(SRC.uid, 0xB2, 7, 127);
  io.fakeIn(SRC.uid, 0x90, 36, 64);
  io.fakeIn(SRC.uid, 0x90, 36, 0);
  io.fakeIn(SRC.uid, 0x80, 37, 50);
  await until(() => told.filter((m) => m.address === '/poptart/midiIn').length >= 4);
  assert.deepEqual(told.filter((m) => m.address === '/poptart/midiIn').map((m) => m.args), [
    ['Fake Keys Port 1', 3, 7, 1, 'cc'],
    ['Fake Keys Port 1', 1, 36, 64 / 127, 'note'],
    ['Fake Keys Port 1', 1, 36, 0, 'note'],
    ['Fake Keys Port 1', 1, 37, 0, 'note'],
  ]);
});

test('OSC input: the port opens, every message is told to Node, and osc() drives its parameter', async (t) => {
  const { E, told, sent } = rig(t);
  const track = addTrack(E, 'pad', fakeVst());
  E.awaitTarget = async () => ({ kind: 'control', index: 2, map() {}, unmap() {} });
  E.dispatch('/poptart/setParamOSC', ['pad', 1, 'Mix', '/fader/1', 0, 0, 2]);
  await until(() => track.oscs.size === 1);
  assert.ok(told.some((m) => m.address === '/poptart/oscOpen' && m.args[0] === OSC_IN_PORT));
  const entry = track.oscs.get('slot1_Mix');
  sent.length = 0;
  const sock = dgram.createSocket('udp4');
  t.after(() => sock.close());
  sock.send(osc.writePacket({ address: '/fader/1', args: [{ type: 'f', value: 0.25 }, { type: 's', value: 'x' }] }, { metadata: true }),
    OSC_IN_PORT, '127.0.0.1');
  const set = await until(() => sent.find((m) => m[0] === '/c_set' && m[1] === entry.bus.index));
  assert.ok(Math.abs(set[2] - 0.5) < 1e-6);
  const fwd = told.find((m) => m.address === '/poptart/oscIn');
  assert.deepEqual(fwd.args, ['/fader/1', 0.25], 'numbers only reach Node');
});

test('setTempo reaches every open plugin, scoped by deck', async (t) => {
  const { E } = rig(t);
  const a = fakeVst();
  const b = fakeVst();
  addTrack(E, 'a', a);
  addTrack(E, 'b:kick', b);
  E.dispatch('/poptart/setTempo', [128, 16, 0, 1, 'sync']);
  assert.deepEqual(a.calls, [['setTempo', 128], ['setTransportPos', 16]]);
  assert.deepEqual(b.calls, [['setTempo', 128], ['setTransportPos', 16]]);
  a.calls.length = 0;
  b.calls.length = 0;
  // Another clock for deck B only: the host mirror is not touched.
  E.dispatch('/poptart/setTempo', [100, 4, 0, 1, 'sync', 'only', 'b:kick']);
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, [['setTempo', 100], ['setTransportPos', 4]]);
  assert.equal(E.currentTempo, 128);
  assert.equal(E.trackTempo.get('b:kick'), 100);
  // The host clock with B left out.
  a.calls.length = 0;
  b.calls.length = 0;
  E.dispatch('/poptart/setTempo', [130, 20, 0, 1, 'sync', 'except', 'b:kick']);
  assert.deepEqual(a.calls, [['setTempo', 130], ['setTransportPos', 20]]);
  assert.deepEqual(b.calls, []);
});
