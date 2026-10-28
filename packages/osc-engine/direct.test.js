'use strict';

// The direct path (direct.js): what Node sends scsynth itself, and when it leaves an event to sclang.

const { test } = require('node:test');
const assert = require('node:assert');
const osc = require('osc');

const {
  DirectPath, timeTagFor, secondsOf, packBundles, encode, MAX_DATAGRAM, NTP_EPOCH_OFFSET,
} = require('./direct');
const { OscEngine } = require('./index.js');

const msg = (address, ...args) => ({ address: `/poptart/ids/${address}`, args });

/** A DirectPath on a frozen clock, recording what it sends. */
function rig(now = 1000) {
  const sent = [];
  const told = [];
  const clock = { now };
  const d = new DirectPath({
    sendRaw: (bytes) => sent.push(osc.readPacket(bytes, { metadata: false })),
    tell: (address, args) => told.push([address, ...args]),
    now: () => clock.now,
  });
  return { d, sent, told, clock };
}

/** sclang's side of a track with a plugin instrument, one env and one note-synced shape. */
function populate(d, { native = false } = {}) {
  d.handle(msg('server', 57110, 0x7C0003E8, 0x7FFFFFFF, 48000, 0, 80));
  d.handle(msg('track', 'kick', 1001, 1002, 16, 40, 1003));
  d.handle(msg('slot', 'kick', 0, 1, 1, 1003, 2, native ? 1 : 0));
  d.handle(msg('modsBegin', 'kick'));
  d.handle(msg('mod', 'kick', 'slot0_Cutoff', 2001, 0));
  d.handle(msg('mod', 'kick', 'slot1_Mix', 2002, 3));
  d.handle(msg('mod', 'kick', 'slot1_Drive', 2003, 2));
  d.handle(msg('modsEnd', 'kick'));
}

const flat = (packet) => (packet.packets ? packet.packets : [packet]);

test('a timetag names the scheduled moment on the OSC clock', () => {
  const t = 1761600000.123456789;
  const tag = timeTagFor(t);
  assert.strictEqual(tag.raw[0], Math.floor(t) + NTP_EPOCH_OFFSET);
  assert.ok(Math.abs(secondsOf(tag) - t) < 1e-9, 'the fraction must survive to well under a sample');
  // ...and through the encoder and back.
  const back = osc.readPacket(encode({ timeTag: tag, packets: [{ address: '/x', args: [] }] }), {});
  assert.deepStrictEqual(back.timeTag.raw, tag.raw);
});

test('bundles split under one datagram, in order, all under the same time', () => {
  const tag = timeTagFor(1000.5);
  const messages = Array.from({ length: 600 }, (_, i) => ({ address: '/n_set', args: [{ type: 'i', value: i }, { type: 's', value: 'gate' }, { type: 'i', value: 1 }] }));
  const bundles = packBundles(tag, messages);
  assert.ok(bundles.length > 1, 'this many messages must not fit one datagram');
  let next = 0;
  for (const b of bundles) {
    assert.ok(encode(b).length <= MAX_DATAGRAM, `a bundle came out at ${encode(b).length} bytes`);
    assert.deepStrictEqual(b.timeTag, tag);
    for (const m of b.packets) assert.strictEqual(m.args[0].value, next++);
  }
  assert.strictEqual(next, 600, 'a message was lost or duplicated in the split');
});

test('a message bigger than a datagram is still sent, and said so', () => {
  const said = [];
  const huge = { address: '/b_setn', args: Array.from({ length: 3000 }, () => ({ type: 'f', value: 0 })) };
  const out = packBundles(timeTagFor(1), [huge], MAX_DATAGRAM, (m, n) => said.push(n));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(said.length, 1);
});

