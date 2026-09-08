// The arrangement painter's track model (public/client.js): one row per labeled block, the
// migration off the old `$: arrange(…)` call, and the fill that makes "a row with no clips is
// silent" a safe rule to have.
//
// None of it can be seen going wrong in the UI until it already has: a track that joins the song
// unfilled is a part that stops playing, and a migration that misses a call is a song that opens
// empty. All three are ordinary list/string work, so they are lifted out of the shipped client.js
// rather than copied - this fails if they drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as arrangeMod from '../pattern-core/src/arrange.mjs';
import * as labelsMod from '../pattern-core/src/labels.mjs';
import * as mixctlMod from '../pattern-core/src/mixctl.mjs';
import * as groupsMod from '../pattern-core/src/groups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'public', 'client.js'), 'utf8');

/**
 * One function's source, out of the shipped client.js. Counts braces past strings, comments and
 * regex literals rather than through them - `text.startsWith('{')` is a real line in here, and a
 * counter that took it for an open brace would swallow the rest of the file.
 */
function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  const start = SRC.indexOf('{', at);
  for (let i = start; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
    if (c === '/' && SRC[i + 1] === '*') { i = SRC.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < SRC.length && SRC[i] !== c; i++) if (SRC[i] === '\\') i++;
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*]\s*$/.test(SRC.slice(Math.max(0, i - 40), i))) {
      // a regex literal, not a division: run to its unescaped close
      for (i++; i < SRC.length && SRC[i] !== '/'; i++) {
        if (SRC[i] === '\\') i++;
        else if (SRC[i] === '[') for (i++; i < SRC.length && SRC[i] !== ']'; i++) if (SRC[i] === '\\') i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`${name} did not close - the grab helper needs updating`);
}

function grabConst(name) {
  const m = new RegExp(`^const ${name} = [^\\n]*;$`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return m[0];
}

/** A CodeMirror stand-in over a plain string: index/position round trips and range replacement. */
function fakeCm(text) {
  const cm = {
    text,
    getValue: () => cm.text,
    posFromIndex: (i) => ({ i }),
    indexFromPos: (p) => p.i,
    replaceRange(str, from, to) {
      cm.text = cm.text.slice(0, from.i) + str + cm.text.slice((to ?? from).i);
    },
  };
  return cm;
}

const LIFTED = ['matchParen', 'codeOnly', 'arFindDef', 'arMigrateLegacy', 'arMigrateOneLegacy', 'arReadDef', 'parseArrangeCall',
  'arCallOpts', 'serializeArrangeCall', 'arRefreshRows', 'arGroupTree', 'arGroupParents', 'arBlocks', 'arLabels',
  'arTrackLabels', 'arRowOfLabel', 'arReconcileTracks', 'arWriteDefText', 'arCreateBlock', 'arFollowHandRenames',
  'arCreateGroup', 'arUngroup', 'arGroupLabels', 'arPaintLabel']
  .map(grab)
  .concat([grabConst('arRowLabel'), grabConst('arFillClip'), grabConst('arIsGroup')])
  .join('\n\n');

/** The lifted functions over a fake editor and (optionally) a fake open panel. */
function panel({ code = '', arState = null, collapsed = [] } = {}) {
  const cm = fakeCm(code);
  const logged = [];
  const env = {
    // The painter reads and writes the deck it is on, not "the editor" - arCM is cm outside DJ
    // mode and deckBCM on deck B (see openArrangePainter).
    arCM: cm,
    arState,
    arrangeMod,
    labelsMod,
    mixctlMod,
    arLastBlocks: { a: null, b: null }, // what the last evaluation saw, per deck (see arFollowHandRenames)
    arPassDeck: 'a',
    arApplyRename: () => {},
    arSuppressClose: false,
    logLine: (line) => logged.push(line),
    arRefold: () => {}, // refoldAll, but only for the main buffer - deck B has no folds
    arSizeCanvas: () => {},
    groupsMod,
    cm, // arCreateGroup/arUngroup refold only when they are editing the main buffer
    refoldEditor: () => {},
    lastDefRunEnd: () => null, // where a new _groups(...) files in; the foot of the buffer here
    writeArrangeCall: () => {},
    drawArrange: () => {},
    arScheduleEval: () => {},
    expandedFolds: new Set(),
    collapsedGroups: new Set(collapsed), // which groups are folded - shared with the code editor's folds
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env), `${LIFTED}\nreturn { arFindDef, arMigrateLegacy, arReadDef, serializeArrangeCall, arRefreshRows, arReconcileTracks, arFillClip, arRowLabel, arRowOfLabel, arCreateBlock, arFollowHandRenames, arCreateGroup, arUngroup, arGroupLabels, arPaintLabel };`);
  return { fns: build(...Object.values(env)), cm, logged, arState };
}

