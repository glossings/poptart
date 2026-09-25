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
