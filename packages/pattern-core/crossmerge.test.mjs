// Step 2 of the all-signals rewrite: the generalized bundle trigger cross-product (crossMerge,
// exercised here through .vel()). Two things it must get right - the `cont` rule (a change on
// either merged channel retriggers; a tie survives only where BOTH channels continue) and the
// channel value-merge (right-wins), so a note step becomes a real note+vel bundle. Pure pattern
// math, no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

// All steps for a cycle (including ties), start-sorted - crossMerge emits base-then-control order.
function grid(sig, cycle = 0) {
  return sig.stepsForCycle(cycle).filter((s) => s.value != null).sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// value-merge: the note step now carries its own `vel` channel (a bundle), right-wins
// ---------------------------------------------------------------------------------------------

test('vel merges onto the note steps as a bundled `vel` channel', () => {
  // Same grid on both sides: one note per vel, each step carries note value AND its vel.
  const sig = n('0 2 4').vel('1 0.5 0.25');
  const g = grid(sig);
  assert.deepEqual(g.map((s) => s.value), [0, 2, 4]);
  assert.deepEqual(g.map((s) => s.vel), [1, 0.5, 0.25]);
});

test('a coarser vel subdivides the notes it overlaps, each sub-event carrying its vel', () => {
  // Two notes over four vel steps: each note splits into two quarter-cycle events.
  const sig = n('0 2').vel('1 0.75 0.5 0.25');
  const g = grid(sig);
  assert.equal(g.length, 4);
  assert.deepEqual(g.map((s) => s.value), [0, 0, 2, 2]);
  assert.deepEqual(g.map((s) => s.vel), [1, 0.75, 0.5, 0.25]);
  close(g[0].start, 0);
  close(g[1].start, 0.25);
  close(g[2].start, 0.5);
  close(g[3].start, 0.75);
});

test('a later .vel() right-wins the bundled channel', () => {
  const sig = n('0 2').vel('0.9 0.9').vel('0.3');
  for (const s of grid(sig)) close(s.vel, 0.3, 'downstream vel overwrites upstream');
});

test('a vel rest drops the event it covers', () => {
  const sig = n('0 2').vel('1 ~');
  const g = grid(sig);
  assert.equal(g.length, 1);
  assert.equal(g[0].value, 0);
  close(g[0].vel, 1);
});

test('a continuous vel (no step grid) leaves the note grid untouched', () => {
  // A plain-number vel has no stepsForCycle, so there is nothing to cross-product: the grid is
  // unchanged and vel rides in the vel note channel for the walker to sample at onset instead.
  const sig = n('0 2 4').vel(0.6);
  assert.deepEqual(grid(sig).map((s) => s.value), [0, 2, 4]);
  assert.ok(grid(sig).every((s) => s.vel === undefined), 'no merged vel channel');
  assert.ok(sig.noteChannels.vel, 'the continuous vel rides in the vel note channel');
});

test('the merged step carries BOTH the note and the vel source spans (highlighting)', () => {
  // mini(str, offset) tags each atom with its [start,end) span; the merge must union them so the
  // live velocity atom lights alongside its note (the editor's playback highlighter reads stepLocs).
  const sig = note(mini('c e g', 0)).vel(mini('1 0.5 0.2', 20));
  const locs = sig.stepsForCycle(0).filter((s) => s.value != null).map((s) => s.locs);
  assert.deepEqual(locs, [
    [[0, 1], [20, 21]], // c + "1"
    [[2, 3], [22, 25]], // e + "0.5"
    [[4, 5], [26, 29]], // g + "0.2"
  ]);
});

// ---------------------------------------------------------------------------------------------
// the cont rule: fresh onset unless BOTH sides are continuing at the boundary
// ---------------------------------------------------------------------------------------------

test('a whole note is re-struck where a vel step changes mid-note', () => {
  // One held note, two vel halves: the vel edge at 0.5 splits it into two fresh strikes.
  const g = grid(note('c4').vel('1 0.5'));
  assert.equal(g.length, 2);
  assert.ok(!g[0].cont, 'first half is an onset');
  assert.ok(!g[1].cont, 'the vel change retriggers - second half is a fresh onset, not a tie');
  close(g[0].vel, 1);
  close(g[1].vel, 0.5);
});

test('a held note (a real cont tie) survives where the vel is also continuing', () => {
  // slow(2) rings n("0") across the cycle boundary: cycle 1 is a `cont` tail (onset was in cycle
  // 0). A vel that is ALSO a cont tail there (slow(2) too) continues on both channels, so the tie
  // is preserved - and the merged step still carries the bundled vel.
  const g = grid(n('0').slow(2).vel(n('1').slow(2)), 1);
  assert.equal(g.length, 1);
  assert.ok(g[0].cont, 'both channels continue across the boundary - the tie holds');
  close(g[0].vel, 1);
});

test('a continuous (non-step) vel leaves a held tie intact', () => {
  // A plain-number vel has no edges, so it never breaks structure: the cont tail stays a tie and
  // the velocity rides in the vel note channel (sampled continuously) rather than as a merged step.
  const g = grid(n('0').slow(2).vel(0.7), 1);
  assert.equal(g.length, 1);
  assert.ok(g[0].cont, 'a continuous vel does not retrigger the held note');
  assert.equal(g[0].vel, undefined, 'nothing merged - continuous vel rides in the note channel');
});

test('a vel edge landing on a held tie retriggers it', () => {
  // Same held tail, but now the vel is a mini onset (a fresh edge) at the boundary: a change on
  // the vel channel restrikes the held note.
  const g = grid(n('0').slow(2).vel('0.5'), 1);
  assert.equal(g.length, 1);
  assert.ok(!g[0].cont, 'the vel edge turns the held tail into a fresh strike');
  close(g[0].vel, 0.5);
});
