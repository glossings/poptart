import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry } from './src/registry.mjs';

const spec = (over = {}) => ({
  id: 'Reverb',
  kind: 'fx',
  license: 'AGPL-3.0-only',
  params: [{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.3 }],
  ...over,
});

test('a plain spec is validated on the way in and comes back frozen', () => {
  const r = createRegistry();
  const d = r.register(spec());
  assert.equal(d.id, 'Reverb');
  assert.ok(Object.isFrozen(d));
  assert.throws(() => r.register(spec({ kind: 'nonsense' })), /kind must be/);
});

test('an id resolves case-insensitively, the way userland spells it', () => {
  const r = createRegistry();
  r.register(spec());
  assert.equal(r.get('Reverb')?.id, 'Reverb');
  assert.equal(r.get('reverb')?.id, 'Reverb');
  assert.equal(r.get('  REVERB  ')?.id, 'Reverb');
  assert.equal(r.get('Rever'), null);
  assert.equal(r.get(null), null);
  assert.ok(r.has('reverb'));
});

test('a bare lookup means the newest version; a song asks for the one it recorded', () => {
  const r = createRegistry();
  r.register(spec({ version: 1 }));
  r.register(spec({ version: 2 }));
  r.register(spec({ version: 3 }));
  assert.equal(r.get('Reverb').version, 3);
  assert.equal(r.get('Reverb', 1).version, 1);
  assert.equal(r.get('Reverb', 2).version, 2);
  assert.equal(r.get('Reverb', 9), null, 'a version we do not ship resolves to nothing, never to a substitute');
});

test('versions register in any order and still report newest', () => {
  const r = createRegistry();
  r.register(spec({ version: 3 }));
  r.register(spec({ version: 1 }));
  assert.equal(r.get('Reverb').version, 3);
  assert.deepEqual(r.versions('Reverb').map((d) => d.version), [1, 3]);
});

test('registering the same id and version twice is an error, not an update', () => {
  const r = createRegistry();
  r.register(spec());
  assert.throws(() => r.register(spec()), /version 1 is already registered/);
});

test('two ids differing only in case are a collision, since lookup ignores case', () => {
  const r = createRegistry();
  r.register(spec({ id: 'Reverb' }));
  assert.throws(() => r.register(spec({ id: 'REVERB', version: 2 })), /ids differ only in case/);
});

test('a device may not change kind between versions', () => {
  const r = createRegistry();
  r.register(spec({ version: 1, kind: 'fx' }));
  assert.throws(
    () => r.register(spec({ version: 2, kind: 'synth', channels: { in: 0, out: 2 } })),
    /changed kind between versions/,
  );
});

test('list gives the newest of each, in id order, optionally by kind', () => {
  const r = createRegistry();
  r.register(spec({ id: 'Reverb', version: 1 }));
  r.register(spec({ id: 'Reverb', version: 2 }));
  r.register(spec({ id: 'Distort' }));
  r.register(spec({ id: 'Wavetable', kind: 'synth', channels: { in: 0, out: 2 } }));
  assert.deepEqual(r.list().map((d) => `${d.id}@${d.version}`), ['Distort@1', 'Reverb@2', 'Wavetable@1']);
  assert.deepEqual(r.list('synth').map((d) => d.id), ['Wavetable']);
  assert.deepEqual(r.list('fx').map((d) => d.id), ['Distort', 'Reverb']);
});

test('versions() of an unknown device is empty rather than a throw', () => {
  const r = createRegistry();
  assert.deepEqual(r.versions('nonesuch'), []);
  assert.deepEqual(r.versions(undefined), []);
});

test('the license roll-call covers every version, not just the newest', () => {
  const r = createRegistry();
  r.register(spec({ version: 1 }));
  r.register(spec({ version: 2, vendor: 'somebody', license: 'MIT', source: 'https://example.invalid/x' }));
  const rows = r.licenses();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    id: 'Reverb', version: 2, vendor: 'somebody', license: 'MIT', source: 'https://example.invalid/x',
  });
});
