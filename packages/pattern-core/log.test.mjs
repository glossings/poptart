// Sig#log() - the debugging line the scheduler prints per event. What's under test is the flag
// surviving the chain and the line saying what actually played: the config the ENGINE resolved
// (fit's rate, a slice's window) rather than what the pattern asked for, and how much audio that
// window holds against the event's length - the field that explains a track dropping out.
// One mocked engine, no server, no audio.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, note, sine, setPatternWarn } from './src/signal.mjs';
import { Scheduler, setEventLogger } from './src/scheduler.mjs';

// Engine that plays nothing and answers playSample with whatever `resolve` says the numbers came
// out as (the shape OscEngine#playSample returns).
function mockEngine(resolve = null) {
  const base = {
    getTime: () => 0,
    playSample: (trackId, pack, cfg) => (resolve ? resolve(pack, cfg) : undefined),
  };
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

// Every line a pattern logs over cycles [0, cycles).
function linesOf(sig, { cycles = 1, cps = 1, resolve = null } = {}) {
  const lines = [];
  setEventLogger((line) => lines.push(line));
  try {
    const sch = new Scheduler(mockEngine(resolve), { trackId: 'tops', cps });
    sch.setPattern(sig);
    for (let c = 0; c < cycles; c++) sch._scheduleNoteEdges(c, c + 1);
  } finally {
    setEventLogger(null);
  }
  return lines;
}

test('nothing is logged unless the pattern asks for it', () => {
  assert.deepEqual(linesOf(s('bd*2')), []);
  assert.deepEqual(linesOf(note('c3 e3')), []);
});

test('one line per event, tagged with the track and the event\'s cycle span', () => {
  const lines = linesOf(s('bd*2').log(), { cycles: 2 });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\[tops\] 0\.000 -> 0\.500 /);
  assert.match(lines[1], /^\[tops\] 0\.500 -> 1\.000 /);
  // Absolute cycle positions, so the log lines up with the transport and with other tracks.
  assert.match(lines[2], /^\[tops\] 1\.000 -> 1\.500 /);
});

test('.log() anywhere in the chain flags the track', () => {
  // It's a flag on the track, not a step in the pattern, so it survives everything after it.
  assert.equal(linesOf(s('bd').log().fit().begin(0.5)).length, 1);
  assert.equal(linesOf(s('bd').log().fast(2)).length, 2);
  assert.equal(linesOf(note('c3').log().s('rave')).length, 1, 'even a swap to a sampler track');
  assert.equal(linesOf(s('bd').log(false)).length, 0, 'and log(false) turns it back off');
});

test('a sampler line reports what the engine resolved, not what the pattern asked for', () => {
  // 2.89s file at 1s/cycle, auto-fit -> the whole file over 2 cycles, so speed is ~1.006 and the
  // 0.75..1 window holds half a cycle of audio inside a one-cycle event: half the cycle is silent.
  const resolve = () => ({
    index: 35, begin: 0.75, end: 1, loop: 0, speed: 1.0057, stretch: 1, durSec: 0.5, cut: 0, amp: 1,
  });
  const [line] = linesOf(s('breaks:35').fit().begin(0.75).log(), { resolve });
  assert.match(line, /s=breaks i=35 begin=0\.75 end=1 speed=1\.0057/);
  assert.match(line, /dur=0\.5c\/1c gap=0\.5c/, 'the window runs out half a cycle early');
});

test('a window that outlasts its event reads as cut, not as a gap', () => {
  const resolve = () => ({ index: 0, begin: 0, end: 1, loop: 0, speed: 1, stretch: 1, durSec: 4, cut: 1, amp: 1 });
  const [line] = linesOf(s('breaks').log(), { resolve });
  assert.match(line, /dur=4c\/1c cut/);
  assert.doesNotMatch(line, /gap/);
});

test('a looped window fills its event by definition, so it never reads as a gap', () => {
  const resolve = () => ({ index: 0, begin: 0, end: 0.1, loop: 1, speed: 1, stretch: 1, durSec: 0.2, cut: 0, amp: 1 });
  const [line] = linesOf(s('breaks').loop().log(), { resolve });
  assert.match(line, /loop/);
  assert.doesNotMatch(line, /gap/);
});

test('an event that makes no sound says why', () => {
  const [pending] = linesOf(s('breaks').log(), { resolve: () => ({ skipped: 'pack "breaks" loading' }) });
  assert.match(pending, /SILENT \(pack "breaks" loading\)/);
  const [muted] = linesOf(note('c3').vel(0).log());
  assert.match(muted, /vel=0 SILENT \(vel 0\)/);
});

test('the config that varies per event is on the line; streams are not', () => {
  const line = linesOf(s('breaks').n('7').vel(0.5).slice(3).attack(0.2).log())[0];
  assert.match(line, /vel=0\.5/);
  assert.match(line, /note=7/);
  assert.match(line, /slice=3/);
  assert.match(line, /attack=0\.2/);
  // Unset envelope stages stay off the line rather than printing their defaults.
  assert.doesNotMatch(line, /decay|sustain|release/);
  // A param LFO is a continuous stream with no per-event value - it has no business here.
  assert.doesNotMatch(linesOf(s('bd').param('Cutoff', sine(0.5)).log())[0], /Cutoff/);
});

