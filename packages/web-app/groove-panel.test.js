'use strict';

// The groove panel's reading and writing of `.swing(...)` calls (public/client.js).
//
// The lanes are a canvas and the depths are sliders, neither of which a test can hold - but what the
// panel READS out of a call and WRITES back into one is text arithmetic, and it is where a silent
// wrong answer would live. Two claims carry the feature and both are checked against pattern-core
// itself rather than against a copy of the numbers:
//
//   - turning a plain swing into its drawable table does not move the sound. The panel rewrites
//     `.swing(1/3)` as `.swing(1/3, "0 1 0 1 …")` on a double-click, which is only honest if the two
//     play identically - so the rewritten call is built here and handed to the real builder.
//   - a depth the panel has not touched survives a lane drag as the text it was written as. `1/3` is
//     not 0.3333, and a rewrite that quietly rounded it would move every offbeat by a hair.
//
// Like pianoroll-wave.test.js the functions are lifted out of the shipped client.js rather than
// copied, so this fails if they drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

function grabConst(name) {
  const at = SRC.indexOf(`const ${name} = `);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  const end = SRC.indexOf('\n', at);
  return SRC.slice(at, end);
}

const LIFTED = `${grab('parseSwingCall')}\n\n${grab('serializeSwingCall')}\n\n${grab('splitFirstArg')}\n\n${grabConst('grooveDepthText')}`;

