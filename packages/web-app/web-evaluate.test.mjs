// The browser's evaluate, driven end to end.
//
// This is the one test in the web build that puts the whole chain together: real pattern-core,
// the real browser evaluate, and the real Web Audio engine against a stand-in audio graph. There
// is no server and no browser, and it still exercises everything between a buffer of text and a
// note reaching a device - which is the part that had to be ported, and therefore the part most
// likely to be subtly wrong.
//
// It also holds the drift guard: the list of names an evaluated block gets is read out of
// server.js's own source and compared with the browser's. The two are separate code today, and
// a builder that exists on one side and not the other is a pattern that runs on the desktop and
// throws in somebody's browser with no other warning.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { BUILDER_NAMES, INTERNAL_BUILDERS, createBlockEvaluator } from './public/web/block-eval.mjs';
import { createEvaluator, highlightGrid, paramLabels } from './public/web/evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeRig() {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });
  const evaluator = createEvaluator({ patternCore, engine, transport });
  return { ctx, engine, transport, evaluator, warnings };
}

/** Every scheduler this rig started runs on a timer, so a test that made one has to end it. */
function shutdown(rig) {
  for (const sch of rig.evaluator.schedulers.values()) sch.stop();
}

// ---- the language both builds have to agree on --------------------------------------------------

test('the browser binds exactly the names the desktop binds in an evaluated block', () => {
  const source = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
  const read = (name) => {
    const at = source.indexOf(`const ${name} = [`);
    assert.ok(at > 0, `${name} should still be a literal list in server.js`);
    const end = source.indexOf('];', at);
    // The list is interleaved with prose explaining the groups in it, and that prose contains
    // apostrophes - so the comments come out before anything is read as a quoted name.
    const body = source.slice(at, end).replace(/\/\/[^\n]*/g, '');
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  assert.deepEqual(read('BUILDER_NAMES'), [...BUILDER_NAMES], 'a builder on one side only is a pattern that runs in one build');
  assert.deepEqual(read('INTERNAL_BUILDERS'), [...INTERNAL_BUILDERS]);
});

test('every name the browser binds is actually something pattern-core exports', () => {
  const missing = BUILDER_NAMES.filter((n) => patternCore[n] === undefined);
  assert.deepEqual(missing, [], 'a name bound to undefined is a silent failure inside somebody\'s pattern');
  const missingInternal = INTERNAL_BUILDERS.filter((n) => patternCore[n] === undefined);
  assert.deepEqual(missingInternal, []);
});

test('a block can declare something and the block below it can use it', () => {
  const evalBlock = createBlockEvaluator(patternCore, {});
  evalBlock('const kicks = "bd*4"');
  const sig = evalBlock('s(kicks)');
  assert.ok(sig instanceof patternCore.Sig);
  assert.equal(evalBlock.defs.get('kicks'), 'bd*4');
});

test('a userland method added to the language works on a bare string too', () => {
  const evalBlock = createBlockEvaluator(patternCore, {});
  evalBlock('Signal.prototype.twice = function () { return this.fast(2); }');
  const sig = evalBlock('"bd sd".twice()');
  assert.ok(sig instanceof patternCore.Sig, 'a string should have picked the method up');
});

// ---- a buffer becoming music ---------------------------------------------------------------------

test('evaluating a named block builds a track, a scheduler and an engine chain', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('kick: s("bd*4").synth("Wavetable")');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].label, 'kick');
  assert.ok(rig.evaluator.schedulers.has('kick'));
  const tid = rig.evaluator.trackIds.get('kick');
  assert.ok(rig.engine.tracks.has(tid), 'the engine should have been given a track');
  assert.equal(rig.transport.paused, false, 'and the clock should have started');
  shutdown(rig);
});

test('a scheduler survives re-evaluation, so editing one track does not cut its sound', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")');
  const first = rig.evaluator.schedulers.get('kick');
  const firstId = rig.evaluator.trackIds.get('kick');
  rig.evaluator.evaluate('kick: s("bd*8")');
  assert.equal(rig.evaluator.schedulers.get('kick'), first, 'the same scheduler is re-programmed');
  assert.equal(rig.evaluator.trackIds.get('kick'), firstId, 'and keeps the engine track it had');
  shutdown(rig);
});

test('a track whose block disappears is stopped and forgotten', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")\n\nhat: s("hh*8")');
  assert.equal(rig.evaluator.schedulers.size, 2);
  rig.evaluator.evaluate('kick: s("bd*4")');
  assert.deepEqual([...rig.evaluator.schedulers.keys()], ['kick']);
  shutdown(rig);
});

