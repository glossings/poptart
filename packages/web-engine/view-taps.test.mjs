// The browser engine's view taps (src/engine/view-taps.mjs) - what the editor's inline .scope(),
// .spectrum(), .waveform(), .imager() and .meter() read. Against the stand-in audio graph: the
// wiring, the budget and the frame's shape are checked here; the numbers come from the browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-context.mjs';
import { ViewTaps, VIEW_DECIM } from './src/engine/view-taps.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { catalog } from './src/catalog.mjs';

function rig() {
  const ctx = new FakeAudioContext();
  const master = ctx.createGain();
  const tracks = new Map();
  const views = new ViewTaps(ctx, (id) => (id === '*' ? master : tracks.get(id) ?? null));
  return { ctx, master, tracks, views };
}

test('a tap is built on the first read and hands back a frame in the shared shape', () => {
  const { ctx, tracks, views } = rig();
  tracks.set('#1', ctx.createGain());
  assert.deepEqual(views.arm([{ id: '#1', fft: true }]), { armed: ['#1'], over: [] });
  const analysers = () => ctx.created.filter((n) => n.kind === 'analyser');
  assert.equal(analysers().length, 0); // nothing until somebody looks
  views.read();
  for (const a of analysers()) a.feed(0.5, -40);
  const f = views.read()['#1'];
  assert.equal(f.scope.rate, ctx.sampleRate / VIEW_DECIM);
  assert.equal(f.scope.l.length, 2048 / VIEW_DECIM);
  assert.deepEqual([f.level.pl, f.level.rl], [0.5, 0.5]);
  assert.equal(f.spec.binHz, ctx.sampleRate / 2048);
  // On the desktop's scale: the AnalyserNode's -40 is -40 plus the Blackman window's coherent gain.
  assert.equal(f.spec.db[10], Math.round((-40 + 20 * Math.log10(2 / 0.42)) * 10) / 10);
});

test('a track not built yet is waited for, and a spectrum only taps the mono sum when asked', () => {
  const { ctx, tracks, views } = rig();
  views.arm([{ id: '#2' }]);
  assert.deepEqual(views.read(), {});
  tracks.set('#2', ctx.createGain());
  const f = views.read()['#2'];
  assert.ok(f.scope && !f.spec);
  assert.equal(ctx.created.filter((n) => n.kind === 'analyser').length, 2);
});

test('the budget is the desktop\'s, and the master is extra', () => {
  const { views } = rig();
  const list = [{ id: '*' }, ...Array.from({ length: 12 }, (_, k) => ({ id: `#${k}` }))];
  const res = views.arm(list);
  assert.equal(res.armed.length, 13, 'every track asked for is armed, plus the master');
  assert.deepEqual(res.over, []);
});

test('disarming takes the tap out of the graph; changing what it needs rebuilds it', () => {
  const { ctx, master, views } = rig();
  views.arm([{ id: '*' }]);
  views.read();
  assert.ok(master.outputs.length > 0);
  views.arm([{ id: '*', fft: true }]);
  views.read();
  assert.ok(views.read()['*'].spec);
  views.arm([]);
  assert.equal(master.outputs.length, 0);
  void ctx;
});

test('the engine forwards both calls and reads the master', () => {
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {} });
  engine.viewTaps([{ id: '*' }]);
  assert.ok(engine.viewRead()['*'].scope);
});