// The lifted readers over a fake module surface. Only the two predicates are reached: a name has
// letters in it and a table does not (see groove.mjs), which is the whole discriminator.
function harness() {
  const grooveMod = require('../pattern-core/src/groove.mjs');
  const ctx = {
    grooveMod,
    grooveTableText: (st) => grooveMod.serializeGroove({ steps: st.time.length, time: st.time, vel: st.vel }),
  };
  const keys = Object.keys(ctx);
  const body = `${LIFTED}\nreturn { parseSwingCall, serializeSwingCall, grooveDepthText };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => ctx[k]));
}

const { parseSwingCall, serializeSwingCall, grooveDepthText } = harness();

// --- what a call says -------------------------------------------------------------------------

test('a bare swing is the triplet shuffle, not a swing of nothing', () => {
  const read = parseSwingCall('');
  assert.equal(read.depth.toFixed(6), (1 / 3).toFixed(6));
  assert.equal(read.depthText, '1/3');
});

test('a fraction in the depth is read as one, since Number() would make it NaN', () => {
  const read = parseSwingCall('1/3');
  assert.equal(read.depth.toFixed(6), (1 / 3).toFixed(6));
  assert.equal(read.depthText, '1/3', 'and is remembered as it was written');
  assert.equal(parseSwingCall('2 / 3').depth.toFixed(6), (2 / 3).toFixed(6));
});

test('a name in the shape position is a groove, and a number is the subdivision it always was', () => {
  assert.equal(parseSwingCall('0.4, "clave16"').name, 'clave16');
  assert.equal(parseSwingCall('0.4, "clave16"').grid, null);
  // The reading that must not change: a string of numbers there is a patterned subdivision.
  assert.equal(parseSwingCall('0.5, "<8 16>"').name, null);
  assert.equal(parseSwingCall('0.5, "<8 16>"').grid, '<8 16>');
  assert.equal(parseSwingCall('0.2, 16').grid, '16');
  assert.equal(parseSwingCall('0.2, 16').name, null);
});

test('a name on its own is that groove at full depth', () => {
  const read = parseSwingCall('"samba"');
  assert.equal(read.name, 'samba');
  assert.equal(read.depth, 1);
});

test('a bracketed list in the shape position is a table written inline', () => {
  assert.deepEqual(parseSwingCall('1, [0, 0.5, 0, 0.5]').data, [0, 0.5, 0, 0.5]);
});

// --- what the panel writes --------------------------------------------------------------------

const stateFor = (over = {}) => ({ time: [0, 1], vel: null, depth: 1, depthText: null, velDepth: 1, velSet: false, grooveId: null, ...over });

test('an untouched depth is written back as the text it was read as', () => {
  const st = stateFor({ depth: 1 / 3, depthText: '1/3' });
  assert.equal(grooveDepthText(st), '1/3');
  assert.equal(serializeSwingCall(st), '.swing(1/3, "0 1")');
});

test('a depth the slider moved is written as the number that was asked for', () => {
  assert.equal(grooveDepthText(stateFor({ depth: 0.42, depthText: null })), '0.42');
  assert.equal(grooveDepthText(stateFor({ depth: 1, depthText: null })), '1', 'and a plain 1 stays plain');
});

test('a named groove is written as its name, and the accent depth only once it is set', () => {
  assert.equal(serializeSwingCall(stateFor({ grooveId: 'samba' })), '.swing(1, "samba")');
  assert.equal(
    serializeSwingCall(stateFor({ grooveId: 'samba', velSet: true, velDepth: 0.5 })),
    '.swing(1, "samba").swingvel(0.5)'
  );
});

test('a velocity row is only written when it says something', () => {
  assert.equal(serializeSwingCall(stateFor({ time: [0, 1], vel: [1, 1] })), '.swing(1, "0 1")');
  assert.equal(serializeSwingCall(stateFor({ time: [0, 1], vel: [1, 0.8] })), '.swing(1, "0 1 / 1 0.8")');
});

// --- the claim that makes the rewrite honest --------------------------------------------------

test('turning a plain swing into its table does not move a single onset', async () => {
  const { s, timeShift } = await import('../pattern-core/src/signal.mjs');
  const shiftsOf = (sig) => sig.stepsForCycle(0).map((step) => {
    const at = step.start;
    return Number(timeShift(step, sig.noteChannels, at, 1, at, sig.groove).toFixed(12));
  });
  // What grooveMakeDrawable writes, for each call it will accept: the alternating table at the
  // call's own grid, at the call's own depth.
  for (const [amount, grid] of [[1 / 3, 8], [0.2, 16], [0.5, 4], [-0.1, 8], [0.25, 32]]) {
    const table = Array.from({ length: grid }, (_, k) => (k % 2 ? 1 : 0));
    assert.deepEqual(
      shiftsOf(s('hh*16').swing(amount, table)),
      shiftsOf(s('hh*16').swing(amount, grid)),
      `swing(${amount}, ${grid}) must survive being made drawable`
    );
  }
});

// --- the lanes' geometry ----------------------------------------------------------------------
//
// A bar drawn outside its own lane is a thing nothing else would report: it isn't an exception, it
// doesn't change what plays, and looking at it is the only other way to find it. push16's bars ran a
// full lane height past the top (2026-09-30), because the lane was scaled to where PLAYBACK clamps
// (half a slot) rather than to what a table VALUE can be - and every alternating preset is written
// with whole slots.

const { grooveTimeReach } = (() => {
  const body = `${grab('grooveTimeReach')}\nreturn { grooveTimeReach };`;
  // eslint-disable-next-line no-new-func
  return new Function('GROOVE_LANE_TIME', body)(1);
})();

// What drawGroove computes for one slot, as a share of half the lane's height: inside the box means
// at most 1. The sign is the direction the bar grows, which is not what is being checked here.
const barShare = (value, row) => Math.abs(value / grooveTimeReach(row));

test('every groove that ships draws inside its lane', () => {
  const grooveMod = require('../pattern-core/src/groove.mjs');
  for (const [name, data] of Object.entries(grooveMod.GROOVE_PRESETS)) {
    const table = grooveMod.parseGroove(data);
    for (const v of table.time) {
      assert.ok(barShare(v, table.time) <= 1, `${name}: a slot at ${v} draws ${barShare(v, table.time)} of the half-lane`);
    }
  }
});

test('the lane reaches a whole slot, which is what the alternating presets are written with', () => {
  assert.equal(grooveTimeReach([0, 1, 0, 1]), 1);
  assert.equal(grooveTimeReach([0, -1, 0, -1]), 1, 'pushed early, the same reach');
  assert.equal(grooveTimeReach([0, 0.3]), 1, 'a gentle table still reads against a whole slot');
});

test('a table written past a whole slot grows the lane rather than drawing outside it', () => {
  assert.equal(grooveTimeReach([0, 2]), 2);
  assert.equal(grooveTimeReach([0, 1.2]), 1.5, 'rounded up to a half, so the scale stays readable');
  for (const row of [[0, 2], [0, -1.7], [0, 1.2, -3]]) {
    for (const v of row) assert.ok(barShare(v, row) <= 1, `${v} of ${row} fits`);
  }
});

// --- the effective overlay --------------------------------------------------------------------
//
// The bright fill and cap on each bar claim to be "what plays at the current depths". That claim is
// only worth drawing if it is the player's own arithmetic, so grooveEffective is checked against
// pattern-core here - the shift timeShift emits and the scale grooveVelScale applies - rather than
// against a copy of the formulas.

function effectiveWith(depth, velDepth) {
  const body = `${grab('grooveEffective')}\nreturn grooveEffective;`;
  // eslint-disable-next-line no-new-func
  return new Function('grooveState', body)({ depth, velDepth });
}

test('the time cap is the shift the player emits, stop and gate included', async () => {
  const { s, timeShift } = await import('../pattern-core/src/signal.mjs');
  for (const depth of [0, 0.25, 1, 2]) {
    for (const v of [0, 0.3, 1, -1, -0.4]) {
      const sig = s('hh*2').swing(depth, [0, v]);
      const step = sig.stepsForCycle(0)[1];
      const played = timeShift(step, sig.noteChannels, step.start, 1, step.start, sig.groove) * 2; // cycles -> slot units
      assert.equal(
        effectiveWith(depth, 1)('time', v).toFixed(10),
        played.toFixed(10),
        `depth ${depth}, value ${v}`
      );
    }
  }
});

test('the accent cap is the scale the player applies, gate included', async () => {
  const { note, grooveVelScale } = await import('../pattern-core/src/signal.mjs');
  for (const [depth, velDepth] of [[1, 1], [0.4, 1], [1, 0.5], [1, 0], [0, 1], [1, 4]]) {
    for (const v of [1, 0.5, 2, 0]) {
      const sig = note('c3*2').swing(depth, { time: [0, 0], vel: [1, v] }).swingvel(velDepth);
      const step = sig.stepsForCycle(0)[1];
      const played = grooveVelScale(step, sig.noteChannels, step.start, 1, step.start, sig.groove);
      assert.equal(
        effectiveWith(depth, velDepth)('vel', v).toFixed(10),
        played.toFixed(10),
        `depth ${depth}, swingvel ${velDepth}, value ${v}`
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Selecting, lifting and copying a run of slots
// ---------------------------------------------------------------------------------------------
//
// The lanes are drawable with the pencil AND selectable with the arrow (the paradigm the roll's
// grid, its value lane and the arrangement all share). The pointer half is geometry a test can't
// hold, but what the ops DO to the table is arithmetic, and it is lifted out of client.js the same
// way the readers above are.

const SEL_OPS = [
  'grooveRange', 'grooveValuePerPx', 'grooveSelSpan', 'grooveRow', 'grooveClearSel', 'grooveSelectAll',
  'groovePutRun', 'grooveCopySel', 'grooveResetSel', 'groovePasteSel', 'grooveDuplicateSel',
  'grooveNudgeSel', 'grooveMoveSel', 'grooveKeydown', 'grooveSetSlot', 'grooveTimeReach',
];

function selHarness(table) {
  const lifted = [
    ...SEL_OPS.map((n) => grab(n)),
    grabConst('grooveQuantize'),
    grabConst('grooveNeutral'),
  ].join('\n\n');
  const ctx = {
    GROOVE_MAX_VEL: 2,
    GROOVE_LANE_TIME: 1,
    drawGroove: () => {},
    writeGrooveCall: () => {},
    grooveLiveSync: () => {},
    editMod: (e) => !!e.metaKey,
  };
  const keys = Object.keys(ctx);
  const body = `
    let grooveState = ${JSON.stringify(table)};
    let grooveSel = null;
    let grooveCaret = 0;
    let grooveClipboard = null;
    ${lifted}
    return {
      state: () => grooveState,
      sel: () => grooveSel,
      select: (lane, a, b) => { grooveSel = { lane, a, b }; },
      caret: (k) => { grooveCaret = k; },
      clip: () => grooveClipboard,
      ops: { grooveSelSpan, grooveCopySel, grooveResetSel, groovePasteSel, grooveDuplicateSel,
             grooveNudgeSel, grooveMoveSel, grooveSelectAll, grooveKeydown, grooveRange, grooveValuePerPx },
    };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => ctx[k]));
}

