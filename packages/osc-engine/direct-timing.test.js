'use strict';

// Notes and parameter changes land on their sample (direct.js and the engine's own handler).
//
// A real-time scsynth with the engine on it. Every event is played twice: a REFERENCE voice, sent
// straight to scsynth before anything starts, and the voice under test, sent a lookahead early the
// way the scheduler sends it - either the direct way (DirectPath) or through the engine's
// /poptart/playSample handler (engine/sampler.js). The onset difference against the reference is
// the timing error, and it must be zero. A parameter (/n_set onto a synth, as a ramp's target is
// moved) lands on a block edge, so it is allowed up to a block early and no later.
//
// Needs an audio device: skipped (not failed) without one. Nothing sounds - private buses.

const { test } = require('node:test');
const assert = require('node:assert');
const { bootEngine, skipReason } = require('./test-support/scsynth');
const { DirectPath } = require('./direct');
const { Synth, Buffer, Bus } = require('./server/objects');
const { stepDef, sendRigDefs } = require('./test-support/rig-defs');
const { startRecording } = require('./test-support/record');

const LOOKAHEAD = 0.15; // DEFAULT_LOOKAHEAD_SEC in the scheduler
const SPACING = 0.3;
const EVENTS = 24;
const CONDITIONS = ['direct', 'engine'];
const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'notes', 'sampler'];