/** Just enough panel state for the row functions - the fields they actually touch. */
const state = (clips = []) => ({ clips, rows: [], tree: null, parents: null, track: null });

// ---------------------------------------------------------------------------------------------
// Rows are tracks
// ---------------------------------------------------------------------------------------------

const SONG = [
  'setbpm(140)', // bare, at column 0: setup, and never a row
  'kick: pianoroll("kick")',
  'bass: pianoroll("bass")',
  'hats: s("hh*8")',
  '$: s("perc*4")', // a track you didn't feel like naming - a row like any other
].join('\n');

// ...and the same song as a GROUP: the kick's parts are ordinary tracks, held together by the tree
const FAMILY = [
  'kick: group()',
  'kickFill: s("mbd*8")',
  'setbpm(140)',
  'kickMain: s("mbd*4")',
  'hats: s("hh*8")',
  '_groups({ "kick": ["kickMain", "kickFill"] })',
].join('\n');

test("a group's members are rows of their own, nested under it in the tree's order", () => {
  const st = state();
  panel({ code: FAMILY, arState: st }).fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => [r.label, r.depth, r.group]), [
    ['kick', 0, true],
    ['kickMain', 1, false], // the tree's order, not the buffer's - the group's list is the one you chose
    ['kickFill', 1, false],
    ['hats', 0, false],
  ]);
  assert.equal(st.track, 'kick', 'and the first is selected, so a key press has a target');
});

test('a group takes no paint; its members do', () => {
  const st = state();
  const { fns } = panel({ code: FAMILY, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arPaintLabel(0), null, 'a group makes no sound of its own');
  assert.equal(fns.arPaintLabel(1), 'kickMain');
  assert.equal(fns.arPaintLabel(3), 'hats');
});

test('a member of a FOLDED group has no row, and its clips draw on the group', () => {
  const st = state(arrangeMod.parseArrangement('kickFill,12,4'));
  const { fns } = panel({ code: FAMILY, arState: st, collapsed: ['kick'] });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'hats'], 'the kit is one row');
  assert.equal(fns.arRowOfLabel('kickFill'), 0, 'and its parts still show, on it');
  assert.equal(fns.arRowOfLabel('hats'), 1);
});

test('a member whose group is not in the buffer keeps a row at the top level', () => {
  const st = state();
  panel({ code: 'kickFill: s("mbd*8")\nhats: s("hh*8")\n_groups({ "kick": ["kickFill"] })', arState: st })
    .fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => [r.label, r.depth]), [['kickFill', 0], ['hats', 0]],
    'losing a group must never lose what was in it');
});

test('a clip finds its own row; a clip naming a lost block gets an orphan one', () => {
  const st = state(arrangeMod.parseArrangement('kickMain,12,4 gone,0,4'));
  const { fns } = panel({ code: FAMILY, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arRowOfLabel('kickMain'), 1);
  assert.equal(st.rows.at(-1).label, 'gone');
  assert.equal(st.rows.at(-1).own, false);
});

test('a row per labeled block, in the order the buffer writes them', () => {
  const st = state();
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2']);
  assert.ok(st.rows.every((r) => r.own));
  assert.equal(st.track, 'kick', 'and the first is selected, so a key press has a target');
});

test('a $: track gets a row; a bare setup statement never does', () => {
  // Both are anonymous by label - every block that isn't named gets a `$n` - but they were WRITTEN
  // differently, and labels.mjs keeps that: `$:` promises sound, a column-0 statement is setup.
  const st = state();
  panel({ code: SONG, arState: st }).fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2'],
    'the $: track is arrangeable, in its place in the buffer; setbpm() is not there at all');
});

