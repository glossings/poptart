// Share links: a pattern into a URL fragment and back, exactly, and what a link leaves behind.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_PREFIX, encodeShareHash, decodeShareHash, unpackStates, packStates, localOnly,
} from './public/web/share-link.mjs';

// A captured device state as the web engine writes one into a preset definition: its JSON as
// UTF-8, base64'd (encodeState in web-audio-engine.mjs).
const b64 = (json) => btoa(String.fromCharCode(...new TextEncoder().encode(json)));
const state = (params, files = {}) => b64(JSON.stringify({ device: 'plaits', version: 1, params, files }));

const song = (s1, s2 = s1) => [
  '// @title shared',
  '_preset("bass", "plaits", "' + s1 + '")',
  '_preset("lead", "plaits", "' + s2 + '")',
  'const bass = n("0 3 5 7").synth("plaits").preset("bass")',
  'const drums = s("kit:0 kit:3").gain(0.8)',
].join('\n');

test('a pattern comes back from its link exactly', async () => {
  const code = song(state({ harmonics: 0.25, timbre: 0.5 }), state({ harmonics: 0.75, timbre: 'é' }));
  const hash = await encodeShareHash(code);
  assert.ok(hash.startsWith(SHARE_PREFIX));
  assert.match(hash.slice(SHARE_PREFIX.length), /^[A-Za-z0-9_-]+$/, 'URL-safe, no padding');
  assert.equal(await decodeShareHash(hash), code);
  assert.equal(await decodeShareHash(`#${hash}`), code, 'a leading # is fine');
});

test('states are carried as JSON, once each, and written back as the same literal', () => {
  const s = state({ harmonics: 0.5 });
  const { code, states } = unpackStates(song(s));
  assert.deepEqual(states, [JSON.stringify({ device: 'plaits', version: 1, params: { harmonics: 0.5 }, files: {} })]);
  assert.ok(!code.includes(s));
  assert.equal(packStates(code, states), song(s));
});

test('a base64 literal that is not a state this can put back is left alone', () => {
  const notJson = b64('{ not json at all, just braces');
  const array = b64('["a", "b", "c", "d", "e"]');
  const code = `x("${notJson}") + y("${array}") + z("eyJ")`;
  assert.deepEqual(unpackStates(code), { code, states: [] });
});

test('a pattern with nothing captured still round trips', async () => {
  const code = 's("kit:0*4")\n  .lpf(sine.range(200, 2000))  // "quoted" \\ back\\slash';
  assert.equal(await decodeShareHash(await encodeShareHash(code)), code);
});

test('a link cut short does not decode', async () => {
  const code = song(state({ harmonics: 0.1 }), state({ harmonics: 0.9 })).repeat(20);
  const hash = await encodeShareHash(code);
  await assert.rejects(decodeShareHash(hash.slice(0, Math.floor(hash.length / 2))));
});

test('a link naming a state it does not carry is refused', () => {
  assert.throws(() => packStates('x("\u00003\u0000")', []), /does not carry/);
});

test('localOnly: everything carried', () => {
  assert.equal(localOnly(song(state({ harmonics: 0.5 }))), null);
});

test('localOnly: files added to this browser, in the code and in device states', () => {
  const s = state({ table: 3 }, { table: 'wt:Basic/saw.wav' });
  const code = [
    song(s),
    's("files:kick.wav files:snare <files:kick.wav kit:2>")',
    'sr("take1 take2")',
    'const profiles = "profiles:x"',
  ].join('\n');
  const left = localOnly(code);
  assert.deepEqual(left.files.sort(), ['files:kick.wav', 'files:snare', 'rec:take1', 'rec:take2', 'wt:Basic/saw.wav']);
  assert.equal(left.handles, 0);
});

test('localOnly: captured desktop plugin states, counted once each', () => {
  const code = '_preset("a", "Serum 2", "@0123456789ab")\n_preset("b", "Serum 2", "@0123456789ab")\n_preset("c", "Serum 2", "@ba9876543210")';
  assert.deepEqual(localOnly(code), { files: [], handles: 2 });
});