test('notes and parameter changes land on their sample, direct and through the engine', { timeout: 120000 }, async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const rig = await bootEngine({ port: 57476, sections: SECTIONS });
  const { S, E } = rig;
  const now = () => Date.now() / 1000;
  const d = new DirectPath({ sendRaw: (b) => S.sendRaw(b), tell: () => {}, now });
  try {
    const sr = S.sampleRate;
    await sendRigDefs(S, [stepDef()]);
    const lanes = Bus.audio(S, 6); // 0-1 the voice under test, 2-3 the reference, 4 the parameter
    const bend = Bus.control(S, 1);
    bend.set(0);
    const dc = Buffer.alloc(S, 48000, 1);
    await dc.ready;
    S.send(['/b_fill', dc.bufnum, 0, 48000, 1]);
    await S.sync();
    await dc.query();
    // A high block of ids for the direct path, clear of the engine's allocator.
    const block = 31 * 2 ** 26;
    d.handle({ address: '/poptart/ids/server', args: [S.options.port, block + 1000, block + 0x03FFFFFF, sr, 0, 80] });
    d.handle({ address: '/poptart/ids/track', args: ['test', 1, 1, lanes.index, bend.index, 0] });
    d.handle({ address: '/poptart/ids/track', args: ['ref', 1, 1, lanes.index + 2, bend.index, 0] });
    // The engine's own path: a track as far as playSample reads one, and the buffer as a pack.
    E.tracks.set('eng', {
      key: 'eng', inBus: { index: lanes.index }, voices: S.defaultGroup, group: S.defaultGroup, bendBus: bend,
      envs: new Map(), lfos: new Map(), held: 0,
    });
    E.samplePacks.set('dc', [dc]);

    const stop = await startRecording(S, lanes.index, 6);
    const T0 = now() + 0.4;
    const paramNode = S.nextNodeID();
    S.send(['/s_new', 'poptart_test_step', paramNode, 0, 1, 'out', lanes.index + 4]);
    await S.sync();
    d.handle({ address: '/poptart/ids/ramp', args: ['test', 'slot0_x', paramNode, 0, 1] });
    const voice = (onsetSec) => ({
      bufnum: dc.bufnum, channels: 1, begin: 0, end: 1, loop: 0, rate: 1, stretch: 1, dur: 0.03,
      onsetSec, offsetSec: onsetSec + 0.03, amp: 1, cut: 0, atk: 0, dec: 0, sus: 1, rel: 0.005,
    });
    const times = Array.from({ length: EVENTS }, (_, k) => T0 + 0.4 + k * SPACING + Math.random() * (256 / sr));
    for (const tk of times) d.playSample('ref', voice(tk)); // every reference, up front
    await Promise.all(times.map((tk, k) => new Promise((resolve) => {
      setTimeout(() => {
        const value = k % 2 === 0 ? 1 : 0;
        if (CONDITIONS[k % 2] === 'direct') {
          d.playSample('test', voice(tk));
        } else {
          const lat = Math.max(0, tk - now());
          E.dispatch('/poptart/playSample', ['eng', 'dc', 0, 0, 1, 0, 1, 1, 0.03, lat, lat + 0.03, 1, 0, 0, 0, 1, 0.005]);
        }
        d.setParam('test', 0, 'x', value, tk);
        resolve();
      }, (tk - LOOKAHEAD - now()) * 1000);
    })));
    await new Promise((r) => setTimeout(r, (times.at(-1) - now() + 0.5) * 1000));
    const r = await stop();
    assert.ok(r.frames > 0, 'unreadable recording');
    const firstAbove = (ch, from, to, thr) => {
      for (let i = Math.max(0, from); i < Math.min(r.frames, to); i++) if (Math.abs(r.at(ch, i)) > thr) return i;
      return -1;
    };
    const edge = (from, to, rising) => {
      for (let i = Math.max(1, from); i < Math.min(r.frames, to); i++) if ((r.at(4, i) > 0.5) === rising && (r.at(4, i - 1) > 0.5) !== rising) return i;
      return -1;
    };
    // The recording's frame 0 is unknown in wall time: line it up on the first reference.
    const firstRef = firstAbove(2, 0, r.frames, 1e-6);
    assert.ok(firstRef >= 0, 'no reference voice sounded');
    const stats = Object.fromEntries(CONDITIONS.map((c) => [c, { voice: [], param: [] }]));
    times.forEach((tk, k) => {
      const approx = firstRef + Math.round((tk - times[0]) * sr);
      const ref = firstAbove(2, approx - 4096, approx + 4096, 1e-6);
      assert.ok(ref >= 0, `reference voice ${k} never sounded`);
      const got = firstAbove(0, ref - 2048, ref + Math.round((SPACING - 0.02) * sr), 1e-6);
      assert.ok(got >= 0, `voice ${k} never sounded`);
      const step = edge(ref - 2048, ref + Math.round((SPACING - 0.02) * sr), k % 2 === 0);
      assert.ok(step >= 0, `parameter change ${k} never landed`);
      const s = stats[CONDITIONS[k % 2]];
      s.voice.push(got - ref);
      s.param.push(step - (ref - 1)); // the reference's first sounding sample is one past its time
    });
    const ms = (x) => ((x / sr) * 1000).toFixed(2);
    for (const [c, s] of Object.entries(stats)) {
      const span = (xs) => `min ${ms(Math.min(...xs))} / max ${ms(Math.max(...xs))} ms`;
      t.diagnostic(`${c.padEnd(8)} voice: ${span(s.voice)}   param: ${span(s.param)}`);
    }
    // The direct path stamps the onset itself: exact.
    assert.deepStrictEqual(stats.direct.voice, stats.direct.voice.map(() => 0), `direct: voices off their sample by ${stats.direct.voice.join(', ')}`);
    // The engine's handler gets a latency (seconds from now) as sclang did, and turns it back into
    // a time with Date.now(): both ends read a millisecond clock, so an onset can land a tick of it
    // late (two when the reads straddle one) - never early.
    const ms2 = Math.ceil((2 * sr) / 1000);
    for (const e of stats.engine.voice) assert.ok(e >= 0 && e <= ms2, `engine: a voice landed ${e} samples from its sample`);
    for (const c of CONDITIONS) {
      for (const e of stats[c].param) assert.ok(e <= 0 && e > -256, `${c}: a parameter landed ${e} samples from its block`);
    }
  } finally {
    d.stop();
    await rig.quit();
  }
});
