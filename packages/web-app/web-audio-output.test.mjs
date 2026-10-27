// The browser build's output device: listing what the browser will name, moving the context,
// and remembering the choice - against a fake of the two browser APIs involved.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioOutputs } from './public/web/audio-output.mjs';

/** A browser with these outputs, named or not, and a context that can or cannot move. */
function fakeBrowser({ named = true, canMove = true } = {}) {
  const outputs = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Default - MacBook Pro Speakers' },
    { kind: 'audiooutput', deviceId: 'a1', label: 'MacBook Pro Speakers' },
    { kind: 'audiooutput', deviceId: 'b2', label: 'Scarlett 2i2 USB' },
    { kind: 'audioinput', deviceId: 'm1', label: 'MacBook Pro Microphone' },
  ];
  let granted = named;
  const stopped = [];
  const media = {
    enumerateDevices: async () => (granted ? outputs : outputs.map((d) => ({ ...d, deviceId: '', label: '' })).slice(0, 2)),
    getUserMedia: async () => {
      granted = true;
      return { getTracks: () => [{ stop: () => stopped.push('mic') }] };
    },
  };
  const context = { sinks: [] };
  if (canMove) context.setSinkId = async (id) => { context.sinks.push(id); };
  const store = new Map();
  const prefs = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  return { media, context, prefs, stopped, store };
}

test('every named output is listed once, the default marked, the aliases left out', async () => {
  const b = fakeBrowser();
  const outputs = createAudioOutputs(b);
  const d = await outputs.describe();
  assert.deepEqual(d.devices, [
    { name: 'MacBook Pro Speakers', channels: null, isDefault: true },
    { name: 'Scarlett 2i2 USB', channels: null, isDefault: false },
  ]);
  assert.equal(d.selected, null);
  assert.equal(d.canReveal, false);
  assert.equal(d.canChoose, true);
});

test('choosing one moves the context there, and the default moves it back', async () => {
  const b = fakeBrowser();
  const outputs = createAudioOutputs(b);
  const after = await outputs.choose('Scarlett 2i2 USB');
  assert.deepEqual(b.context.sinks, ['b2']);
  assert.equal(after.selected, 'Scarlett 2i2 USB');
  await outputs.choose(null);
  assert.deepEqual(b.context.sinks, ['b2', ''], 'the empty id is the system default');
  await assert.rejects(outputs.choose('Unplugged Thing'), /no audio output called/);
});

test('hidden names are offered to be revealed, and revealing closes the microphone at once', async () => {
  const b = fakeBrowser({ named: false });
  const outputs = createAudioOutputs(b);
  const before = await outputs.describe();
  assert.deepEqual(before.devices, [], 'an unnamed entry is the browser withholding the list');
  assert.equal(before.canReveal, true);
  const after = await outputs.reveal();
  assert.deepEqual(b.stopped, ['mic']);
  assert.equal(after.devices.length, 2);
  assert.equal(after.canReveal, false);
});

test('a browser that cannot move its output says so and refuses to', async () => {
  const b = fakeBrowser({ canMove: false });
  const outputs = createAudioOutputs(b);
  const d = await outputs.describe();
  assert.equal(d.canChoose, false);
  assert.match(d.warning, /cannot choose an audio output/);
  await assert.rejects(outputs.choose('Scarlett 2i2 USB'), /Chrome and Edge can/);
});

test('the choice comes back on the next load, by id and then by name', async () => {
  const b = fakeBrowser();
  await createAudioOutputs(b).choose('Scarlett 2i2 USB');
  const again = createAudioOutputs({ ...b, context: { sinks: [], setSinkId: async function (id) { this.sinks.push(id); } } });
  assert.equal(await again.restore(), 'Scarlett 2i2 USB');
  // New ids handed out since: found by its name instead.
  b.store.set('poptart.audioOutput', JSON.stringify({ id: 'stale', name: 'Scarlett 2i2 USB' }));
  const third = createAudioOutputs(b);
  assert.equal(await third.restore(), 'Scarlett 2i2 USB');
  // Unplugged: nothing is restored and nothing throws.
  b.store.set('poptart.audioOutput', JSON.stringify({ id: 'x', name: 'Gone' }));
  assert.equal(await createAudioOutputs(b).restore(), null);
});

