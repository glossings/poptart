'use strict';

// The view taps on the Node engine (engine/view-taps.js), read the way OscEngine reads them: a
// ViewTaps (view-taps.js) arms them through the engine's '/poptart/viewTaps', reads the ring and
// the FFT frame straight from scsynth with /b_getn, and gets the answers off the server's socket.
// What this guards, as view-tap-sclang.test.js does for the sclang path: the ring unrolled from the
// head the tap reports is one continuous stretch of the track's signal, the spectrum puts a sine in
// its bin, and the taps go with their track and with the last display.
//
// Needs scsynth (sandbox off, port 57406); skipped without it. scsynth runs silent (POPTART_SILENT).

const { test } = require('node:test');
const assert = require('node:assert');
const osc = require('osc');
const { bootEngine, skipReason, toldWhen } = require('./test-support/scsynth');
const { sendDefs } = require('./server/defs');
const { Synth } = require('./server/objects');
const { ugen, G } = require('./test-support/nrt');
const U = require('./synthdef/ugens');
const { ViewTaps } = require('./view-taps');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'mixer', 'view-taps'];
const SinOsc = ugen('SinOsc', [440, 0]);
const HZ = 700;
const AMP = 0.25;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function until(what, fn, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await wait(0.02);
  }
}

test('a track\'s view tap delivers its scope and spectrum, and goes with the track', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const env = await bootEngine({ port: 57406, sections: SECTIONS });
  const { S, E, told, quit } = env;
  try {
    // What OscEngine wires in node mode: the engine's answers and the server's replies both reach
    // the reader, and its reads go straight to scsynth.
    const views = new ViewTaps({
      sendSc: (address, args) => E.dispatch(address, args),
      sendScsynth: (packet) => S.sendRaw(osc.writePacket(packet, { metadata: true })),
    });
    const tell = E._tell;
    E._tell = (address, args) => { tell(address, args); views.handle({ address, args }); };
    for (const address of ['/b_setn', '/c_set']) S.on(address, (args) => views.handle({ address, args }));

    const tone = new G.SynthDef('view_tone', { bus: 0 }, (c) => {
      const s = G.mul(SinOsc.ar(HZ, 0), AMP);
      U.Out.ar(c.bus, [s, G.mul(s, 0.5)]);
    });
    await sendDefs(S, [{ def: tone }]);

    // Armed before the track exists: its birth starts the tap.
    views.arm([{ id: 'v', fft: true }, { id: '*', fft: false }]);
    E.dispatch('/poptart/createTrack', ['v', 'dry', 0]);
    const track = await until('track v', () => (E.isTrack(E.tracks.get('v')) ? E.tracks.get('v') : null));
    Synth.new(S, 'view_tone', ['bus', track.inBus.index], track.group, 'addToHead');
    await S.sync();

    const told1 = await toldWhen(told, '/poptart/viewTap', (a) => a[0] === 'v');
    assert.ok(told1.args[3] >= 0, 'the track tap has an FFT buffer');
    await toldWhen(told, '/poptart/viewTap', (a) => a[0] === '*' && a[3] === -1);
    assert.ok(track.taps.has('view'), 'the strip has its view tap');

    // Frames once the ring has filled with the tone.
    await wait(0.3);
    const frame = await until('a frame with the tone', () => {
      const f = views.read().v;
      return f?.scope && f?.spec && f.level.pl > 0.1 ? f : null;
    });
    assert.ok(views.read()['*']?.scope, 'the master tap delivers a scope too');
    assert.strictEqual(views.read()['*'].spec, undefined, 'the master was asked for no spectrum');

    const { l, r, rate } = frame.scope;
    assert.strictEqual(l.length, 1024);
    assert.strictEqual(rate, S.sampleRate / 2);
    // A sine obeys x[i-1] + x[i+1] = 2cos(w) x[i] everywhere; a seam in the wrong place breaks it.
    // The samples arrive rounded to 3 places (view-taps.js), so the residual allows for that.
    const w = (2 * Math.PI * HZ) / rate;
    let worst = 0;
    for (let i = 1; i < l.length - 1; i++) worst = Math.max(worst, Math.abs(l[i - 1] + l[i + 1] - 2 * Math.cos(w) * l[i]));
    assert.ok(worst < 5e-3, `the unrolled ring is not one stretch of the sine (worst residual ${worst.toFixed(4)})`);
    assert.ok(frame.level.pl > AMP * 0.9 && frame.level.pl < AMP * 1.1, `the scope's peak is the tone's (${frame.level.pl})`);
    for (let i = 0; i < l.length; i++) assert.ok(Math.abs(r[i] - l[i] * 0.5) < 2e-3, 'the right side is the right channel');

    const { db, binHz } = frame.spec;
    let peak = 1;
    for (let k = 1; k < db.length; k++) if (db[k] > db[peak]) peak = k;
    assert.ok(Math.abs(peak - HZ / binHz) <= 1, `the sine landed in bin ${peak}, not ${HZ / binHz}`);
    // The mono sum is 0.75 of the tone's amplitude: about -14.5 dB on the display's scale.
    const want = 20 * Math.log10(AMP * 0.75);
    assert.ok(Math.abs(db[peak] - want) < 2, `the sine reads ${db[peak]} dB, not about ${want.toFixed(1)}`);

    // Dropping the spectrum rebuilds the tap without one.
    const before = told.length;
    views.arm([{ id: 'v', fft: false }, { id: '*', fft: false }]);
    await toldWhen(told, '/poptart/viewTapGone', (a) => a[0] === 'v');
    await until('the rebuilt tap', () => told.slice(before).find((m) => m.address === '/poptart/viewTap' && m.args[0] === 'v' && m.args[3] === -1));

    // The track's teardown takes its tap, buffers and all.
    const gone = told.length;
    E.dispatch('/poptart/destroyTrack', ['v']);
    await until('the track tap gone', () => told.slice(gone).find((m) => m.address === '/poptart/viewTapGone' && m.args[0] === 'v'));
    assert.ok(!E.viewTap.taps.has('v'));
    assert.ok(!views.read().v, 'the reader forgot the track');

    // The last display going takes the master's.
    views.arm([]);
    await until('the master tap gone', () => !E.viewTap.taps.size);
    assert.deepStrictEqual(views.read(), {});
    views.reset();
  } finally {
    await quit();
  }
});
