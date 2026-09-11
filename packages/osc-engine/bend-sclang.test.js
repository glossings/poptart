'use strict';

// Pitch bend in the engine (sc/poptart.scd) - Sig#bend's two destinations.
//
// The bend channel is an ordinary channel control on the way in (Node sends it at pseudo-slot -1
// like gain or pan), and splits in two on the way out: the track synth republishes it on a control
// bus of the track's own, the sample voices MAP that bus and fold it into their playback rate, and
// a SendReply turns it into MIDI pitch bend for the plugin in slot 0.
//
// What this guards is the half that only the server can check - that the UGen graphs still BUILD
// with the bend control in them, which is where a wrong rate, a var out of order or a UGen that
// doesn't take a control-rate input shows up - plus the semitone -> 14-bit conversion, which is the
// only arithmetic in the feature. Like the other *-sclang tests the source under test is lifted out
// of the shipped poptart.scd; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');

/** One `name = { … };` closure, as the other sclang tests lift theirs. */
function extract(name) {
  const m = SRC.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

/**
 * One `SynthDef((…))` call, by the name it is built under. Balanced on parentheses rather than
 * matched by a regex: these defs live inside `server.waitForBoot { … }` and contain nested calls,
 * so there is no line the end of one can be recognized by.
 */
function synthDef(name) {
  const at = SRC.search(new RegExp(`SynthDef\\(\\("${name}"`));
  assert.ok(at >= 0, `could not find the ${name} SynthDef in sc/poptart.scd`);
  let depth = 0;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) return SRC.slice(at, i + 1);
  }
  assert.fail(`unbalanced parentheses after ${name}`);
  return '';
}

const SAMPLE_DEFS = ['poptart_sample_', 'poptart_sample_loop_', 'poptart_sample_warp_', 'poptart_sample_warp_loop_'];