test('nothing goes direct before sclang has said where things are', () => {
  const { d, sent } = rig();
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'no server yet');
  d.handle(msg('server', 57110, 0x7C0003E8, 0x7FFFFFFF, 48000, 0, 80));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'no track yet');
  d.handle(msg('track', 'kick', 1001, 1002, 16, 40, 1003));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'no slot state yet');
  d.handle(msg('slot', 'kick', 0, 1, 0, 1003, 2, 0));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'a plugin still opening is sclang\'s');
  d.handle(msg('slot', 'kick', 0, 1, 1, 1003, 2, 0));
  d.handle(msg('dead', 1003));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'a node the server lost is sclang\'s');
  assert.strictEqual(sent.length, 0);
});

test('a plugin note is the MIDI sclang would send, bundled with its modulators at its own time', () => {
  const { d, sent, told } = rig();
  populate(d);
  assert.ok(d.noteOn('kick', 0, 61.6, 0.5, 1000.15));
  assert.strictEqual(sent.length, 1);
  const b = sent[0];
  assert.ok(Math.abs(secondsOf(b.timeTag) - 1000.15) < 1e-9);
  const [note, env, trig] = flat(b);
  assert.strictEqual(note.address, '/u_cmd');
  assert.deepStrictEqual(note.args.slice(0, 3), [1003, 2, '/midi_msg']);
  // noteKey rounds a plugin's note; velocity is (v * 127).round, as poptartNoteOn sends it.
  assert.deepStrictEqual([...note.args[3]], [0x90, 62, 64]);
  assert.deepStrictEqual(env, { address: '/n_set', args: [2001, 'gate', 1, 't_retrig', 1] });
  assert.deepStrictEqual(trig, { address: '/n_set', args: [2002, 't_trig', 1] });
  assert.strictEqual(flat(b).length, 3, 'a free-running shape must not be retriggered');
  assert.deepStrictEqual(told[0], ['/poptart/direct/note', 'kick', 0, 61.6, -1]);
  // The off closes the envelope only when nothing else is held.
  d.noteOn('kick', 0, 64, 1, 1000.2);
  d.noteOff('kick', 0, 61.6, 1000.3);
  assert.strictEqual(flat(sent[2]).length, 1, 'closed the env with a note still held');
  d.noteOff('kick', 0, 64, 1000.4);
  assert.deepStrictEqual(flat(sent[3])[1], { address: '/n_set', args: [2001, 'gate', 0] });
  assert.deepStrictEqual([...flat(sent[3])[0].args[3]], [0x80, 64, 0]);
});

test('one of poptart\'s own devices gets the note as written', () => {
  const { d, sent } = rig();
  populate(d, { native: true });
  d.noteOn('kick', 0, 61.6, 0.5, 1000.15);
  const on = flat(sent[0])[0];
  assert.deepStrictEqual(on.args.slice(0, 3), [1003, 2, '/noteOn']);
  assert.ok(Math.abs(on.args[3] - 61.6) < 1e-5);
  assert.ok(Math.abs(on.args[4] - 64 / 127) < 1e-6, 'velocity is quantized to 1/127 as the MIDI proxy does');
});

test('a slot note leaves the modulators alone and clips its velocity', () => {
  const { d, sent } = rig();
  populate(d);
  d.handle(msg('slot', 'kick', 2, 1, 1, 1010, 0, 0));
  assert.ok(d.noteOn('kick', 2, 36, 0, 1000.15));
  assert.strictEqual(flat(sent[0]).length, 1);
  assert.deepStrictEqual([...flat(sent[0])[0].args[3]], [0x90, 36, 1]);
});

test('notes a program load reaches wait for sclang; earlier ones and later loads do not', () => {
  const { d } = rig();
  populate(d);
  d.loadAnnounced('kick', 0, 4, 1000.2);
  assert.ok(d.noteOn('kick', 0, 60, 1, 1000.15), 'a note before the swap plays on time');
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.2), false);
  d.handle(msg('loadDone', 'kick', 0, 3));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.25), false, 'an older load finishing clears nothing');
  d.handle(msg('loadDone', 'kick', 0, 4));
  assert.ok(d.noteOn('kick', 0, 60, 1, 1000.25));
  d.loadAnnounced('kick', 0, 5, 1000.3);
  d.loadCancelled('kick', 0);
  assert.ok(d.noteOn('kick', 0, 60, 1, 1000.35));
});

