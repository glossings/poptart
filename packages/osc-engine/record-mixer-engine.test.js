'use strict';

// The record and mixer handlers on the Node engine (engine/record.js, engine/mixer.js), driven as
// OscEngine drives them: a tap streams the record panel's meter, a bounce writes a file with audio
// in it, the master recording writes one too, and the mixer taps the playing tracks and the master
// and takes them down again.
//
// Needs scsynth and an audio device (sandbox off, ports 57404-57405); skipped without them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootEngine, skipReason, toldWhen } = require('./test-support/scsynth');
const { sendDefs } = require('./server/defs');
const { Synth } = require('./server/objects');
const { ugen, G } = require('./test-support/nrt');
const U = require('./synthdef/ugens');
const { MIX_BAND_FREQS } = require('./index.js');
const { readWavRaw } = require('./wav');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'record', 'mixer'];
const SinOsc = ugen('SinOsc', [440, 0]);
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function trackOf(E, key) {
  for (let i = 0; i < 100; i++) {
    const t = E.tracks.get(key);
    if (E.isTrack(t)) return t;
    await wait(0.02);
  }
  throw new Error(`track ${key} never built`);
}

/** A track with a tone on its input bus (born dry 0, so nothing reaches the outputs). */
async function toneTrack(S, E, key) {
  const tone = new G.SynthDef('rec_tone', { bus: 0 }, (c) => {
    const s = G.mul(SinOsc.ar(440, 0), 0.25);
    U.Out.ar(c.bus, [s, s]);
  });
  await sendDefs(S, [{ def: tone }]);
  E.dispatch('/poptart/createTrack', [key, 'dry', 0]);
  const t = await trackOf(E, key);
  Synth.new(S, 'rec_tone', ['bus', t.inBus.index], t.group, 'addToHead');
  await S.sync();
  return t;
}

let requestId = 1;
async function ask(E, told, address, args, timeoutMs = 20000) {
  const id = requestId++;
  E.dispatch(address, [id, ...args]);
  const m = await toldWhen(told, `${address}.reply`, (a) => a[0] === id, timeoutMs);
  const json = fs.readFileSync(m.args[1], 'utf8');
  fs.unlinkSync(m.args[1]);
  return JSON.parse(json);
}

test('a tap meters the track, a bounce writes its audio, and the master recording writes a file', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const env = await bootEngine({ port: 57404, sections: SECTIONS });
  const { S, E, told, quit } = env;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-rec-'));
  try {
    await toneTrack(S, E, 'r');
    E.dispatch('/poptart/tapTrack', ['r', 1]);
    const level = await toldWhen(told, '/poptart/recLevel', (a) => a[0] === 'r' && a[1] > 0.1);
    assert.ok(level.args[1] <= 0.3 && level.args[2] > 0.05, `the meter reads the tone (${level.args})`);

    const file = path.join(dir, 'bounce.wav');
    const res = await ask(E, told, '/poptart/recordTrack', ['r', file, 0.1, 0.6]);
    assert.strictEqual(res.path, file);
    assert.ok(res.frames > 0, 'the bounce wrote no frames');
    const wav = readWavRaw(file);
    let peak = 0;
    for (const v of wav.data) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.2 && peak < 0.3, `the bounce holds the tone (peak ${peak})`);
    assert.strictEqual(E.recTaps.get('r').buf, null, 'the bounce buffer was not freed');

    E.dispatch('/poptart/tapTrack', ['r', 0]);
    await wait(0.05);
    assert.strictEqual(E.recTaps.get('r'), undefined, 'the tap did not come down');

    const master = path.join(dir, 'master.wav');
    const m = await ask(E, told, '/poptart/record', [master, 0.3], 5000);
    assert.strictEqual(m.path, master);
    for (let i = 0; i < 50 && E.masterRec; i++) await wait(0.02);
    const mw = readWavRaw(master);
    assert.ok(mw && mw.channels === 2 && mw.data.length / 2 > 0.2 * 48000, 'the master recording is not a stereo file of the asked length');
  } finally {
    await quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mixer taps the wanted tracks and the master, and takes them down', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const env = await bootEngine({ port: 57405, sections: SECTIONS });
  const { S, E, told, quit } = env;
  try {
    await toneTrack(S, E, 'm');
    E.dispatch('/poptart/mixMeters', [1, JSON.stringify(MIX_BAND_FREQS), JSON.stringify(['m', 'absent'])]);
    const lvl = await toldWhen(told, '/poptart/mixLevel', (a) => a[0] === 'm' && a[1] > 0.1, 8000);
    assert.ok(lvl.args[1] < 0.3, `the track meter reads the tone (${lvl.args})`);
    await toldWhen(told, '/poptart/mixLevel', (a) => a[0] === '*', 8000);
    const spec = await toldWhen(told, '/poptart/mixSpec', (a) => a[0] === 'm', 8000);
    assert.ok(spec.args.length > 1, 'no band values');
    assert.ok(E.mixTaps.has('m') && !E.mixTaps.has('absent'), 'only an existing wanted track is tapped');
    assert.ok(E.mixMaster, 'the master analyzer is not running');
    // The playing set changes: the track drops out, the master stays.
    E.dispatch('/poptart/mixMeters', [1, JSON.stringify(MIX_BAND_FREQS), JSON.stringify([])]);
    for (let i = 0; i < 50 && E.mixTaps.has('m'); i++) await wait(0.02);
    assert.ok(!E.mixTaps.has('m') && E.mixMaster, 'the dropped track kept its tap, or the master went');
    E.dispatch('/poptart/mixMeters', [0]);
    for (let i = 0; i < 50 && E.mixMaster; i++) await wait(0.02);
    assert.strictEqual(E.mixMaster, null, 'the master analyzer stayed up');
    // Headphones on an engine with no cue pair: held, nothing to set.
    E.dispatch('/poptart/headphones', [0.5, 0.25]);
    assert.deepStrictEqual([E.headphoneLevel, E.headphoneMix], [0.5, 0.25]);
  } finally {
    await quit();
  }
});