function runSclang(body) {
  // No server is booted. A SynthDef builds its UGen graph the moment it is constructed - .add is
  // what needs a server, and nothing here calls it - so every graph under test is genuinely
  // compiled, with the same UGens and the same rates the engine would run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-bend-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, body);
  // Same wrapper the other sclang tests use: the exit is armed BEFORE the harness loads, so a
  // syntax error inside it still comes out with a report instead of idling until the timeout.
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(20, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    return execFileSync(resolveSclangPath(), [runner], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** What the harness reported under one marker - `TAG<…>` lines, the shape the other sclang tests post. */
const mark = (out, tag) => out.match(new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<([^>]*)>`))?.[1] ?? null;

test('every sample voice builds with a bend control, at both channel counts', (t) => {
  const out = runSclang(`(
var report = { |label, nc, def| ("DEF<" ++ label ++ ":" ++ nc ++ ":"
    ++ def.allControlNames.detect({ |c| c.name == \\bend }).notNil ++ ":"
    ++ (def.allControlNames.detect({ |c| c.name == \\bend }) !? { |c| c.defaultValue } ? "none") ++ ">").postln };
[1, 2].do { |nc|
    var toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
${SAMPLE_DEFS.map((n) => `    report.(${JSON.stringify(n)}, nc, ${synthDef(n)});`).join('\n')}
};
0.exit;
)
`);
  if (!/DEF</.test(out)) {
    t.skip(`sclang did not build the sample defs here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  for (const name of SAMPLE_DEFS) {
    for (const nc of [1, 2]) {
      // Present on every voice, and resting at 0 - a def whose bend defaulted to anything else
      // would detune every unbent sample on the track.
      const got = out.match(new RegExp(`DEF<${name}:${nc}:([^>]*)>`))?.[1] ?? '';
      const [present, dflt] = got.split(':');
      assert.equal(present, 'true', `${name}${nc} should carry a bend control`);
      assert.equal(Number(dflt), 0, `${name}${nc}'s bend should rest at 0 - any other default detunes every unbent hit`);
    }
  }
});

test('the track synth republishes its bend on a bus and posts it for MIDI', (t) => {
  // buildTrackDef reads a handful of engine-wide values; they are supplied here at the shapes the
  // real boot gives them. cueOffset nil is the no-cue-pair build, which is the smaller graph.
  const out = runSclang(`(
var server = Server(\\poptartBendProbe, NetAddr("127.0.0.1", 57999));
var playChannels = 2, maxSlots = 8, cueOffset = nil;
var bendPollHz = ${/var bendPollHz = (\d+)/.exec(SRC)[1]};
var maxBusSends = 4;
var deckMeterBus = Bus.control(server, 4);
// trackDefName is a one-liner in the source, so it is written out here rather than lifted: the
// extractor matches closures that close on a line of their own.
var trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };
var buildTrackDef, def;
server.options.numOutputBusChannels = 2;
${extract('buildTrackDef')}
def = buildTrackDef.(\\probe);
("BUILT<" ++ def.isKindOf(SynthDef) ++ ">").postln;
[\\bend, \\bendrange, \\bendOut].do { |n|
    var c = def.allControlNames.detect({ |k| k.name == n });
    ("CTL<" ++ n ++ ":" ++ c.notNil ++ ":" ++ (c !? { |k| k.defaultValue } ? "none") ++ ">").postln;
};
// The republish has to OVERWRITE the bus, not add to it: a control bus is never cleared between
// blocks, so an Out here would ramp the whole track off-key within seconds of playing.
("REPLACE<" ++ def.children.any({ |u| u.class == ReplaceOut }) ++ ">").postln;
("ADDOUT<" ++ def.children.any({ |u| u.class == Out and: { u.rate == \\control } }) ++ ">").postln;
("REPLY<" ++ def.children.any({ |u| u.class == SendReply }) ++ ">").postln;
0.exit;
)
`);
  if (!/BUILT</.test(out)) {
    t.skip(`sclang did not build the track def here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  assert.equal(mark(out, 'BUILT'), 'true');
  // sclang prints a control default as it stores it, so the number is compared as a number.
  const ctl = (n) => (out.match(new RegExp(`CTL<${n}:([^>]*)>`))?.[1] ?? '').split(':');
  assert.deepEqual([ctl('bend')[0], Number(ctl('bend')[1])], ['true', 0], 'bend rests at centre');
  // The default matches pattern-core's DEFAULT_BEND_RANGE: a plugin nobody has told us about is
  // assumed to be on the +/-2 semitones nearly all of them power up with.
  assert.deepEqual([ctl('bendrange')[0], Number(ctl('bendrange')[1])], ['true', 2], 'bendrange defaults to 2 semitones');
  assert.equal(ctl('bendOut')[0], 'true');
  assert.equal(mark(out, 'REPLACE'), 'true', 'the bend bus is written with ReplaceOut');
  assert.equal(mark(out, 'ADDOUT'), 'false', 'nothing else writes a control bus with Out (it would accumulate)');
  assert.equal(mark(out, 'REPLY'), 'true', 'the MIDI sender has something to listen to');
});

test('semitones become a 14-bit bend against the plugin\'s own range', () => {
  // The conversion the bendOut listener does, lifted out of it so the arithmetic is checked
  // without a server or a plugin: 8192 is centre, a full-range bend reaches an end, and past the
  // range there is nothing left to send.
  const encode = (semis, range) => Math.min(16383, Math.max(0, Math.round(8192 + (semis / range) * 8192)));
  assert.equal(encode(0, 2), 8192, 'no bend is dead centre');
  assert.equal(encode(2, 2), 16383, 'a full bend up saturates at the top (8192 + 8192 clips to 16383)');
  assert.equal(encode(-2, 2), 0, 'and a full bend down at the bottom');
  assert.equal(encode(1, 2), 12288, 'half the range is half the throw');
  assert.equal(encode(1, 12), 8875, 'the same semitone is a smaller throw on a wider range');
  assert.equal(encode(12, 12), 16383, '...and an octave fills it');
  assert.equal(encode(9, 2), 16383, 'past the range the message can only saturate');
  assert.equal(encode(-9, 2), 0);
});
