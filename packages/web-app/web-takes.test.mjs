// What a bounce becomes: the desktop's trim, fold and level rules on the page's frames, the
// file it is kept as, and the recorder that arms, captures and keeps it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeWav, finishTake, mintName, sanitizeName, trimWindow } from './public/web/takes.mjs';
import { createTrackRecorder } from './public/web/track-record.mjs';

const SR = 1000;
const capture = (frames, fn) => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { left[i] = fn(i); right[i] = fn(i); }
  return { sampleRate: SR, channels: 2, frames, left, right };
};

test('a folded tail lands on the head, its own end faded, never more than the window', () => {
  const src = { sampleRate: SR, channels: 1, frames: 30, data: Float32Array.from({ length: 30 }, (_, i) => (i < 10 ? 0 : 1)) };
  const out = trimWindow(src, { startFrame: 0, lengthFrames: 10, wrapTail: true });
  assert.equal(out.frames, 10);
  assert.equal(out.data[0], 1, 'the tail starts at full level');
  assert.equal(out.data[9], 0, 'and fades to nothing by the end of what is folded');
  const plain = trimWindow(src, { startFrame: 0, lengthFrames: 10 });
  assert.equal(plain.data[0], 0, 'off by default');
});

test('a take is leveled to -1 dBFS and a silent one is left alone and said to be silent', () => {
  const loud = finishTake(capture(2000, (i) => 0.25 * Math.sin(i / 10)), { startSec: 0, lengthSec: 2 });
  assert.ok(Math.abs(loud.info.gainDb - (20 * Math.log10(10 ** (-1 / 20) / 0.25))) < 0.05);
  assert.equal(loud.info.silent, false);
  assert.equal(loud.info.frames, 2000);
  assert.equal(loud.info.peaks.length, 1520);
  const quiet = finishTake(capture(2000, () => 0), { startSec: 0, lengthSec: 2 });
  assert.equal(quiet.info.gainDb, 0);
  assert.equal(quiet.info.silent, true);
});

test('the file is 24-bit PCM, and a sample past full scale saturates', () => {
  const bytes = encodeWav({ sampleRate: 48000, channels: 1, data: Float32Array.from([2, -2]) });
  const view = new DataView(bytes);
  assert.equal(String.fromCharCode(...new Uint8Array(bytes, 0, 4)), 'RIFF');
  assert.equal(view.getUint16(34, true), 24);
  assert.equal(view.getUint32(40, true), 6);
  const s0 = view.getUint8(44) | (view.getUint8(45) << 8) | (view.getInt8(46) << 16);
  const s1 = view.getUint8(47) | (view.getUint8(48) << 8) | (view.getInt8(49) << 16);
  assert.equal(s0, 0x7fffff);
  assert.equal(s1, -0x7fffff);
});

test('names follow the desktop\'s rules and never collide', () => {
  assert.equal(sanitizeName('bass line!'), 'bass-line');
  assert.equal(sanitizeName('808'), 't808', 'a bare number is a value, not a name');
  assert.equal(sanitizeName('r'), 'r-take');
  assert.equal(sanitizeName(''), 'take');
  assert.equal(mintName('bass', ['bass', 'bass-2']), 'bass-3');
});

test('a bounce arms on the next phrase, records its window, and is kept under its label', async () => {
  let now = 0;
  const kept = [];
  let resolveTake;
  const recorded = [];
  const engine = {
    tracks: new Map([['t1', {}]]),
    getTime: () => now,
    tapTrack: () => true,
    recordTrack: (id, start, end) => {
      recorded.push([id, start, end]);
      const p = new Promise((r) => { resolveTake = r; });
      p.cancel = () => {};
      return p;
    },
  };
  const transport = { cycleAt: (t) => t * 0.5, secAt: (c) => c / 0.5 };
  const rec = createTrackRecorder({
    engine, transport,
    idOf: (label) => (label === 'bass' ? 't1' : label),
    labelOf: (id) => (id === 't1' ? 'bass' : id),
    snapshot: () => ({}),
    finishTake,
    mintName,
    names: () => kept.map(([n]) => n),
    keep: async (name, bytes) => { kept.push([name, bytes.byteLength]); },
  });
  now = 1;
  const armed = rec.start({ label: 'bass', cycles: 2 });
  assert.equal(armed.phase, 'armed');
  assert.equal(armed.startCycle, 4, 'the next phrase');
  assert.deepEqual(recorded, [['t1', 8, 12]], 'the window, on the audio clock, with no tail asked for');
  assert.throws(() => rec.start({ label: 'bass' }), /already armed/);
  resolveTake(capture(4000, (i) => 0.5 * Math.sin(i)));
  await new Promise((r) => setTimeout(r, 0));
  const done = rec.status();
  assert.equal(done.phase, 'done');
  assert.equal(done.result.name, 'bass');
  assert.equal(done.result.cycles, 2);
  assert.equal(kept[0][0], 'bass');
  rec.cancel();
  assert.equal(rec.status().phase, 'idle');
  assert.throws(() => rec.start({ label: 'nothing' }), /isn't playing/);
});

test('an open panel meters its track, and each poll drains what came in', () => {
  const engine = { tracks: new Map(), getTime: () => 0, tapTrack: () => true };
  const rec = createTrackRecorder({ engine, transport: {}, idOf: (l) => l, labelOf: (id) => id, snapshot: () => ({}), finishTake, mintName, names: () => [], keep: async () => {} });
  rec.tap('bass', true);
  engine.onRecLevel('bass', 0.5, 0.2);
  engine.onRecLevel('bass', 0.6, 0.3);
  assert.deepEqual(rec.status().levels.bass, [{ peak: 0.5, rms: 0.2 }, { peak: 0.6, rms: 0.3 }]);
  assert.deepEqual(rec.status().levels.bass, [], 'drained');
});
