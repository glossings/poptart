// The compiled-device source list, and the credits generated from it.
//
// The list is data the build acts on and the credits page reads, so it is checked like data: a
// source with no license, or one marked built without anybody having read its license, fails
// here rather than shipping.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COPYLEFT,
  copyleftRisk,
  creditsMarkdown,
  plannedDeviceCount,
  unverified,
  validateSources,
} from './src/packs/sources.mjs';
import { catalog } from './src/catalog.mjs';
import { validateManifest, packCredits } from './src/packs/manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const listPath = path.join(here, 'build', 'devices', 'sources.json');
const loadList = () => validateSources(JSON.parse(fs.readFileSync(listPath, 'utf8')));

const good = (over = {}) => ({
  target: 'AGPL-3.0-only',
  sources: [{
    id: 'x', title: 'X', repository: 'https://example.invalid/x', license: 'MIT',
    status: 'planned', devices: [{ id: 'Thing', kind: 'fx' }],
  }],
  ...over,
});

test('the shipped source list validates', () => {
  const doc = loadList();
  assert.equal(doc.target, 'AGPL-3.0-only');
  assert.ok(doc.sources.length >= 5);
  assert.ok(plannedDeviceCount(doc) > 30, 'the catalog should have somewhere to grow');
});

test('every source names a repository and a license, so both can be checked', () => {
  for (const s of loadList().sources) {
    assert.ok(s.repository.startsWith('http'), `${s.id} has no repository`);
    assert.ok(s.license, `${s.id} has no license`);
    assert.ok(s.devices.length > 0, `${s.id} lists no devices`);
  }
});

test('nothing is marked built while its license is unverified', () => {
  // The flag is the whole safeguard: it says "this is what the project is generally understood
  // to use" rather than "somebody read the headers of the files we are porting".
  const doc = loadList();
  for (const s of doc.sources) {
    if (s.status === 'built') assert.equal(s.licenseVerified, true, `${s.id} is built but unverified`);
  }
  assert.throws(() => validateSources(good({
    sources: [{ ...good().sources[0], status: 'built' }],
  })), /license has not been verified/);
});

test('the list reports what still has to be checked', () => {
  const outstanding = unverified(loadList());
  assert.ok(outstanding.length > 0, 'nothing has been verified yet, and the list should say so');
  const faust = outstanding.find((s) => s.id === 'faust');
  assert.ok(faust?.note?.includes('PER FUNCTION'), 'the per-function licensing should be flagged where it bites');
});

test('the sources that would make the build permanently copyleft are marked', () => {
  const risky = copyleftRisk(loadList());
  assert.ok(risky.some((s) => s.id === 'faust'), 'the Faust reverbs are the copyleft ones here');
  assert.ok(COPYLEFT.includes('GPL-3.0'));
});

test('a malformed source list is refused by name', () => {
  assert.throws(() => validateSources(null), /must be an object/);
  assert.throws(() => validateSources({ sources: [] }), /what license the build targets/);
  assert.throws(() => validateSources(good({ sources: [] })), /no sources listed/);
  assert.throws(() => validateSources(good({ sources: [{ title: 'X' }] })), /needs an id/);
  assert.throws(() => validateSources(good({ sources: [{ id: 'x', title: 'X' }] })), /needs a repository/);
  assert.throws(() => validateSources(good({ sources: [{ id: 'x', title: 'X', repository: 'https://e.invalid' }] })), /needs a license/);
});

test('a source listed twice is an error, since the build would fetch it twice', () => {
  const one = good().sources[0];
  assert.throws(() => validateSources(good({ sources: [one, one] })), /listed twice/);
});

test('a device has to say whether it is an instrument or an effect', () => {
  assert.throws(() => validateSources(good({
    sources: [{ ...good().sources[0], devices: [{ id: 'Thing' }] }],
  })), /must be a synth or an fx/);
  assert.throws(() => validateSources(good({
    sources: [{ ...good().sources[0], devices: [] }],
  })), /lists no devices/);
});

test('an unknown status is refused rather than treated as planned', () => {
  assert.throws(() => validateSources(good({
    sources: [{ ...good().sources[0], status: 'maybe' }],
  })), /must be "planned" or "built"/);
});

test('the credits name every shipped device and never claim code that is not in the build', () => {
  const doc = loadList();
  const packs = packCredits([validateManifest({
    id: 'pt_kit', title: 'poptart kit',
    files: [{ file: 'kick.wav', license: 'CC0-1.0', source: 'rendered' }],
  })]);
  const text = creditsMarkdown({ devices: catalog.licenses(), sources: doc, packs });

  for (const device of catalog.list()) {
    assert.ok(text.includes(device.id), `${device.id} is missing from the credits`);
  }
  // Both halves are real now: several sources are compiled in and one is still only planned.
  assert.ok(text.includes('## Ported DSP'), 'the sources that ARE compiled in need their own heading');
  assert.ok(text.includes('Airwindows') && text.includes('Mutable Instruments'));
  assert.ok(text.includes('Not in this build'), 'the planned sources should be marked as absent');
  assert.ok(text.includes('no code from these is compiled in yet'));
  assert.ok(text.includes('Faust'), 'the one source still unbuilt should be listed as such');
  assert.ok(text.includes('pt_kit') && text.includes('CC0-1.0'));
});

test('the credits show a built source under its own heading once there is one', () => {
  const doc = validateSources(good({
    sources: [{
      id: 'x', title: 'X', repository: 'https://example.invalid/x', license: 'MIT',
      status: 'built', licenseVerified: true, devices: [{ id: 'Thing', kind: 'fx' }],
    }],
  }));
  const text = creditsMarkdown({ devices: [], sources: doc });
  assert.ok(text.includes('## Ported DSP'));
  assert.ok(text.includes('https://example.invalid/x'));
  assert.ok(!text.includes('Not in this build'));
});
