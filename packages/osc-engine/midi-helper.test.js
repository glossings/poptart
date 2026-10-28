'use strict';

// The CoreMIDI helper (native/bin/poptart-midi) through the MIDI worker, on a real CoreMIDI with
// no hardware needed: the helper makes a virtual source and destination of its own. Checked: it
// lists devices with the class library's names; a message into a source reaches the engine; and
// MIDI clock out's ticks are stamped with the host time their beat falls on - the precision the
// sclang engine got from MIDIOut's latency - including while the engine's own thread is blocked.
// macOS only; skipped elsewhere and where the helper is not built.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { MidiIO, HELPER } = require('./server/midi-io');

// Where CoreMIDI will not give the helper a client (a sandboxed run), it says so and exits.
function coreMidiRefusal() {
  const r = spawnSync(HELPER, [], { input: 'list\nquit\n', encoding: 'utf8', timeout: 10000 });
  return /^devices\t/m.test(r.stdout ?? '') ? false : `CoreMIDI is not available here: ${(r.stdout ?? '').trim() || r.error?.message}`;
}

const skip = process.platform !== 'darwin' ? 'CoreMIDI is macOS only'
  : !fs.existsSync(HELPER) ? 'the MIDI helper is not built (native/build-midi.sh)' : coreMidiRefusal();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(5);
  }
};
const block = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* the engine is busy */ } };

async function open(t, name) {
  const io = new MidiIO({ backend: 'swift' });
  t.after(() => io.close());
  const devices = await io.virtual(name);
  const src = devices.sources.find((s) => s.name === name);
  const dst = devices.destinations.find((d) => d.name === name);
  assert.ok(src && dst, `the virtual endpoints are listed: ${JSON.stringify(devices)}`);
  return { io, src, dst };
}

test('the helper lists endpoints as the class library names them, and input reaches the engine', { skip }, async (t) => {
  const { io, src } = await open(t, 'poptart helper test');
  assert.equal(src.device, 'poptart helper test', 'a virtual endpoint is its own device');
  assert.ok(Number.isInteger(src.uid));
  const got = [];
  io.onMessage((s, st, a, b) => got.push([s, st, a, b]));
  io.connect(src.uid);
  await wait(50);
  io.emit([0x91, 60, 100]);
  io.emit([0xB0, 7, 64]);
  io.emit([0xF8]);
  await until(() => got.length >= 3);
  assert.deepEqual(got.slice(0, 3), [[src.uid, 0x91, 60, 100], [src.uid, 0xB0, 7, 64], [src.uid, 0xF8, 0, 0]]);
});

test('a scheduled send is stamped with the host time it was asked for', { skip }, async (t) => {
  const { io, dst } = await open(t, 'poptart stamp test');
  const sync = await io.syncClock();
  const sent = new Map();
  io.onSent((m) => { if (m.op === 'sent') sent.set(m.id, m.stamped); });
  const want = new Map();
  const t0 = io.now() + 0.05;
  for (let i = 1; i <= 48; i++) {
    want.set(i, t0 + i * (1 / 48));
    io.send(dst.uid, [0xF8], want.get(i), i);
  }
  await until(() => sent.size === 48);
  const errs = [...want].map(([i, at]) => Math.abs(sent.get(i) - at));
  const worst = Math.max(...errs);
  // eslint-disable-next-line no-console
  console.log(`stamp error: worst ${(worst * 1e6).toFixed(2)} us over 48 sends (clock sync offset ${sync.offsetNs} ns, round trip ${sync.rttNs} ns)`);
  // One host tick is 41.7 ns on Apple silicon; the conversions round to it.
  assert.ok(worst < 1e-6, `stamps are within 1 us of the asked-for time (worst ${worst * 1e6} us)`);
});

test('clock ticks are stamped on their beats, and a blocked engine thread does not make them late', { skip }, async (t) => {
  const { io, dst } = await open(t, 'poptart clock test');
  const vin = [];
  io.onSent((m) => { if (m.op === 'vin') vin.push(m); });
  const tempo = 2; // 120 bpm, a tick every 1/48 s
  const latency = 0.05;
  const t0 = io.now();
  io.clockDest(dst.uid);
  io.clockState({ tempo, b0: 0, t0, running: true, latency });
  io.clockStart({ locate: true });
  await wait(600);
  // The engine's thread busy for longer than the clock's lead, three times over.
  block(200);
  await wait(50);
  block(200);
  await wait(400);
  io.clockStop();
  await wait(100);
  const ticks = vin.filter((m) => m.bytes[0] === 0xF8);
  assert.ok(ticks.length > 50, `ticks arrived (${ticks.length})`);
  // Each stamp against the moment of the beat it is for (t0 + k / 24 / tempo).
  const errs = ticks.map((m) => {
    const k = Math.round((m.stamped - t0) * tempo * 24);
    return Math.abs(m.stamped - (t0 + k / 24 / tempo));
  });
  const worst = Math.max(...errs);
  // Consecutive, none skipped.
  const ks = ticks.map((m) => Math.round((m.stamped - t0) * tempo * 24));
  const gaps = ks.slice(1).map((k, i) => k - ks[i]);
  // CoreMIDI holds a stamped packet until its time, so when it reached the destination says
  // whether it was sent in time: one sent late would arrive after its stamp.
  const late = ticks.map((m) => m.arrived - m.stamped);
  const worstLate = Math.max(...late.map(Math.abs));
  // eslint-disable-next-line no-console
  console.log(`clock: ${ticks.length} ticks, stamp error worst ${(worst * 1e6).toFixed(2)} us, `
    + `delivered within ${(worstLate * 1000).toFixed(3)} ms of their stamps (engine thread blocked 2 x 200 ms meanwhile)`);
  assert.ok(worst < 1e-6, `every tick is stamped on its beat (worst ${worst * 1e6} us)`);
  assert.ok(gaps.every((g) => g === 1), `no tick skipped or doubled: ${gaps.filter((g) => g !== 1).join(',')}`);
  assert.ok(worstLate < 0.002, `every tick was delivered on its beat, blocked engine or not (worst ${worstLate * 1000} ms)`);
  // The locate: stop, song position, continue and the tick, all on one sixteenth's stamp.
  const first = vin.findIndex((m) => m.bytes[0] === 0xFC);
  assert.ok(first >= 0, 'the locate sent a stop');
  const seq = vin.slice(first, first + 4);
  assert.deepEqual(seq.map((m) => m.bytes[0]), [0xFC, 0xF2, 0xFB, 0xF8]);
  assert.ok(seq.every((m) => m.stamped === seq[0].stamped), 'one stamp for the whole locate');
  const k = Math.round((seq[0].stamped - t0) * tempo * 24);
  assert.equal(k % 6, 0, 'on a sixteenth');
  assert.equal(seq[1].bytes[1] + seq[1].bytes[2] * 128, k / 6, 'song position in sixteenths');
});

// Startup asks for the device list from several places at once. Each ask has to get the answer:
// keeping one waiter per reply made all but the last time out ("no answer to list").
test('overlapping device-list requests are all answered', { skip }, async () => {
  const io = new MidiIO({ backend: 'swift' });
  try {
    await io.open();
    const lists = await Promise.all([io.list(), io.list(), io.list()]);
    for (const l of lists) assert.ok(Array.isArray(l.sources ?? io.sources()), 'each ask resolves with the devices');
  } finally {
    io.close?.();
  }
});