test('a drawn shape\'s swap keeps note-ons with sclang until it says the swap is done', () => {
  const { d } = rig();
  populate(d);
  d.shapeSent('kick');
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'sent, not yet seen');
  d.handle(msg('swap', 'kick', 1, 1));
  assert.strictEqual(d.noteOn('kick', 0, 60, 1, 1000.15), false, 'seen and pending: the next note runs it');
  d.handle(msg('swap', 'kick', 1, 0));
  assert.ok(d.noteOn('kick', 0, 60, 1, 1000.2));
});

test('a sample voice is the same synth, in the voices group, with its gate-off at the event end', () => {
  const { d, sent, told } = rig();
  populate(d);
  const v = {
    bufnum: 7, channels: 2, begin: 0.1, end: 0.9, loop: 1, rate: 1.5, stretch: 1, dur: 0.4,
    onsetSec: 1000.15, offsetSec: 1000.4, amp: 0.8, cut: 0, atk: 0, dec: 0, sus: 1, rel: 0.05,
    loopLo: 0, loopHi: 1, entry: 0.1, pingpong: 0,
  };
  assert.ok(d.playSample('kick', v));
  const [spawn, env] = flat(sent[0]);
  assert.strictEqual(spawn.address, '/s_new');
  const [def, node, add, target, ...args] = spawn.args;
  assert.strictEqual(def, 'poptart_sample_loop_2');
  assert.ok(node >= 0x7C0003E8 && node <= 0x7FFFFFFF, 'the voice id is outside sclang\'s block');
  assert.strictEqual(add, 0);
  assert.strictEqual(target, 1002, 'voices go in the voices group, so a hush reaches them');
  const named = Object.fromEntries(args.reduce((acc, x, i) => (i % 2 ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []));
  assert.strictEqual(named.out, 16);
  assert.strictEqual(named.buf, 7);
  assert.strictEqual(named.bend, 'c40');
  assert.ok(Math.abs(named.entry - 0.1) < 1e-6);
  assert.deepStrictEqual(env.args, [2001, 'gate', 1, 't_retrig', 1]);
  assert.ok(Math.abs(secondsOf(sent[1].timeTag) - 1000.4) < 1e-9);
  assert.deepStrictEqual(flat(sent[1])[0], { address: '/n_set', args: [node, 'gate', 0] });
  assert.deepStrictEqual(told.at(-1), ['/poptart/direct/voice', 'kick', node, 'poptart_sample_loop_2', told.at(-1)[4]]);
  d.stop();
});

test('the node ids wrap inside the block Node was given', () => {
  const { d } = rig();
  d.handle(msg('server', 57110, 100, 102, 48000, 0, 80));
  assert.deepStrictEqual([d._allocNode(), d._allocNode(), d._allocNode(), d._allocNode()], [100, 101, 102, 100]);
});

test('a polled value moves the ramp sclang built, and a channel coming to rest goes back to sclang', () => {
  const { d, sent } = rig();
  populate(d);
  assert.strictEqual(d.setParam('kick', 0, 'Cutoff', 0.5, 1000.15), false, 'no ramp yet: sclang builds it');
  d.handle(msg('ramp', 'kick', 'slot0_Cutoff', 3001, 0, 1));
  assert.ok(d.setParam('kick', 0, 'Cutoff', 1.4, 1000.15));
  assert.deepStrictEqual(flat(sent[0])[0], { address: '/n_set', args: [3001, 'target', 1] }, 'a plugin value is clipped to 0..1');
  d.handle(msg('ramp', 'kick', 'slot-1_gain', 3002, -1, 1, 1));
  assert.ok(d.setParam('kick', -1, 'gain', 1.5, 1000.15), 'a channel value is not clipped');
  assert.strictEqual(d.setParam('kick', -1, 'gain', 1, 1000.2), false, 'the rest value schedules the drop sclang-side');
  assert.strictEqual(d.setParam('kick', -1, 'gain', 0.5, 1000.25), false, '...so what follows has to go there too');
  d.handle(msg('ramp', 'kick', 'slot0_Cutoff', 0, 0, 0));
  assert.strictEqual(d.setParam('kick', 0, 'Cutoff', 0.2, 1000.3), false, 'a dropped ramp is never written');
});

test('an event with no lead is sent unstamped, as bundleNow does', () => {
  const { d, sent } = rig();
  populate(d);
  d.handle(msg('ramp', 'kick', 'slot0_Cutoff', 3001, 0, 1));
  d.setParam('kick', 0, 'Cutoff', 0.5, 1000.0005);
  assert.deepStrictEqual(sent[0].timeTag.raw, [0, 1]);
});

test('a deck player starts where sclang would have put it, and later sets wait for the spawn', () => {
  const { d, sent, told } = rig();
  populate(d);
  d.songLoaded('kick', { bufnum: 9, channels: 2, sampleRate: 44100, frames: 44100 * 60 });
  assert.ok(d.songStart('kick', 10, 1, 1000.2, 0));
  const spawn = flat(sent[0])[0];
  assert.strictEqual(spawn.args[0], 'poptart_song_2');
  assert.strictEqual(spawn.args[3], 1001, 'a player goes at the head of the track group');
  const seekFrame = spawn.args[spawn.args.indexOf('seekFrame') + 1];
  assert.strictEqual(seekFrame, 441000);
  assert.ok(Math.abs(secondsOf(sent[0].timeTag) - 1000.2) < 1e-6);
  assert.strictEqual(told.at(-1)[0], '/poptart/direct/song');
  d.songSet('kick', 'rate', 1.01, 1000.1);
  assert.ok(Math.abs(secondsOf(sent[1].timeTag) - 1000.22) < 1e-6, 'a set aimed before the spawn would hit nothing');
  d.songStop('kick', 1000.5);
  assert.strictEqual(d.songSet('kick', 'rate', 1, 1000.6), true);
  assert.strictEqual(sent.length, 3, 'a stopped deck has no player to set');
});

test('the engine sends a note direct when it can and through sclang when it cannot', () => {
  const engine = new OscEngine();
  const viaLang = [];
  const direct = [];
  engine._port = {
    send: (p) => viaLang.push(p.address),
    sendRaw: (bytes, host, port) => direct.push([osc.readPacket(bytes, {}), port]),
  };
  engine.noteOn('kick', 60, 1, engine.getTime() + 0.15);
  assert.deepStrictEqual(viaLang, ['/poptart/noteOn'], 'nothing known yet: the old path');
  populate(engine._direct);
  viaLang.length = 0;
  engine.noteOn('kick', 60, 1, engine.getTime() + 0.15);
  assert.strictEqual(direct.length, 1);
  assert.strictEqual(direct[0][1], 57110, 'sent to scsynth\'s own port');
  assert.deepStrictEqual(viaLang, ['/poptart/direct/note'], 'sclang only hears about it');
  engine._directOn = false;
  engine.noteOn('kick', 60, 1, engine.getTime() + 0.15);
  assert.deepStrictEqual(viaLang.slice(1), ['/poptart/noteOn'], 'POPTART_DIRECT=0 is the old path throughout');
  engine._direct.stop();
});

test('a failure scsynth reports to Node reaches sclang\'s repair, and the ramp is forgotten', () => {
  const engine = new OscEngine();
  const viaLang = [];
  engine._port = { send: (p) => viaLang.push([p.address, ...p.args.map((a) => a.value)]), sendRaw: () => {} };
  populate(engine._direct);
  engine._direct.handle(msg('ramp', 'kick', 'slot0_Cutoff', 3001, 0, 1));
  engine._handleMessage({ address: '/fail', args: [{ type: 's', value: '/n_set' }, { type: 's', value: 'Node 3001 not found' }] });
  assert.deepStrictEqual(viaLang, [['/poptart/fail', '/n_set', 'Node 3001 not found']]);
  assert.strictEqual(engine._direct.setParam('kick', 0, 'Cutoff', 0.5, engine.getTime() + 0.1), false);
});