const EIGHTS = { time: [0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3], vel: null };

test('a selected run is clamped to the table, however it was dragged', () => {
  const h = selHarness(EIGHTS);
  h.select('time', 5, 2); // dragged leftwards
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 2, b: 5 });
  h.select('time', 6, 99); // dragged off the end
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 6, b: 8 });
  h.select('time', 3, 3); // a click, not a drag - one slot, never nothing
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 3, b: 4 });
});

test('a run lifted by a nudge keeps the differences inside it', () => {
  const h = selHarness(EIGHTS);
  h.select('time', 0, 4);
  h.ops.grooveNudgeSel(0.1);
  assert.deepEqual(h.state().time, [0.1, 0.4, 0.1, 0.4, 0, 0.3, 0, 0.3], 'the selected four moved together');
});

test('a lift stops at the lane\'s limits rather than running past them', () => {
  const h = selHarness({ time: [0, 0.3, 0, 0.3], vel: null });
  h.select('time', 0, 4);
  h.ops.grooveNudgeSel(5);
  const { hi } = h.ops.grooveRange('time');
  assert.deepEqual(h.state().time, [hi, hi, hi, hi], 'everything is held at the stop');
  h.ops.grooveNudgeSel(-50);
  const { lo } = h.ops.grooveRange('time');
  assert.deepEqual(h.state().time, [lo, lo, lo, lo]);
});