test('clips whose block is gone keep an orphan row, after the real ones', () => {
  const st = state(arrangeMod.parseArrangement('kick,0,8 ghost,0,4'));
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2', 'ghost']);
  assert.equal(st.rows.at(-1).own, false, 'drawn faded, and clearable - not invisible');
});

test('a clip finds its row by label, and a row its label', () => {
  const st = state(arrangeMod.parseArrangement('hats,0,8'));
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arRowOfLabel('hats'), 2);
  assert.equal(fns.arRowLabel(2), 'hats');
  assert.equal(fns.arRowLabel(9), null, 'past the last track is not a row');
});

// ---------------------------------------------------------------------------------------------
// The fill: what makes an empty row mean silence
// ---------------------------------------------------------------------------------------------

test('a track joins the arrangement playing throughout', () => {
  const { fns } = panel();
  assert.deepEqual(fns.arFillClip('pad', 24), { label: 'pad', start: 0, len: 24 });
  assert.equal(fns.arFillClip('pad', 0).len, 1, 'never zero-length, whatever the song says');
});

test('a track typed since the last evaluation is filled into the definition, panel shut', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8", { len: 8, tracks: ["kick", "bass"] })\n` });
  assert.equal(p.fns.arReconcileTracks(), true);
  const read = p.fns.arReadDef();
  assert.deepEqual(read.opts.tracks, ['kick', 'bass', 'hats', '$2'], 'hats and the $: track have joined');
  assert.deepEqual(read.clips.filter((c) => c.label === 'hats'), [{ label: 'hats', start: 0, len: 8 }]);
  assert.deepEqual(read.clips.filter((c) => c.label === '$2'), [{ label: '$2', start: 0, len: 8 }],
    'a $: track is filled like any other - it is a track you did not name, not setup');
  assert.deepEqual(read.clips.filter((c) => c.label === 'bass'), [], 'bass was already in it, and silent on purpose');
  assert.equal(p.fns.arReconcileTracks(), false, 'and again is a no-op');
});

test('a buffer with no arrangement is left completely alone', () => {
  const p = panel({ code: SONG });
  assert.equal(p.fns.arReconcileTracks(), false);
  assert.equal(p.cm.text, SONG);
});

// ---------------------------------------------------------------------------------------------
// Writing the definition
// ---------------------------------------------------------------------------------------------

test('the painter writes _arrange(...), options only when they say something', () => {
  const { fns } = panel();
  const base = { clips: arrangeMod.parseArrangement('kick,0,8'), snap: 'auto', len: null, autos: [], loops: [] };
  assert.equal(fns.serializeArrangeCall(base), '_arrange("kick,0,8")');
  assert.equal(
    fns.serializeArrangeCall({ ...base, len: 24, snap: 4, autos: ['filter'] }),
    '_arrange("kick,0,8", { snap: 4, len: 24, autos: ["filter"] })',
  );
  assert.equal(fns.serializeArrangeCall({ ...base, clips: [] }), '_arrange()');
});

test('a chosen color round-trips through the call', () => {
  const { fns } = panel();
  const text = fns.serializeArrangeCall({ clips: arrangeMod.parseArrangement('kick,0,8 kickFill,12,4'), snap: 'auto', len: null, autos: [], loops: [], colors: { kickFill: '#ff8800' } });
  assert.equal(text, '_arrange("kick,0,8 kickFill,12,4", { colors: {"kickFill":"#ff8800"} })');
  const read = panel({ code: text }).fns.arReadDef();
  assert.deepEqual(read.clips.map((c) => c.label), ['kick', 'kickFill']);
  assert.deepEqual(read.opts.colors, { kickFill: '#ff8800' });
});

const GROUPED = 'kick: group()\nkickMain: s("mbd*4")\nhats: s("hh*8")\n_groups({ "kick": ["kickMain"] })';

