// Audio in: opening the picked inputs with the browser's speech processing off, laying their
// channels end to end, and asking for the default input when a pattern reads one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioInputs } from './public/web/audio-input.mjs';

function fakeBrowser({ named = true, granted = true } = {}) {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Scarlett 2i2' },
    { kind: 'audioinput', deviceId: 'mic', label: 'MacBook Pro Microphone' },
    { kind: 'audioinput', deviceId: 'sc', label: 'Scarlett 2i2' },
  ];
  const channels = { mic: 1, sc: 2, default: 2 };
  const asked = [];
  const stopped = [];
  const media = {
    enumerateDevices: async () => (named ? devices : devices.map((d) => ({ ...d, label: '' }))),
    getUserMedia: async (constraints) => {
      asked.push(constraints.audio);
      const id = constraints.audio.deviceId?.exact ?? 'default';
      const label = devices.find((d) => d.deviceId === id)?.label ?? 'default';
      const track = { label, stop: () => stopped.push(id), getSettings: () => ({ deviceId: id, channelCount: channels[id] }) };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    },
  };
  const made = [];
  const node = (kind, extra = {}) => {
    const n = { kind, links: [], connect(target, out = 0, inp = 0) { n.links.push([target, out, inp]); }, disconnect() {}, ...extra };
    made.push(n);
    return n;
  };
  const context = {
    createMediaStreamSource: () => node('source'),
    createChannelSplitter: (count) => node('splitter', { count }),
    createChannelMerger: (count) => node('merger', { count }),
  };
  const store = new Map();
  const prefs = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const permissions = { query: async () => ({ state: granted ? 'granted' : 'prompt' }) };
  return { media, context, prefs, permissions, asked, stopped, made, store };
}

test('picked inputs are opened with the speech processing off, their channels end to end', async () => {
  const b = fakeBrowser();
  const changes = [];
  const inputs = createAudioInputs({ ...b, onChange: (node, n, layout) => changes.push([node?.kind, n, layout]) });
  const answer = await inputs.choose(['mic', 'sc']);
  for (const c of b.asked) {
    assert.equal(c.echoCancellation, false);
    assert.equal(c.noiseSuppression, false);
    assert.equal(c.autoGainControl, false);
  }
  assert.deepEqual(answer.layout, [{ name: 'MacBook Pro Microphone', inChannels: 1 }, { name: 'Scarlett 2i2', inChannels: 2 }]);
  assert.deepEqual(changes, [['merger', 3, answer.layout]]);
  // The Scarlett's two channels land on merged channels 2 and 3 (1-indexed), after the mic's one.
  const merger = b.made.find((n) => n.kind === 'merger');
  const into = b.made.filter((n) => n.kind === 'splitter').flatMap((s) => s.links.filter(([t]) => t === merger).map(([, out, inp]) => [out, inp]));
  assert.deepEqual(into, [[0, 0], [0, 1], [1, 2]]);
  assert.equal(answer.devices.find((d) => d.uid === 'sc').inChannels, 2, 'an open input says its channel count');
  assert.equal(answer.active, 'MacBook Pro Microphone + Scarlett 2i2');
});

test('a pattern reading an input with nothing picked opens the default, once', async () => {
  const b = fakeBrowser();
  const inputs = createAudioInputs({ ...b });
  await Promise.all([inputs.want(), inputs.want()]);
  assert.equal(b.asked.length, 1);
  assert.equal(b.asked[0].deviceId, undefined, 'the browser\'s default input');
  assert.deepEqual(inputs.layout(), [{ name: 'Scarlett 2i2', inChannels: 2 }], 'named as the device, without the browser\'s "Default - "');
});

test('choosing again closes what was open', async () => {
  const b = fakeBrowser();
  const inputs = createAudioInputs({ ...b });
  await inputs.choose(['mic']);
  await inputs.choose(['sc']);
  assert.deepEqual(b.stopped, ['mic']);
});

test('the picks come back on the next visit only where that will not prompt', async () => {
  const b = fakeBrowser();
  await createAudioInputs({ ...b }).choose(['sc']);
  b.asked.length = 0;
  assert.deepEqual(await createAudioInputs({ ...b }).restore(), [{ name: 'Scarlett 2i2', inChannels: 2 }]);
  const noPermission = fakeBrowser({ granted: false });
  noPermission.store.set('poptart.audioInputs', JSON.stringify(['sc']));
  assert.equal(await createAudioInputs({ ...noPermission }).restore(), null);
  assert.equal(noPermission.asked.length, 0, 'no prompt at load');
});

test('unnamed inputs are offered to be revealed', async () => {
  const b = fakeBrowser({ named: false });
  const d = await createAudioInputs({ ...b }).describe();
  assert.deepEqual(d.devices, []);
  assert.equal(d.canReveal, true);
});
