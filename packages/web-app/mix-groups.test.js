'use strict';

// Groups on the DJ desk. A group is ONE stem on the strip - that is what grouping bought - but the
// parts inside it are still parts, and a mix is exactly where you want to reach for one of them:
// drop the hats out of the kit for eight bars, solo the sub inside the bass group. So the strip
// folds a group's stems away under it and unfolds them on request, the way the ctrl+G mixer's
// strips do.
//
// Two halves, and they are tested together because they are one feature:
//   - what the STRIP draws (public/client.js's mixDeckRows): tree order, the indent, and a member
//     left out entirely while any group above it is still folded;
//   - what a SOLO means once the tracks are a tree (server.js's mixSoloFaders). A member's audio
//     leaves through its group's bus and never through its own output, so soloing one has to leave
//     every group above it OPEN or there is nothing to hear - the failure that would look like
//     "solo is broken on grouped tracks" and be a routing fact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found - this test needs updating`);
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return src.slice(at, end);
}

const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// ---------------------------------------------------------------------------------------------
// The strip's rows (client.js)
// ---------------------------------------------------------------------------------------------

/** mixDeckRows over `tracks` with `open` unfolded, as "key@depth" strings (groups marked with *). */
function rows(tracks, open = [], deck = 'a') {
  // eslint-disable-next-line no-new-func
  const fn = new Function('mixUnfolded', 'tracks', 'deck', `
    ${grab(CLIENT, 'mixDeckRows')}
    return mixDeckRows(tracks, deck);`);
  return fn(new Set(open), tracks, deck).map((r) => `${r.t.key}@${r.depth}${r.group ? '*' : ''}`);
}

const t = (key, parent = null, deck = 'a') => ({ key, parent, deck });

// A kit group with a subgroup in it, plus an ungrouped stem and one on the other deck.
const SONG = [
  t('drums'), t('bass'), t('b:pad', null, 'b'),
  t('kick', 'drums'), t('hats', 'drums'), t('snares', 'drums'),
  t('snareMain', 'snares'), t('snareGhost', 'snares'),
];

test('folded, a group is one row - its stems are not on the strip at all', () => {
  assert.deepEqual(rows(SONG), ['drums@0*', 'bass@0']);
});

test('unfolded, its stems follow it, stepped in one level', () => {
  assert.deepEqual(rows(SONG, ['drums']),
    ['drums@0*', 'kick@1', 'hats@1', 'snares@1*', 'bass@0']);
});

test('a subgroup folds on its own - opening the kit does not open everything under it', () => {
  assert.deepEqual(rows(SONG, ['drums', 'snares']),
    ['drums@0*', 'kick@1', 'hats@1', 'snares@1*', 'snareMain@2', 'snareGhost@2', 'bass@0'],
    'and a stem two groups deep steps in twice');
  assert.deepEqual(rows(SONG, ['snares']), ['drums@0*', 'bass@0'],
    'a subgroup unfolded under a FOLDED group shows nothing - there is no row to hang it under');
});

test('each deck draws its own tracks and nobody else\'s', () => {
  assert.deepEqual(rows(SONG, ['drums'], 'b'), ['b:pad@0']);
});

test('a member whose group is not on the list is drawn anyway, at the top level', () => {
  // An eval caught halfway, or an orphan: a stem you can't see is a stem you can't gate, and
  // dropping it would take a part of the song off the desk with no way to notice.
  assert.deepEqual(rows([t('bass'), t('kick', 'drums')]), ['bass@0', 'kick@0']);
});

// ---------------------------------------------------------------------------------------------
// What a solo means over the tree (server.js)
// ---------------------------------------------------------------------------------------------

/**
 * mixSoloFaders for deck A over `parents` (key -> its group's key), with `solo` soloed and `prev`
 * as the faders the deck wore before the solo started.
 */
function soloFaders(keys, parents, solo, prev = null) {
  const mixState = {
    solo: { a: new Set(solo), b: new Set() },
    soloPrev: { a: prev && new Map(Object.entries(prev)), b: null },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('mixState', 'groupMembers', 'mixDeskKeys', `
    ${grab(SERVER, 'mixGroupChain')}
    ${grab(SERVER, 'mixSoloFaders')}
    return mixSoloFaders('a');`);
  const out = fn(mixState, new Map(Object.entries(parents)), () => keys);
  return Object.fromEntries(out);
}

const KIT = { kick: 'drums', hats: 'drums', snares: 'drums', snareMain: 'snares' };
const KEYS = ['drums', 'bass', 'kick', 'hats', 'snares', 'snareMain'];

test('soloing a stem inside a group leaves the groups above it OPEN', () => {
  // The whole point: `kick` sends into the drums bus and has no output of its own, so a solo that
  // gated `drums` out with everything else would be a solo you cannot hear.
  assert.deepEqual(soloFaders(KEYS, KIT, ['kick']), {
    drums: 1, bass: 0, kick: 1, hats: 0, snares: 0, snareMain: 0,
  });
});

test('...however deep it is: every group on the way up opens', () => {
  assert.deepEqual(soloFaders(KEYS, KIT, ['snareMain']), {
    drums: 1, bass: 0, kick: 0, hats: 0, snares: 1, snareMain: 1,
  });
});

test('soloing a GROUP keeps the balance inside it, rather than slamming every part to unity', () => {
  // Soloing the kit means "the kit as it sounds", so a stem you had pulled down inside it stays
  // pulled down - and one you had gated out inside it stays out.
  assert.deepEqual(soloFaders(KEYS, KIT, ['drums'], { kick: 1, hats: 0, snares: 0.5, snareMain: 1, bass: 1 }), {
    drums: 1, bass: 0, kick: 1, hats: 0, snares: 0.5, snareMain: 1,
  });
});

test('a stem with no snapshot inside a soloed group comes in at unity, like any fresh stem', () => {
  assert.deepEqual(soloFaders(KEYS, KIT, ['drums'], { kick: 0.2 }).hats, 1);
});

test('several stems soloed at once open every group any of them needs', () => {
  assert.deepEqual(soloFaders(KEYS, KIT, ['hats', 'bass']), {
    drums: 1, bass: 1, kick: 0, hats: 1, snares: 0, snareMain: 0,
  });
});

test('with no groups at all it is the plain solo it always was', () => {
  assert.deepEqual(soloFaders(['bd', 'hats', 'bass'], {}, ['bd']), { bd: 1, hats: 0, bass: 0 });
});