test('a group joins the arrangement unfilled; its members fill like any track', () => {
  const st = { ...state(arrangeMod.parseArrangement('hats,0,8')), tracks: ['hats'], len: 8 };
  const open = panel({ code: `${GROUPED}\n_arrange("hats,0,8", { tracks: "hats" })`, arState: st });
  assert.equal(open.fns.arReconcileTracks(), true);
  assert.deepEqual(st.tracks, ['hats', 'kick', 'kickMain']);
  assert.deepEqual(st.clips.map((c) => c.label), ['hats', 'kickMain'],
    'the member is a track and fills; the group has nothing to paint');
  const shut = panel({ code: `${GROUPED}\n_arrange("hats,0,8", { len: 8, tracks: "hats" })` });
  assert.equal(shut.fns.arReconcileTracks(), true);
  const read = shut.fns.arReadDef();
  assert.deepEqual(read.clips.map((c) => c.label).sort(), ['hats', 'kickMain']);
  assert.deepEqual([...read.opts.tracks].sort(), ['hats', 'kick', 'kickMain']);
});

// ---------------------------------------------------------------------------------------------
// The migration off `$: arrange(…)`
// ---------------------------------------------------------------------------------------------

test('an old song\'s arrange() block becomes an _arrange(...) definition', () => {
  const old = `${SONG}\n\n$: arrange("kick,0,0,8 bass,1,4,4", { len: 8 })\n`;
  const p = panel({ code: old });
  assert.equal(p.fns.arMigrateLegacy(), true);
  assert.match(p.cm.text, /^_arrange\("kick,0,0,8 bass,1,4,4", \{ len: 8 \}\)$/m);
  assert.ok(!/\$: arrange/.test(p.cm.text), 'the label goes with it - a definition is a bare statement');
  // ...and what it now reads as is the same song, on the new clip format
  const read = p.fns.arReadDef();
  assert.deepEqual(read.clips, [
    { label: 'kick', start: 0, len: 8 },
    { label: 'bass', start: 4, len: 4 },
  ]);
  assert.equal(read.opts.len, 8);
});

test('a buffer already on _arrange is left alone', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.match(p.cm.text, /_arrange\("kick,0,8"\)/);
  assert.ok(p.fns.arFindDef(), 'and it is found as the buffer\'s arrangement');
});

// ---------------------------------------------------------------------------------------------
// An orphan row's block, written on demand
// ---------------------------------------------------------------------------------------------

test('a missing base becomes a silent stub after the last track, above the foot', () => {
  const p = panel({ code: 'kick: s("bd*4")\n\nhats: s("hh*8")\n\n_arrange("kick,0,8 pad,0,8")\n_roll("x", "")\n' });
  assert.equal(p.fns.arCreateBlock('pad'), true);
  assert.equal(p.cm.text, 'kick: s("bd*4")\n\nhats: s("hh*8")\n\npad: note("~")\n\n_arrange("kick,0,8 pad,0,8")\n_roll("x", "")\n');
  assert.match(p.logged.join('\n'), /new track pad/);
});

test('cmd+G: a group() line above the selection, and the tree that holds it', () => {
  const p = panel({ code: 'kick: s("mbd*4")\nsnare: s("sd*2")\nhats: s("hh*8")\n' });
  assert.equal(p.fns.arCreateGroup(['kick', 'snare'], 'drums'), 'drums');
  assert.equal(p.cm.text,
    'drums: group()\nkick: s("mbd*4")\nsnare: s("sd*2")\nhats: s("hh*8")\n_groups({ "drums": ["kick", "snare"] })\n');
  assert.deepEqual(p.fns.arGroupLabels(), ['drums']);
  assert.match(p.logged.join('\n'), /drums is a group of kick, snare/);
});

test('cmd+G: a group of groups - the tree nests, the code stays flat', () => {
  const p = panel({ code: 'kick: group()\nkickMain: s("bd")\nsnare: s("sd")\n_groups({ "kick": ["kickMain"] })\n' });
  assert.equal(p.fns.arCreateGroup(['kick', 'kickMain', 'snare'], 'drums'), 'drums');
  const tree = mixctlMod.readGroupTree(p.cm.text);
  assert.deepEqual(tree.drums, ['kick', 'kickMain', 'snare']);
  assert.equal(tree.kick, undefined, 'a track joins one group at a time - the old entry emptied');
});