// --- the headphone cue ----------------------------------------------------------------------------

/** An engine that records where the cue was routed. */
function fakeEngine() {
  return { routes: [], setCueRoute(r) { this.routes.push(r); } };
}

/** A second context's constructor that remembers what it was pointed at. */
function fakeContexts() {
  const made = [];
  class Ctx {
    constructor(opts) { this.opts = opts; this.state = 'running'; made.push(this); }
    async setSinkId(id) { this.sink = id; }
    createMediaStreamSource(stream) { return { stream, connect: (to) => { this.connected = to; } }; }
    get destination() { return 'ctx2-out'; }
    close() { this.closed = true; }
  }
  return { Ctx, made };
}

test('an output with four channels offers its second pair as the cue, and routes it there', async () => {
  const b = fakeBrowser();
  b.context.destination = { maxChannelCount: 4 };
  b.context.createMediaStreamDestination = () => ({ stream: 's' });
  const engine = fakeEngine();
  const outputs = createAudioOutputs({ ...b, engine, AudioContextCtor: null });
  const d = await outputs.describe();
  assert.equal(d.cueAvailable, true);
  assert.deepEqual(d.cuePairs.pairs, [1]);
  const res = await outputs.chooseCue({ device: d.cuePairs.device, pair: 1 });
  assert.deepEqual(engine.routes.at(-1), { pair: 1 });
  assert.match(res.active, /channels 3\/4/);
  assert.equal(res.cuePair, 1);
  assert.equal(res.cuePreviewDevice, null, 'an audition cannot be pointed at a pair');
  await assert.rejects(outputs.chooseCue({ pair: 2 }), /no channels 5\/6/);
  await outputs.chooseCue({});
  assert.equal(engine.routes.at(-1), null, 'none takes the cue off');
});

test('a second device carries the cue on a second context pointed at it', async () => {
  const b = fakeBrowser();
  b.context.sampleRate = 48000;
  b.context.createMediaStreamDestination = () => ({ stream: 'cue-stream' });
  const engine = fakeEngine();
  const { Ctx, made } = fakeContexts();
  const outputs = createAudioOutputs({ ...b, engine, AudioContextCtor: Ctx });
  const res = await outputs.chooseCue({ device: 'Scarlett 2i2 USB' });
  assert.equal(res.active, 'Scarlett 2i2 USB');
  assert.equal(made[0].sink, 'b2');
  assert.equal(made[0].opts.sampleRate, 48000, 'the same rate, so only the clocks differ');
  assert.equal(made[0].connected, 'ctx2-out');
  assert.ok(engine.routes.at(-1).node, 'the engine hands the headphones to that stream');
  assert.equal(res.cuePreviewDevice, 'Scarlett 2i2 USB', 'auditions follow the cue there');
  await outputs.chooseCue({});
  assert.equal(made[0].closed, true);
  // Remembered: the next load routes it again.
  const again = createAudioOutputs({ ...b, engine, AudioContextCtor: Ctx });
  await outputs.chooseCue({ device: 'Scarlett 2i2 USB' });
  assert.equal(await again.restoreCue(), 'Scarlett 2i2 USB');
});

test('a browser that can do neither says so where the cue menu is drawn', async () => {
  const b = fakeBrowser();
  const outputs = createAudioOutputs({ ...b, engine: fakeEngine(), AudioContextCtor: null });
  const d = await outputs.describe();
  assert.equal(d.cueAvailable, false);
  assert.match(d.cueWarning, /four channels/);
  await assert.rejects(outputs.chooseCue({ device: 'Scarlett 2i2 USB' }), /cannot play to a second output/);
});