test('a synth line carries the note and velocity', () => {
  const lines = linesOf(note('c3 e3').vel('1 0.5').log());
  assert.deepEqual(lines.map((l) => l.replace(/^\[tops\] /, '')), [
    '0.000 -> 0.500  note=60 vel=1',
    '0.500 -> 1.000  note=64 vel=0.5',
  ]);
});

test('an engine that reports nothing back still logs the requested config', () => {
  const [line] = linesOf(s('breaks').begin(0.25).speed(2).log());
  assert.match(line, /s=breaks i=0 begin=0\.25 end=1 speed=2/);
  assert.doesNotMatch(line, /SILENT/, 'silence is what the engine says, not what it fails to say');
  assert.doesNotMatch(line, /dur=/, 'and only the engine knows how long the audio is');
});

// ---------------------------------------------------------------------------------------------
// .loopwrap()/.loopdir(). Ordinary patternable channels carrying a mode NUMBER: whatever they
// produce per event is rounded to the nearest mode and wrapped into range, so a continuous source
// (rand(), an LFO) selects a real mode rather than falling off the end.
// ---------------------------------------------------------------------------------------------

// The sampler config the scheduler hands the engine for the first event of `sig`.
function cfgOf(sig) {
  let seen = null;
  const engine = new Proxy(
    { getTime: () => 0, playSample: (trackId, pack, cfg) => { seen = seen ?? cfg; } },
    { get: (t, p) => (p in t ? t[p] : () => {}) },
  );
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return seen;
}

test('an unadorned loop carries no modes - the engine applies its own defaults', () => {
  const cfg = cfgOf(s('breaks').loop());
  assert.equal(cfg.loop, 1);
  assert.equal(cfg.loopWrap, undefined);
  assert.equal(cfg.loopDir, undefined);
});

test('the modes reach the engine on each event', () => {
  const cfg = cfgOf(s('breaks').loop().loopwrap(1).loopdir(1));
  assert.equal(cfg.loopWrap, 1);
  assert.equal(cfg.loopDir, 1);
  // Bare calls mean "the non-default mode", like .loop()/.flip().
  assert.equal(cfgOf(s('breaks').loop().loopwrap()).loopWrap, 1);
  assert.equal(cfgOf(s('breaks').loop().loopdir()).loopDir, 1);
});

test('a mode value rounds to the nearest mode and wraps past the last', () => {
  // Two modes each, so: 0.3 -> 0, 0.7 -> 1, 1.7 -> 2 -> 0 again. What lets a continuous source
  // drive the control - a clamp would pile every high value onto the last mode instead.
  assert.equal(cfgOf(s('breaks').loop().loopdir(0.3)).loopDir, 0);
  assert.equal(cfgOf(s('breaks').loop().loopdir(0.7)).loopDir, 1);
  assert.equal(cfgOf(s('breaks').loop().loopdir(1.7)).loopDir, 0);
  assert.equal(cfgOf(s('breaks').loop().loopwrap(-1)).loopWrap, 1, 'negatives wrap round too');
  assert.equal(cfgOf(s('breaks').loop().loopwrap(5)).loopWrap, 1);
});

test('the modes are patterns like any other channel', () => {
  const track = s('bd*2').loop().loopwrap('0 1');
  assert.equal(cfgOf(track).loopWrap, 0, 'first half of the cycle: the whole file');
  assert.equal(track.sampler.loopWrap.sample(0.75, 1, 0.75), 1, 'second half: the window');
  // And they survive the rest of the chain, like every other sampler channel.
  assert.equal(cfgOf(s('breaks').loopdir(1).loop().fit().begin(0.5).fast(2).rib(3, 2)).loopDir, 1);
});

test('the old options object warns, and the loop still plays', () => {
  // A document written against the old spelling must not go silent: the loop runs on the default
  // modes and the console says where wrap/dir went.
  const warnings = [];
  setPatternWarn((line) => warnings.push(line));
  try {
    const cfg = cfgOf(s('breaks').loop(1, { wrap: 'window' }));
    assert.equal(cfg.loop, 1, 'still looping');
    assert.equal(cfg.loopWrap, undefined, 'just not on the mode it asked for');
  } finally {
    setPatternWarn(null);
  }
  assert.match(warnings[0], /their own controls now/);
});

test('the loop line names the region and the direction', () => {
  const resolve = () => ({
    index: 0, begin: 0.9, end: 1, loop: 1, loopWrap: 'file', loopDir: 'pingpong',
    speed: 1, stretch: 1, durSec: 0.1, cut: 0, amp: 1,
  });
  const [line] = linesOf(s('breaks').begin(0.9).loop().loopdir(1).log(), { resolve });
  assert.match(line, /loop=file\+pingpong/);
  assert.doesNotMatch(line, /gap/, 'a loop plays for the whole event whatever its region holds');
});

test('the loop line names the modes from the numbers when the engine reports nothing', () => {
  const [line] = linesOf(s('breaks').loop().loopwrap(1).loopdir(1).log());
  assert.match(line, /loop=window\+pingpong/, 'a mode number in a log line would say nothing');
});