test('cmd+G: refuses a name that is taken, and says so rather than writing', () => {
  const p = panel({ code: 'kick: s("bd")\nhats: s("hh")\n' });
  assert.equal(p.fns.arCreateGroup(['kick'], 'hats'), null);
  assert.equal(p.cm.text, 'kick: s("bd")\nhats: s("hh")\n', 'the buffer is untouched');
  assert.match(p.logged.join('\n'), /already another pattern's name/);
});

test('ungroup a MEMBER: it leaves the tree, its code and its clips stay put', () => {
  const p = panel({ code: 'drums: group()\nkick: s("bd")\nsnare: s("sd")\n_groups({ "drums": ["kick", "snare"] })\n' });
  assert.equal(p.fns.arUngroup('kick'), true);
  assert.deepEqual(mixctlMod.readGroupTree(p.cm.text), { drums: ['snare'] });
  assert.match(p.cm.text, /^drums: group\(\)\nkick: s\("bd"\)/, 'the track is exactly where it was');
});

test('ungroup a GROUP: its own line goes, and what was in it plays on its own', () => {
  const p = panel({ code: 'drums: group()\nkick: s("bd")\n_groups({ "drums": ["kick"] })\n' });
  assert.equal(p.fns.arUngroup('drums'), true);
  assert.equal(p.cm.text, 'kick: s("bd")\n', 'the mixdown of nothing would be a silent track on the desk');
  assert.match(p.logged.join('\n'), /not a group any more/);
});

test('ungroup the last member: the empty tree takes the whole call with it', () => {
  const p = panel({ code: 'drums: group()\nkick: s("bd")\n_groups({ "drums": ["kick"] })\n' });
  p.fns.arUngroup('kick');
  assert.equal(p.cm.text, 'drums: group()\nkick: s("bd")\n', 'no `_groups({})` left behind');
});

test('an empty buffer gets the stub as its first line', () => {
  const p = panel({ code: '' });
  assert.equal(p.fns.arCreateBlock('pad'), true);
  assert.equal(p.cm.text, 'pad: note("~")\n');
});

// ---------------------------------------------------------------------------------------------
// A base renamed by hand takes its family with it - at the evaluation, once the typing has settled
// ---------------------------------------------------------------------------------------------


test('a track renamed by hand carries its clips and its place in the tree', () => {
  const code = [
    'drums: group()',
    'kick: s("mbd*4")',
    'hats: s("hh*8")',
    '',
    '_arrange("kick,0,8 hats,0,8")',
    '_groups({ "drums": ["kick", "hats"] })',
    '',
  ].join('\n');
  const p = panel({ code });
  p.fns.arFollowHandRenames(); // the evaluation that saw `kick`
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'stomp: s("mbd*4")'); // the hand edit
  p.fns.arFollowHandRenames(); // the next one
  assert.equal(p.cm.text, [
    'drums: group()',
    'stomp: s("mbd*4")',
    'hats: s("hh*8")',
    '',
    '_arrange("stomp,0,8 hats,0,8")',
    '_groups({ "drums": ["stomp", "hats"] })',
    '',
  ].join('\n'));
  assert.match(p.logged.join('\n'), /kick is stomp now - its clips and its group followed/);
});

test('renaming a GROUP by hand keeps everything under it', () => {
  const code = 'drums: group()\nkick: s("bd")\n_groups({ "drums": ["kick"] })\n';
  const p = panel({ code });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('drums: group()', 'kit: group()');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /_groups\(\{ "kit": \["kick"\] \}\)/);
});

test('a rename that also changed the body is left alone - it might be a new track', () => {
  const code = 'kick: s("mbd*4")\n_arrange("kick,0,8")\n';
  const p = panel({ code });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'mainKick: s("mbd*2")');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /_arrange\("kick,0,8"\)/, 'the clips are untouched');
  assert.equal(p.logged.length, 0);
});

test('two new tracks with the same body is ambiguous, so nothing moves', () => {
  const code = 'kick: s("mbd*4")\n_arrange("kick,0,8")\n';
  const p = panel({ code });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'a: s("mbd*4")\n\nb: s("mbd*4")');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /_arrange\("kick,0,8"\)/);
});

test('the first evaluation has nothing to compare against', () => {
  const p = panel({ code: 'hats: s("hh*8")\n\n_arrange("hats,0,8")\n' });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('hats:', 'hh:');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /_arrange\("hh,0,8"\)/, 'the second pass has a before, and follows');
});

test('the word arrange inside a comment or a string is not a call', () => {
  const p = panel({ code: `// arrange("nope,0,0,4")\nkick: s("bd").fx("Rearrange")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.equal(p.fns.arFindDef(), null);
});
