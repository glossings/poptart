// Clip rolls in the arrangement painter (public/client.js): the editor's half of clips(). A track
// headed by clips() plays what is DRAWN IN each of its clips rather than one pattern gated to them,
// so on such a row the painter mints a roll per clip, files its id in the clip, and keeps the two
// in step - through a rename, a delete, a copy and a fork.
//
// What a clip roll MEANS at playback time lives in pattern-core's clips.test.mjs, next to the head
// that plays it. This is the bookkeeping: which rows are clips() rows, who owns which roll, and
// the one gesture that unpicks a link.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as arrangeMod from '../pattern-core/src/arrange.mjs';
import * as labelsMod from '../pattern-core/src/labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'public', 'client.js'), 'utf8');

/** One function's source out of the shipped client.js (see arrange-tracks.test.mjs's twin). */
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

/** A CodeMirror stand-in over a plain string. */
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

// The roll registry, as much of it as the painter touches - over the same `_roll("id", body)`
// lines the real one writes, so a definition minted here is one the real one would find.
const ROLL_RE = /_roll\(\s*"([^"]+)"\s*,/g;
const rollDefsStub = {
  allIds: (sc, code) => [...code.matchAll(ROLL_RE)].map((m) => ({ id: m[1], scope: '' })),
  findDef(code, id) {
    ROLL_RE.lastIndex = 0;
    for (const m of code.matchAll(ROLL_RE)) {
      if (m[1] !== String(id)) continue;
      const open = code.indexOf('(', m.index);
      let depth = 0;
      for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) return { id: m[1], start: m.index, open, close: i };
      }
    }
    return null;
  },
  defsEdit: (code, ids, bodyFor = null) => [code.length, code.length,
    `\n${ids.map((id) => `_roll(${JSON.stringify(id)}, ${bodyFor ? bodyFor(id) : '""'})`).join('\n')}`],
};

const LIFTED = ['matchParen', 'codeOnly', 'splitFirstArg', 'freshDefId', 'arFindDef', 'arReadDef',
  'parseArrangeCall', 'arCallOpts', 'serializeArrangeCall', 'arBlocks', 'arLabels',
  'arClipsLabels', 'arIsClipsRow', 'arAllClips', 'arTrackOfRoll', 'arClipRefCount', 'arClipRenameEdits',
  'arRollBody', 'arMintRolls', 'arFillClipRolls', 'arUnlinkClips', 'arClipPiece']
  .map(grab)
  .concat([grabConst('preferredDefId'), grabConst('arClipsOfRoll'), grabConst('arMintRoll')])
  .join('\n\n');

const RETURNS = ['arClipsLabels', 'arIsClipsRow', 'arTrackOfRoll', 'arClipRefCount', 'arClipRenameEdits',
  'arRollBody', 'arMintRolls', 'arFillClipRolls', 'arUnlinkClips', 'arClipPiece', 'arReadDef', 'arAllClips'];

/** The lifted clip-roll functions over a fake editor and (optionally) an open painter. */
function painter({ code = '', clips = null, deck = 'a' } = {}) {
  const cm = fakeCm(code);
  const logged = [];
  const wrote = { n: 0 };
  const arState = clips ? { clips, sel: new Set(), rows: [] } : null;
  const env = {
    arCM: cm,
    cm,
    arState,
    arDeck: deck,
    arrangeMod,
    labelsMod,
    rollDefs: rollDefsStub,
    arSuppressClose: false,
    arRefold: () => {},
    logLine: (line) => logged.push(line),
    writeArrangeCall: () => { wrote.n++; },
    drawArrange: () => {},
  };
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys, `${LIFTED}\nreturn { ${RETURNS.join(', ')} };`);
  return { fns: build(...keys.map((k) => env[k])), cm, logged, wrote, arState };
}

const shape = (cs) => cs.map((c) => [c.label, c.start, c.len, c.roll ?? null, c.off ?? 0]);

// ---------------------------------------------------------------------------------------------
// Which rows are clips() rows
// ---------------------------------------------------------------------------------------------

