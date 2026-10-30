// A driven channel control holds to the same range a set one does, as on the desktop (see
// sc/poptart.scd's chanIn and channel-audio-sclang.test.js): width to 0..4, bass mono's cutoff to
// 20 Hz - 2 kHz. Rendered offline from the fake context by the spec's formulas (fake-render.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext } from './fake-context.mjs';
import { renderFake } from './fake-render.mjs';
import { catalog } from './src/catalog.mjs';
import { Track } from './src/engine/track.mjs';

const SR = 48000;
const FRAMES = 256;

function rig() {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const track = new Track(ctx, 't', ctx.createGain(), catalog);
  return { ctx, track };
}

/** A modulator stand-in: a constant at `v` driving the parameter a driven control is handed. */
function drive(ctx, param, v) {
  const src = ctx.createConstantSource();
  src.offset.value = v;
  src.connect(param);
  src.start();
  // What a modulator does to the parameter it is handed (see modulators.mjs): its own value goes.
  param.value = 0;
  return src;
}

const dcLeft = () => [new Float64Array(FRAMES).fill(1), new Float64Array(FRAMES)];
const leftOut = (ctx, track) => renderFake(ctx, track.panner, { frames: FRAMES, inject: new Map([[track.postGain, dcLeft()]]) })[0][FRAMES - 1];

test('a driven width is held to 0..4, as a set one is', () => {
  for (const [v, want] of [[6, 2.5], [-3, 0.5], [2, 1.5]]) {
    const { ctx, track } = rig();
    drive(ctx, track.driveChannel('width', 0), v);
    // left-only DC 1 at center: left = (1 + width) / 2
    const got = leftOut(ctx, track);
    assert.ok(Math.abs(got - want) < 1e-6, `width driven at ${v}: ${got}, expected ${want}`);
  }
});

test('a width set after it was driven goes through the same constant, held the same', () => {
  const { ctx, track } = rig();
  const param = track.driveChannel('width', 0);
  param.value = 3; // the modulator came off and left it here
  assert.ok(Math.abs(leftOut(ctx, track) - 2) < 1e-6);
  track.setChannel('width', 6, 0, 0);
  assert.ok(Math.abs(leftOut(ctx, track) - 2.5) < 1e-6, 'a set width is still held to 4');
});

test('a driven bass mono cutoff is held to 20 Hz - 2 kHz, and driving it turns it on', () => {
  for (const [v, want] of [[0, 20], [-500, 20], [5000, 2000], [120, 120], [1999, 1999]]) {
    const { ctx, track } = rig();
    drive(ctx, track.driveChannel('bassmono', 0), v);
    const held = track.heldDrives.get('bassmono');
    const got = renderFake(ctx, held.shaper, { frames: FRAMES })[0][FRAMES - 1];
    assert.ok(Math.abs(got - want) < 1e-6, `bass mono driven at ${v}: ${got}, expected ${want}`);
    assert.equal(track.sideHigh.gain.value, 1, 'driven, bass mono is on');
  }
});
