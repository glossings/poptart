// Feedback routing: a loop between tracks or through a bus gets one render quantum of delay on
// the edge that closes it, chosen as the desktop's trackLevels chooses the edge it drops.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';

function makeEngine() {
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, routeWaitMs: 1, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog) });
  return { ctx, engine };
}

const delayed = (engine) => [...engine.routes.edges].filter((e) => e.delay).map((e) => `${e.src}>${e.dst}`);

test('a pair of tracks reading each other is a loop with one delayed edge', () => {
  const { engine } = makeEngine();
  engine.createTrack('a');
  engine.createTrack('b');
  engine.setInputSource('a', 'audio', 'b');
  assert.deepEqual(delayed(engine), [], 'one way round is no loop');
  engine.setInputSource('b', 'audio', 'a');
  // The walk starts at a, goes up to b, and finds a again: b's read of a closes the loop.
  assert.deepEqual(delayed(engine), ['t:a>t:b']);
  const edge = [...engine.routes.edges].find((e) => e.delay);
  // Zero, which every browser holds to one render quantum inside a loop.
  assert.equal(edge.delay.delayTime.value, 0);
  const a = engine.tracks.get('a');
  const b = engine.tracks.get('b');
  assert.ok(!a.panner.outputs.includes(b.input), 'not wired straight, which the browser would mute');
  assert.ok(a.panner.outputs.includes(edge.delay) && edge.delay.outputs.includes(b.input));
  assert.ok(b.panner.outputs.includes(a.input), 'the other way is straight');
  // Undo the loop and the delay goes with it.
  engine.clearInputSource('b');
  assert.deepEqual(delayed(engine), []);
  assert.equal(edge.live, false);
  assert.equal(edge.delay.outputs.length, 0, 'and is out of the graph');
});

test('a track sending to the bus it reads is a loop too', () => {
  const { engine } = makeEngine();
  engine.createTrack('fb');
  engine.setInputSource('fb', 'audio', 'bus:echo');
  engine.setBusSends('fb', [{ name: 'echo', amount: 0.5 }]);
  assert.deepEqual(delayed(engine), ['t:fb>b:echo']);
  engine.clearBusSends('fb');
  assert.deepEqual(delayed(engine), []);
});

test('a loop of three has one delay; a chain feeding it, none', () => {
  const { engine } = makeEngine();
  for (const id of ['src', 'a', 'b', 'c']) engine.createTrack(id);
  engine.setInputSource('a', 'audio', 'c');
  engine.setInputSource('b', 'audio', 'a');
  engine.setInputSource('c', 'audio', 'b');
  engine.loadEffect('a', 'Ducker', 1);
  engine.injectAudio('a', 1, 'src');
  assert.equal(delayed(engine).length, 1);
});

test('the DJ FX send and a sidechain count as routes', () => {
  const { engine } = makeEngine();
  engine.createTrack('deck');
  engine.createTrack('ret');
  engine.setInputSource('ret', 'audio', 'bus:fx');
  engine.setFxSend('deck', 'fx', 1);
  assert.deepEqual(delayed(engine), []);
  // The return keying a ducker on the deck closes a loop through the FX bus.
  engine.loadEffect('deck', 'Ducker', 1);
  engine.injectAudio('deck', 1, 'ret');
  assert.equal(delayed(engine).length, 1);
  engine.clearAudioInject('deck', 1);
  assert.deepEqual(delayed(engine), []);
});

test('a track reading its own name reads the bus of that name, as on the desktop', () => {
  const { engine } = makeEngine();
  engine.createTrack('drums');
  engine._bus('drums');
  engine.setInputSource('drums', 'audio', 'drums');
  const track = engine.tracks.get('drums');
  assert.ok(track._headSource === engine.buses.get('drums'));
});

test('a track that goes away takes its routes with it', () => {
  const { engine } = makeEngine();
  engine.createTrack('a');
  engine.createTrack('b');
  engine.setInputSource('a', 'audio', 'b');
  engine.setInputSource('b', 'audio', 'a');
  engine.destroyTrack('b');
  assert.equal([...engine.routes.edges].some((e) => e.src === 't:b' || e.dst === 't:b'), false);
  assert.deepEqual(delayed(engine), []);
});
