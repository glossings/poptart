'use strict';

// The desktop's view taps (view-taps.js): what is asked of sclang, what is read from scsynth, and
// how the replies become frames. No engine is started - the two senders are recorded and the
// replies handed in as scsynth would send them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ViewTaps, fftDecibels } = require('./view-taps');

const f = (value) => ({ type: 'f', value });
const i = (value) => ({ type: 'i', value });

function rig() {
  const sc = [];
  const synth = [];
  const taps = new ViewTaps({
    sendSc: (address, args) => sc.push({ address, args }),
    sendScsynth: (packet, port) => synth.push({ packet, port }),
  });
  return { taps, sc, synth };
}

test('arming asks sclang for the set once, every track asked for included', () => {
  const { taps, sc } = rig();
  const list = [{ id: '*' }, ...Array.from({ length: 12 }, (_, k) => ({ id: `t${k}`, fft: k === 0 }))];
  const res = taps.arm(list);
  assert.deepEqual(res.armed, ['*', ...Array.from({ length: 12 }, (_, k) => `t${k}`)]);
  assert.deepEqual(res.over, []);
  assert.deepEqual(sc, [{ address: '/poptart/viewTaps', args: ['*', 0, ...Array.from({ length: 12 }, (_, k) => [`t${k}`, k === 0 ? 1 : 0]).flat()] }]);
  taps.arm(list);
  assert.equal(sc.length, 1);
  taps.arm([]);
  assert.deepEqual(sc.at(-1), { address: '/poptart/viewTaps', args: [] });
  taps.reset();
});

test('a tap is read straight from scsynth, ring and head in one bundle', () => {
  const { taps, synth } = rig();
  taps.arm([{ id: 'kick', fft: true }]);
  taps.handle({ address: '/poptart/viewTap', args: [{ type: 's', value: 'kick' }, i(12), i(40), i(13), i(1024), i(2), f(48000), i(57110)] });
  taps._poll();
  taps._poll();
  const [first, second] = synth;
  assert.equal(first.port, 57110);
  assert.deepEqual(first.packet.packets.map((p) => [p.address, ...p.args.map((a) => a.value)]), [
    ['/b_getn', 12, 0, 1024], ['/b_getn', 12, 1024, 1024], ['/c_get', 40],
  ]);
  // The spectrum every other read.
  assert.deepEqual(second.packet.packets.slice(3).map((p) => [p.address, ...p.args.map((a) => a.value)]), [
    ['/b_getn', 13, 0, 1024], ['/b_getn', 13, 1024, 1024],
  ]);
  taps.reset();
});

test('the ring is unrolled from just after its newest frame', () => {
  const { taps } = rig();
  taps.arm([{ id: 'a' }]);
  taps.handle({ address: '/poptart/viewTap', args: ['a', 1, 2, -1, 4, 2, 48000, 57110].map((v) => (typeof v === 'string' ? v : i(v))) });
  // Four stereo frames, left = frame number, right = minus it.
  const ring = [0, -0, 1, -1, 2, -2, 3, -3];
  assert.equal(taps.handle({ address: '/b_setn', args: [i(1), i(0), i(8), ...ring.map(f)] }), true);
  taps.handle({ address: '/c_set', args: [i(2), f(1.75)] }); // newest frame written is 1
  const frame = taps.read().a;
  assert.deepEqual(frame.scope.l, [2, 3, 0, 1]);
  assert.deepEqual(frame.scope.r, [-2, -3, -0, -1]);
  assert.equal(frame.scope.rate, 24000);
  assert.equal(frame.level.pl, 3);
  taps.reset();
});

test('a spectrum frame reads 0 dB for a full-scale sine', () => {
  const n = 2048;
  const k = 64;
  // A Hann-windowed unit sine centered on bin k: what FFT leaves is N/4 there (as re/im).
  const data = new Float32Array(n);
  data[2 * k] = n / 4;
  assert.equal(fftDecibels(data)[k], 0);
  assert.equal(fftDecibels(data)[k + 3], -140);
});

test('a tap that goes away stops being read, and a stray reply is still consumed', () => {
  const { taps, synth } = rig();
  taps.arm([{ id: 'a' }]);
  taps.handle({ address: '/poptart/viewTap', args: ['a', 1, 2, -1, 4, 2, 48000, 57110].map((v) => (typeof v === 'string' ? v : i(v))) });
  taps.handle({ address: '/poptart/viewTapGone', args: ['a'] });
  taps._poll();
  assert.equal(synth.length, 0);
  assert.equal(taps.handle({ address: '/b_setn', args: [i(1), i(0), i(1), f(0)] }), true);
  assert.equal(taps.handle({ address: '/fail', args: ['/b_getn', 'index out of range'] }), true);
  assert.equal(taps.handle({ address: '/poptart/recLevel', args: [] }), false);
  taps.reset();
});
