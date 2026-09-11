// Which strips the ctrl+G mixer ANALYZES (public/client.js, server.js).
//
// Per-track band analysis is DSP on the audio thread, capped at a track count (see
// OscEngine#mixMeters), so the question "which tracks" is a budget as well as a picture. Two rules
// decide it, and both are about what is being looked at rather than what is playing:
//
//   - a folded group's members are not on the desk, so they spend nothing;
//   - an UNFOLDED group stands aside for its own members. Its strip stays - the fader, the mute
//     and the solo are still the group's - but its summed curve says nothing its members' don't,
//     and it would take one of the analyzers to say it.
//
// The second is the one worth pinning: the strip is still there, so it is easy to write code that
// analyzes it anyway, and the cost of that is an analyzer per group in a song that is mostly
// groups - which is exactly the song that needs the budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as labelsMod from '../pattern-core/src/labels.mjs';
import * as groupsMod from '../pattern-core/src/groups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, 'public', 'client.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');

function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found - this test needs updating`);
  let depth = 0;
  const start = src.indexOf('{', at);
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name} did not close`);
}

/**
 * mixerStripLabels + mixerAnalyzedLabels over a buffer, with `open` unfolded and `playing` the
 * engine's track list. Returns { order, aside, analyzed }.
 */
function desk(code, { open = [], playing = null } = {}) {
  const tracks = playing ?? labelsMod.splitLabeledBlocks(code).map((b) => b.label).filter(Boolean);
  const env = {
    cm: { getValue: () => code },
    labelsMod,
    groupsMod,
    mixerUnfolded: new Set(open),
    mixerKnownTracks: tracks,
    mixerState: { serverTracks: tracks, order: [], aside: new Set() },
  };
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys, `
    ${grab(CLIENT, 'mixerStripLabels')}
    ${grab(CLIENT, 'mixerAnalyzedLabels')}
    return { mixerStripLabels, mixerAnalyzedLabels, mixerState };`);
  const fns = build(...keys.map((k) => env[k]));
  const { order, aside } = fns.mixerStripLabels();
  fns.mixerState.order = order;
  fns.mixerState.aside = aside;
  return { order, aside: [...aside], analyzed: fns.mixerAnalyzedLabels() };
}

const SONG = [
  'drums: group({',
  '  kick: s("bd*4")',
  '  hats: s("hh*8")',
  '})',
  '',
  'bass: n("0").synth("X")',
].join('\n');

test('folded, a group is the strip and the only thing analyzed on its row', () => {
  const d = desk(SONG);
  assert.deepEqual(d.order, ['drums', 'bass'], 'its members have no strip while it is folded');
  assert.deepEqual(d.aside, []);
  assert.deepEqual(d.analyzed, ['drums', 'bass'], 'two analyzers for a three-track song');
});

test('unfolded, the group keeps its strip and hands the analysis to its members', () => {
  const d = desk(SONG, { open: ['drums'] });
  assert.deepEqual(d.order, ['drums', 'kick', 'hats', 'bass'], 'the strip is still there');
  assert.deepEqual(d.aside, ['drums'], '...and it is standing aside');
  assert.deepEqual(d.analyzed, ['kick', 'hats', 'bass'],
    'three analyzers, not four - the group would have said what its members already say');
});

test('an unfolded group with nobody showing keeps its own analysis', () => {
  // Nothing is standing in for it, so going dark there would be a strip that just stops working.
  // Two ways that happens: a group whose members are not playing, and one that is empty.
  const d = desk(SONG, { open: ['drums'], playing: ['drums', 'bass'] });
  assert.deepEqual(d.order, ['drums', 'bass']);
  assert.deepEqual(d.aside, []);
  assert.deepEqual(d.analyzed, ['drums', 'bass']);
});

test('a subgroup stands aside on its own terms', () => {
  const code = [
    'drums: group({',
    '  kick: s("bd*4")',
    '  snares: group({',
    '    snareMain: s("sd")',
    '    snareGhost: s("sd*4")',
    '  })',
    '})',
  ].join('\n');
  const both = desk(code, { open: ['drums', 'snares'] });
  assert.deepEqual(both.order, ['drums', 'kick', 'snares', 'snareMain', 'snareGhost']);
  assert.deepEqual(both.aside, ['drums', 'snares'], 'each hands its analyzer down to what it shows');
  assert.deepEqual(both.analyzed, ['kick', 'snareMain', 'snareGhost']);

  // The subgroup folded again: it is what its own members' picture reduces to, so it takes the
  // analyzer back.
  const one = desk(code, { open: ['drums'] });
  assert.deepEqual(one.analyzed, ['kick', 'snares']);
});

test('the group that is standing aside says so rather than reading as a dead meter', () => {
  assert.match(CLIENT, /const aside = mixerState\.aside\?\.has\(strip\.label\) \?\? false;/);
  assert.match(CLIENT, /classList\.toggle\('mixer-strip-aside', aside\)/);
  const css = fs.readFileSync(path.join(HERE, 'public', 'style.css'), 'utf8');
  assert.match(css, /\.mixer-strip-aside \.mixer-meter/, 'and its meter steps back with it');
});

test('the server forgets a track it has stopped tapping, so no curve freezes on the plot', () => {
  // A band frame is the LATEST one rather than a queue (see handleMixSpec), so a key nothing feeds
  // any more would go on being polled forever - which is exactly what a group handing its analyzer
  // to its members does to itself. Without this, unfolding one leaves its curve stuck on screen.
  const arm = grab(SERVER, 'mixArm');
  assert.match(arm, /const keep = new Set\(\[\.\.\.mixTapLabels\(\), '\*'\]\);/,
    'the master is never dropped - it is always tapped');
  assert.match(arm, /mixSpecs\.delete\(key2\)/);
  assert.match(arm, /mixLevels\.delete\(key2\)/);
});