test('a clips() row is one whose block calls it - and the word alone is not a call', () => {
  const code = [
    'kick: clips().s("bd")',
    'bass: n("0 3").synth("Serum 2")',
    'hat: clips()',
    '// lead: clips() one day',
    'pad: n("0").s("clips()")',
  ].join('\n\n');
  const { fns } = painter({ code });
  assert.deepEqual([...fns.arClipsLabels()].sort(), ['hat', 'kick']);
  assert.ok(fns.arIsClipsRow('kick'));
  assert.ok(!fns.arIsClipsRow('bass'), 'an ordinary track plays one pattern wherever it is painted');
  assert.ok(!fns.arIsClipsRow('pad'), 'the word inside a string is not a call');
  assert.ok(!fns.arIsClipsRow(null));
});

// ---------------------------------------------------------------------------------------------
// Minting: every clip on such a row has a roll to draw in
// ---------------------------------------------------------------------------------------------

test('every roll-less clip on a clips() row gets one, named after its track', () => {
  const code = 'kick: clips().s("bd")\n\nbass: n("0").synth("X")\n\n_arrange("bass,0,8 kick,0,4 kick,4,4")';
  const { fns, cm } = painter({ code });
  const clips = fns.arReadDef(cm.getValue()).clips;
  assert.equal(fns.arFillClipRolls(clips), 2);
  assert.deepEqual(shape(clips), [
    ['bass', 0, 8, null, 0],
    ['kick', 0, 4, 'kick', 0],
    ['kick', 4, 4, 'kick2', 0],
  ], 'the track\'s own name first, then the next free spelling of it - and no other row is touched');
  // ...and the definitions are really in the buffer, so double-clicking the clip has one to open.
  assert.match(cm.getValue(), /_roll\("kick", ""\)\n_roll\("kick2", ""\)/);
  assert.equal(fns.arFillClipRolls(clips), 0, 'a second pass has nothing left to do');
});

test('minting steps over a name the buffer already uses, roll or clip', () => {
  const code = 'kick: clips().s("bd")\n\n_arrange("kick,0,4 kick,4,4")\n_roll("kick", "60,0,4")';
  const { fns, cm } = painter({ code });
  const clips = fns.arReadDef(cm.getValue()).clips;
  clips[1].roll = 'kick3'; // already claimed by a clip, though nothing defines it yet
  fns.arFillClipRolls(clips);
  assert.deepEqual(shape(clips), [['kick', 0, 4, 'kick2', 0], ['kick', 4, 4, 'kick3', 0]]);
});

test('a muted clip is minted a roll too - unmuting one should play what is drawn in it', () => {
  const code = 'kick: clips().s("bd")\n\n_arrange("kick,0,4,m")';
  const { fns, cm } = painter({ code });
  const clips = fns.arReadDef(cm.getValue()).clips;
  assert.equal(fns.arFillClipRolls(clips), 1);
  assert.equal(clips[0].roll, 'kick');
});

// ---------------------------------------------------------------------------------------------
// Links - two clips, one roll
// ---------------------------------------------------------------------------------------------

test('make unique forks only what is actually shared, and copies the notes it forks', () => {
  const code = 'kick: clips().s("bd")\n\n_arrange("kick,0,4,rkick kick,4,4,rkick kick,8,4,rkick2")\n'
    + '_roll("kick", "60,0,4", { grid: 16 })\n_roll("kick2", "62,0,4")';
  const clips = arrangeMod.parseArrangement('kick,0,4,rkick kick,4,4,rkick kick,8,4,rkick2');
  const { fns, cm, logged, wrote } = painter({ code, clips });

  fns.arUnlinkClips([clips[1], clips[2]]);
  assert.deepEqual(shape(clips), [
    ['kick', 0, 4, 'kick', 0],
    ['kick', 4, 4, 'kick3', 0],
    ['kick', 8, 4, 'kick2', 0],
  ], 'the shared one splits off; the one that was already its own is left alone');
  assert.match(cm.getValue(), /_roll\("kick3", "60,0,4", \{ grid: 16 \}\)/, 'the copy carries the notes AND the grid');
  assert.equal(wrote.n, 1);
  assert.match(logged.join('\n'), /1 clip has notes of its own now/);
});

test('make unique on nothing shared says so rather than making a copy of nothing', () => {
  const clips = arrangeMod.parseArrangement('kick,0,4,rkick bass,0,4');
  const { fns, logged, wrote } = painter({ code: '_roll("kick", "")', clips });
  fns.arUnlinkClips([clips[0]]);
  assert.match(logged.join('\n'), /already have rolls of their own/);
  fns.arUnlinkClips([clips[1]]);
  assert.match(logged.join('\n'), /only a clips\(\) track/);
  assert.equal(wrote.n, 0, 'and neither writes');
});