test('copy and paste move a run of timings, and keep it in its own lane', () => {
  const h = selHarness(EIGHTS);
  h.select('time', 0, 2);
  h.ops.grooveCopySel();
  assert.deepEqual(h.clip(), { lane: 'time', values: [0, 0.3] });
  h.select('time', 4, 6);
  h.ops.groovePasteSel();
  assert.deepEqual(h.state().time, [0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3], 'the same two values, so nothing moved');
  h.select('time', 2, 4);
  h.ops.grooveNudgeSel(0.2); // make the copy distinguishable
  h.ops.grooveCopySel();
  h.select('time', 6, 8);
  h.ops.groovePasteSel();
  assert.deepEqual(h.state().time, [0, 0.3, 0.2, 0.5, 0, 0.3, 0.2, 0.5]);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 6, b: 8 }, 'what was pasted is what is selected');
});

test('a run copied from the accent lane pastes into the accent lane', () => {
  const h = selHarness({ time: [0, 0, 0, 0], vel: [1, 0.5, 1, 1] });
  h.select('vel', 0, 2);
  h.ops.grooveCopySel();
  // Selected in the OTHER lane: the clip still knows where it came from, and lands there.
  h.select('time', 2, 4);
  h.ops.groovePasteSel();
  assert.deepEqual(h.state().vel, [1, 0.5, 1, 0.5], 'pasted at the selection\'s slots, in its own lane');
  assert.deepEqual(h.state().time, [0, 0, 0, 0], 'and the timings are untouched');
});

test('a cut leaves the lane resting, and the accent lane rests at 1', () => {
  const h = selHarness({ time: [0.2, 0.2, 0.2, 0.2], vel: [0.4, 0.4, 0.4, 0.4] });
  h.select('time', 1, 3);
  h.ops.grooveCopySel({ clear: true });
  assert.deepEqual(h.state().time, [0.2, 0, 0, 0.2]);
  h.select('vel', 0, 2);
  h.ops.grooveResetSel();
  assert.deepEqual(h.state().vel, [1, 1, 0.4, 0.4]);
});