test('a muted track stops and a soloed one silences everything else', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")\n\nhat: s("hh*8")');
  rig.evaluator.evaluate('_kick: s("bd*4")\n\nhat: s("hh*8")');
  assert.deepEqual([...rig.evaluator.schedulers.keys()], ['hat'], 'a muted track is not playing');
  rig.evaluator.evaluate('Skick: s("bd*4")\n\nhat: s("hh*8")');
  assert.deepEqual([...rig.evaluator.schedulers.keys()], ['kick'], 'a solo leaves only what is soloed');
  shutdown(rig);
});

test('a block that evaluates to nothing is an error the buffer can be fixed from', () => {
  const rig = makeRig();
  assert.throws(() => rig.evaluator.evaluate('kick: 42'), /kick: .*must evaluate to a pattern/);
  shutdown(rig);
});

test('a failed evaluation applies nothing, so what is playing keeps playing', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")');
  const before = rig.evaluator.schedulers.get('kick');
  assert.throws(() => rig.evaluator.evaluate('kick: s("bd*4")\n\nbroken: nope()'));
  assert.equal(rig.evaluator.schedulers.get('kick'), before, 'the good track is untouched');
  assert.ok(before.running);
  shutdown(rig);
});

test('setbpm moves the clock, and the tempo it set survives the next evaluation', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('setbpm(140)\n\nkick: s("bd*4")');
  assert.ok(Math.abs(rig.transport.cps * 240 - 140) < 1e-9);
  rig.evaluator.evaluate('kick: s("bd*4")');
  assert.ok(Math.abs(rig.transport.cps * 240 - 140) < 1e-9, 'a buffer with no setbpm leaves the tempo alone');
  shutdown(rig);
});

test('setscale sets the key for the whole buffer however far down it is written', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('lead: n("0 2 4").scale("F minor")\n\nsetscale("F minor")');
  assert.ok(result.scale, 'the buffer should report the key it plays in');
  shutdown(rig);
});

test('a $: block that makes no sound says so rather than failing', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('$: const x = 1');
  assert.ok(result.log.some((l) => l.includes('$:')), 'it is worth a line, not an error');
  shutdown(rig);
});

// ---- what the editor draws ------------------------------------------------------------------------

test('a track reports the grid its notes fall on, with the characters that made them', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('kick: s("bd*4")');
  const grid = result.tracks[0].grid;
  assert.equal(grid.length, 32);
  assert.equal(grid[0].steps.length, 4, 'four onsets in the first cycle');
  const [first] = grid[0].steps;
  assert.ok(first.locs.length, 'each step names the source it came from');
  assert.ok(first.locs[0][0] >= 0, 'rebased to the block rather than the document');
  shutdown(rig);
});

test('a later window of the same grid can be asked for and lines up', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")');
  const window = rig.evaluator.highlightWindow(64, 8);
  assert.equal(window.gridFrom, 64);
  assert.equal(window.gridCount, 8);
  assert.equal(window.tracks[0].grid[0].cycle, 64);
  shutdown(rig);
});

test('a modulated parameter lights up the same way the note pattern does', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('kick: s("bd*4").synth("Wavetable").param("Filter Cutoff", "200 4000")');
  const steps = result.tracks[0].grid[0].steps;
  assert.ok(steps.length > 4, 'the parameter pattern contributes its own steps');
  assert.deepEqual(paramLabels(rig.evaluator.hlTracks.get('kick').sig), ['Filter Cutoff']);
  shutdown(rig);
});

test('the grid is deterministic, so a re-asked window is the same window', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")');
  const a = rig.evaluator.highlightWindow(0, 4);
  const b = rig.evaluator.highlightWindow(0, 4);
  assert.deepEqual(a, b);
  shutdown(rig);
});

test('a grid can be built for a pattern with no clock at all', () => {
  const sig = patternCore.s('bd*2');
  const grid = highlightGrid(patternCore, sig, 0, 100, 0, 2, null);
  assert.equal(grid.length, 2);
  assert.equal(grid[0].steps.length, 2);
});

// ---- the clock the editor reads ------------------------------------------------------------------