// ---------------------------------------------------------------------------------------------
// A clip is a reference: rename and delete have to see it
// ---------------------------------------------------------------------------------------------

test('a clip counts as a reference to its roll, so the picker cannot delete one out from under it', () => {
  const code = '_arrange("kick,0,4,rverse kick,4,4,rverse hat,0,8")\n_roll("verse", "")';
  const { fns } = painter({ code });
  assert.equal(fns.arClipRefCount(code, 'verse'), 2);
  assert.equal(fns.arClipRefCount(code, 'chorus'), 0);
  assert.equal(fns.arClipRefCount('kick: clips()', 'verse'), 0, 'no arrangement, no clip references');
});

test('renaming a roll carries every clip that plays it, and the open painter with them', () => {
  const code = 'kick: clips().s("bd")\n\n_arrange("kick,0,4,rverse kick,4,4,rverse,o4 hat,0,8", { len: 8 })';
  const clips = arrangeMod.parseArrangement('kick,0,4,rverse kick,4,4,rverse,o4 hat,0,8');
  const { fns } = painter({ code, clips });
  const edits = fns.arClipRenameEdits(code, 'verse', 'chorus');
  assert.equal(edits.length, 1);
  const [from, to, text] = edits[0];
  assert.equal(code.slice(from, to).slice(0, 9), '_arrange(');
  assert.match(text, /hat,0,8 kick,0,4,rchorus kick,4,4,rchorus,o4/, 'the offsets ride along untouched');
  assert.match(text, /len: 8/, 'and so do the options');
  assert.deepEqual(clips.map((c) => c.roll ?? null), ['chorus', 'chorus', null],
    'the painter holds its own copy while it is open, so it follows rather than reverting');
  assert.deepEqual(fns.arClipRenameEdits(code, 'nobody', 'x'), [], 'a roll no clip plays needs no edit');
});

test('the track that plays a roll is the row its clip is on - what the panel previews through', () => {
  const code = 'lead: clips().synth("Serum 2")\n\n_arrange("lead,0,4,rverse")';
  const { fns } = painter({ code });
  assert.equal(fns.arTrackOfRoll('verse'), 'lead');
  assert.equal(fns.arTrackOfRoll('nobody'), null);
});

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

test('a piece of a clip enters its roll that much further in - and a plain clip has no offset', () => {
  const { fns } = painter();
  const c = { label: 'kick', start: 4, len: 8, roll: 'verse' };
  assert.deepEqual(fns.arClipPiece(c, 8, 4), { label: 'kick', start: 8, len: 4, roll: 'verse', off: 4 });
  assert.deepEqual(fns.arClipPiece(c, 4, 4), { label: 'kick', start: 4, len: 4, roll: 'verse' },
    'the first piece starts where the clip did, so it carries no offset at all');
  assert.deepEqual(fns.arClipPiece({ label: 'bass', start: 0, len: 8 }, 4, 4), { label: 'bass', start: 4, len: 4 },
    'an ordinary track has nothing to be offset into');
});

test('the painter reads the clips in hand while it is open, and the buffer when it is not', () => {
  // Every question about who plays which roll goes through this, so a stale read here is a fork
  // that silently forks the wrong clip.
  const code = '_arrange("kick,0,4,rverse")';
  assert.deepEqual(shape(painter({ code }).fns.arAllClips()), [['kick', 0, 4, 'verse', 0]]);
  const clips = arrangeMod.parseArrangement('kick,0,8,rchorus');
  assert.deepEqual(shape(painter({ code, clips }).fns.arAllClips()), [['kick', 0, 8, 'chorus', 0]]);
});

test('a span copied out of the middle of a clip carries where in the roll it came from', () => {
  // arClipsIn/arClearTime are lifted by arrange-region.test.js; here only the rule they now share
  // with split is pinned in the shipped source, so a bare spread cannot creep back into either.
  assert.match(SRC, /out\.push\(\{ \.\.\.arClipPiece\(c, start, end - start\), start: start - a \}\);/);
  assert.match(SRC, /kept\.push\(arClipPiece\(c, b, end - b\)\);/);
});