test('a velocity row is created by editing the accent lane, not before', () => {
  const h = selHarness({ time: [0, 0, 0, 0], vel: null });
  h.select('vel', 1, 2);
  h.ops.grooveNudgeSel(-0.5);
  assert.deepEqual(h.state().vel, [1, 0.5, 1, 1], 'the row appears resting, with the edit in it');
});

test('duplicate puts the run immediately after itself', () => {
  const h = selHarness({ time: [0.1, 0.2, 0, 0, 0, 0, 0, 0], vel: null });
  h.select('time', 0, 2);
  h.ops.grooveDuplicateSel();
  assert.deepEqual(h.state().time, [0.1, 0.2, 0.1, 0.2, 0, 0, 0, 0]);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 2, b: 4 });
});

test('a paste or duplicate that would run off the end is clipped, not wrapped', () => {
  const h = selHarness({ time: [0.1, 0.2, 0.3, 0.4], vel: null });
  h.select('time', 0, 3);
  h.ops.grooveDuplicateSel();
  assert.deepEqual(h.state().time, [0.1, 0.2, 0.3, 0.1], 'one slot of room, one slot written');
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 3, b: 4 });
});

test('the selection can be walked along the lane, keeping its width', () => {
  const h = selHarness(EIGHTS);
  h.select('time', 2, 4);
  h.ops.grooveMoveSel(1);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 3, b: 5 });
  h.ops.grooveMoveSel(-99);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 0, b: 2 }, 'stopping at the start');
  h.ops.grooveMoveSel(99);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 6, b: 8 }, 'and at the end');
});

test('the keys do what they do everywhere else in the app', () => {
  const h = selHarness(EIGHTS);
  const key = (k, mod = false) => h.ops.grooveKeydown({ key: k, metaKey: mod });
  assert.equal(key('a', true), true);
  assert.deepEqual(h.ops.grooveSelSpan(), { lane: 'time', a: 0, b: 8 }, 'mod+A is the whole lane');
  h.select('time', 0, 2);
  assert.equal(key('c', true), true);
  assert.deepEqual(h.clip().values, [0, 0.3]);
  assert.equal(key('Delete'), true);
  assert.deepEqual(h.state().time.slice(0, 2), [0, 0], 'delete rests the run');
  assert.equal(key('v', true), true);
  assert.deepEqual(h.state().time.slice(0, 2), [0, 0.3], 'and paste puts it back');
  // Up is EARLY on the time lane - the direction the bars go.
  h.select('time', 1, 2);
  assert.equal(key('ArrowUp'), true);
  assert.equal(h.state().time[1], 0.25);
  assert.equal(key('ArrowDown', true), true);
  assert.equal(h.state().time[1], 0.26, 'mod is the fine step, a hundredth');
  assert.equal(key('Escape'), true);
  assert.equal(h.sel(), null, 'escape lets go of the run before anything closes');
  assert.equal(key('ArrowUp'), false, 'with nothing selected the lanes want none of these keys');
  assert.equal(key('q'), false);
});

test('up is louder on the accent lane, where up is also up', () => {
  const h = selHarness({ time: [0, 0, 0, 0], vel: [1, 1, 1, 1] });
  h.select('vel', 0, 1);
  h.ops.grooveKeydown({ key: 'ArrowUp', metaKey: false });
  assert.equal(h.state().vel[0], 1.05, 'louder');
  h.ops.grooveKeydown({ key: 'ArrowDown', metaKey: false });
  h.ops.grooveKeydown({ key: 'ArrowDown', metaKey: false });
  assert.equal(h.state().vel[0], 0.95, 'and quieter');
});

test('a pixel of drag is worth the same up as down, and the right way round in each lane', () => {
  const h = selHarness(EIGHTS);
  const m = { time: { top: 0, height: 100, bottom: 100 }, vel: { top: 100, height: 100, bottom: 200 } };
  // Down is LATE on the time lane and QUIETER on the accent lane (see drawGroove's offOf).
  assert.ok(h.ops.grooveValuePerPx('time', m) > 0, 'dragging down on the time lane plays later');
  assert.ok(h.ops.grooveValuePerPx('vel', m) < 0, 'dragging down on the accent lane plays quieter');
});