test('the transport the editor is handed is on the wall clock, not the audio context\'s', () => {
  // The editor computes its playhead from Date.now() against the snapshot's base time, which
  // is right on the desktop where the engine's clock is the wall clock. The context's clock
  // starts near zero, so handing it over as is would put the playhead decades ahead.
  const rig = makeRig();
  rig.ctx.currentTime = 12.5;
  const before = Date.now() / 1000;
  const result = rig.evaluator.evaluate('kick: s("bd*4")');
  const after = Date.now() / 1000;
  assert.equal(rig.transport.snapshot().baseSec, 12.65, 'inside the host the clock stays the context\'s');
  assert.ok(result.transport.baseSec >= before + 0.15 - 1e-6 && result.transport.baseSec <= after + 0.15 + 1e-6,
    `the editor's copy should be a wall time, got ${result.transport.baseSec}`);
  assert.equal(result.transport.paused, false);
  const stopped = rig.evaluator.stop();
  assert.equal(stopped.transport.paused, true);
  assert.ok(stopped.transport.baseSec > 1e9, 'and so should the one a stop hands back');
});

// ---- stopping ---------------------------------------------------------------------------------------

test('stopping rewinds the clock and leaves nothing running', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")');
  const result = rig.evaluator.stop();
  assert.equal(rig.transport.paused, true);
  assert.ok(result.transport);
  assert.equal([...rig.evaluator.schedulers.values()].some((s) => s.running), false);
});

test('evaluating with start false loads the pattern without starting the clock', () => {
  const rig = makeRig();
  rig.evaluator.evaluate('kick: s("bd*4")', { start: false });
  assert.equal(rig.transport.paused, true, 'the update button must not start playback');
  assert.ok(rig.evaluator.schedulers.has('kick'));
  shutdown(rig);
});

// ---- arrangements -------------------------------------------------------------------------------------

test('an arrangement gives each track a clock of its own and reports where the song ends', () => {
  const rig = makeRig();
  const code = [
    'kick: s("bd*4")',
    '',
    '_arrange("kick,0,4")',
  ].join('\n');
  const result = rig.evaluator.evaluate(code);
  assert.ok(result.arrange, 'the buffer has a song, so it reports one');
  assert.ok(rig.evaluator.arrangeClock, 'and the deck has a clock');
  shutdown(rig);
});

test('with an arrangement in the buffer, a track with no clips of its own falls silent', () => {
  const rig = makeRig();
  const code = [
    'kick: s("bd*4")',
    '',
    'hat: s("hh*8")',
    '',
    '_arrange("kick,0,4")',
  ].join('\n');
  const result = rig.evaluator.evaluate(code);
  const hat = result.tracks.find((t) => t.label === 'hat');
  assert.ok(hat, 'the track still exists');
  const sounding = hat.grid.reduce((n, c) => n + c.steps.length, 0);
  assert.equal(sounding, 0, 'an emptied row is deliberate silence');
  shutdown(rig);
});

test('a clip naming a block that is not there is worth a line', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('kick: s("bd*4")\n\n_arrange("ghost,0,4")');
  assert.ok(result.log.some((l) => l.includes('ghost')));
  shutdown(rig);
});

// ---- seeded randomness ---------------------------------------------------------------------------------

test('a seeded choice is the same performance every time the same buffer is evaluated', () => {
  const rig = makeRig();
  const code = 'lead: n("0 2 4 5 7").degrade()';
  const first = rig.evaluator.evaluate(code).tracks[0].grid;
  const second = rig.evaluator.evaluate(code).tracks[0].grid;
  assert.deepEqual(first, second, 'stop and replay has to be the same take, not a new one');
  shutdown(rig);
});

test('an evaluation that fails leaves the key the playing tracks are in', () => {
  // Every evaluation starts with no key, so a key the buffer no longer sets does not linger - but
  // one that throws applies nothing, and that includes clearing the key.
  const rig = makeRig();
  try {
    rig.evaluator.evaluate('setscale("d:minor")\n\nlead: n("0 2 4").synth("Wavetable")');
    const key = patternCore.globalScale();
    assert.ok(key, 'the buffer set a key');
    assert.throws(() => rig.evaluator.evaluate('setscale("e:major")\n\nlead: n("0 2 4").synth('));
    assert.deepEqual(patternCore.globalScale(), key, 'still the key the tracks are playing in');
  } finally {
    shutdown(rig);
  }
});

test('a track may be named with a word JavaScript keeps for itself', () => {
  const rig = makeRig();
  const result = rig.evaluator.evaluate('break: s("bd*4")\ndefault: s("hh*8")');
  assert.deepEqual(result.tracks.map((t) => t.label), ['break', 'default']);
  shutdown(rig);
});
