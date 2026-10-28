'use strict';

// The track SynthDef's DJ stage (sc/poptart.scd, performance mixing phase 2): trim -> 3-band
// isolator EQ -> one-knob filter (cutoff + its own resonance) -> fader x deck gain, eight
// channel controls neutral by default.
// What this guards: (1) the SynthDef still BUILDS - a var/arg/UGen typo in the def is otherwise
// only discovered by booting the whole engine; (2) the filter knob's exponential cutoff mapping;
// (3) channelDefault's neutral values, which the modulator-clear path snaps controls back to -
// a DJ control whose neutral silently became 0 would mute every track on clearing an LFO.
//
// Like resolve-plugin-sclang.test.js, the source under test is lifted out of the shipped
// poptart.scd (not a copy), run in a real sclang, and skipped (not failed) where sclang or the
// VSTPlugin extension can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// Lift the track SynthDef out of buildTrackDef, from `SynthDef(trackDefName...` to its closing
// `});` at 4-space indent. Throws rather than silently testing nothing if the def moves.
// The DJ stage, which a track grows the first time it is touched (see djNode).
function extractDjDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^buildDjDef = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find buildDjDef in sc/poptart.scd');
  return m[0];
}

function extractTrackDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^    SynthDef\(trackDefName\.\(key\), \{[\s\S]*?^    \}\);$/m);
  assert.ok(m, 'could not find the track SynthDef in sc/poptart.scd');
  return m[0];
}

// Lift `djIsolator = { ... };` (the DJ stage's EQ, which the def calls) the same way.
function extractDjIsolator() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^djIsolator = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the djIsolator closure in sc/poptart.scd');
  return m[0];
}

// Lift `channelDefault = { ... };` the same way.
function extractChannelDefault() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^channelDefault = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the channelDefault closure in sc/poptart.scd');
  return m[0];
}

// And createTrack's birth-args parse (name/value pairs after the key become Synth args - the
// performance mixer's "born silent"; see osc-engine/index.js createTrack). Lifted as the exact
// `var birth = ...` statement and run against probe messages.
function extractBirthParse() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^    var birth = if \(msg\.size > 2\) \{[\s\S]*?\} \{ \[\] \};$/m);
  assert.ok(m, 'could not find the createTrack birth-args parse in sc/poptart.scd');
  return m[0];
}

// And the note-hold trio (waitForLoad/flushNotes/clearPending) - the cold-load hold added
// 2026-08-24 (a state restore on a still-opening plugin holds notes for the WHOLE load and
// drops the missed ones on release, instead of letting them sound the init preset) rides on
// their interplay, which is exercised below against a probe statePending/noteQueues.
function extractNoteHold() {
  const src = fs.readFileSync(SCD, 'utf8');
  return ['waitForLoad', 'flushNotes', 'clearPending'].map((name) => {
    const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
    assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
    return m[0];
  }).join('\n');
}

// And `destroyTrack = { ... };` (performance mixing phase 4) - compiled, not called: assigning
// the closure in a scope that declares its dependencies catches syntax and undeclared-variable
// mistakes, the ones otherwise only found by booting the whole engine.
function extractDestroyTrack() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^destroyTrack = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the destroyTrack closure in sc/poptart.scd');
  return m[0];
}

const DEFAULT_CASES = [
  // The DJ stage's controls: unity everywhere, except the filter knob's center detent at 0.
  ['trim', '1'], ['eqlo', '1'], ['eqmid', '1'], ['eqhi', '1'],
  ['fader', '1'], ['deck', '1'], ['djf', '0'], ['cue', '0'],
  // djres is the filter's resonance AMOUNT, and its neutral is 0 for the opposite reason the
  // gains' is 1: clearing a modulator off it must land on a plain sweep, never full whistle.
  ['djres', '0'],
  // And the pre-existing strip, unchanged.
  ['gain', '1'], ['postgain', '1'], ['out', '1'], ['dry', '1'], ['width', '1'], ['pan', '0'], ['bassmono', '0'],
  // The per-fx-slot dry/wet (Sig#wet): neutral is the plugin's own output, so clearing a
  // modulator off one leaves the effect sounding instead of silently bypassing it.
  ['wet1', '1'], ['wet7', '1'],
  // Pitch bend (Sig#bend). Centre for the bend itself; for the RANGE, the 2 semitones a plugin is
  // assumed to be set to - the one channel control whose neutral is neither 0 nor 1. A 0 here
  // would be worse than merely wrong: the bend encoding divides by the range, so clearing a
  // modulator off it would make every bend saturate instead of going quiet.
  ['bend', '0'], ['bendrange', '2'],
];

function runSclang() {
  const script = `(
var numPairs = 2, key = "probe", routeNowhere = 1000000;
var trackDefName = { |k| ("poptart_probe_" ++ k).asSymbol };
var channelDefault, djIsolator, buildDjDef, def;
var destroyTrack, awaitTrack, stopMixTap, unwireAudio, sidechainBySource, releaseBus, tracks, reorderTracks;
var tellRamp = { }, tellSlot = { }, tellMods = { }, tellTap = { }, shapesHandled = IdentityDictionary.new, nodeAddr = (sendMsg: { }); // the direct path's id handoff (see tellTrack in sc/poptart.scd) - inert here
var paramRoutes, unwireParamRoute; // audio patched onto parameters, which destroyTrack unwires
var exprsOf = { |t| t[\\exprs] ?? { IdentityDictionary.new } }; // param expressions, whose buses destroyTrack frees
var songs = IdentityDictionary.new; // the song decks' buffer registry, swept by destroyTrack
var viewTap = (stop: { |key| }); // the editor's inline displays' taps, which destroyTrack takes down - inert here
var freeDefsLater = { |names| }, exprDefDone = { |name| }; // the defs destroyTrack hands back - inert here
var birthParse;
var waitForLoad, flushNotes, clearPending, now, fired;
var cueOffset; // nil = the no-cue build; reassigned before the cue-armed build below
// The deck meter buses (a 4-channel Bus in the shipped scd); the def only reads .index, so an
// event stands in. 64 keeps the probe indices clear of the harness's own buses.
var deckMeterBus = (index: 64);
// Pitch bend (Sig#bend): the rate the track synth posts its bend value back at, and the node-id ->
// track map destroyTrack unregisters from. Both are engine-wide in the shipped file.
var bendPollHz = 100, bendTracks = IdentityDictionary.new;
var statePending = IdentityDictionary.new, noteQueues = IdentityDictionary.new;
var stateWaitMax = 0.3;
var slotKey = { |k, slot| (k ++ "_" ++ slot).asSymbol };
${extractChannelDefault()}
${extractDjIsolator()}
// Building the def runs the whole UGen graph function client-side - no server needed; this is
// where an undeclared var, a bad arg default, or a misused UGen throws. Pasted directly (like
// resolve-plugin-sclang.test.js pastes its closure): on a machine without the VSTPlugin
// extension this fails to COMPILE ("Class not defined"), which the test reads as a skip.
def = ${extractTrackDef()}
("DEF-OK<" ++ def.name ++ ">").postln;
// And once more with the headphone-cue pair armed (phase 7): the cue send UGens only exist in
// this build, so a mistake in them would otherwise pass every no-cue machine's run.
cueOffset = 2;
key = "probecue";
def = ${extractTrackDef()}
("DEF-CUE-OK<" ++ def.name ++ ">").postln;
key = "probe";
// The DJ stage, a def of its own that a track grows the first time it is touched.
${extractDjDef()}
def = buildDjDef.();
("DJ-OK<" ++ def.name ++ ">").postln;
${extractDestroyTrack()}
("DESTROY-OK<" ++ destroyTrack.isKindOf(Function) ++ ">").postln;
birthParse = { |msg|
${extractBirthParse()}
    birth;
};
("BIRTH<" ++ birthParse.([nil, "probe", "deck", 0, "fader", 0.5]) ++ ">").postln;
("BIRTH-EMPTY<" ++ birthParse.([nil, "probe"]).size ++ ">").postln;
${extractNoteHold()}
now = Main.elapsedTime;
// Warm swap: notes at/just after the onset queue, ones beyond the wait window pass through,
// and the release flushes everything queued.
fired = List.new;
statePending[slotKey.(\\t, 0)] = (seq: 1, at: now);
("WARM-QUEUED<" ++ waitForLoad.(\\t, 0, now + 0.01, { fired.add(\\a) }) ++ ">").postln;
("WARM-PAST-WINDOW<" ++ waitForLoad.(\\t, 0, now + 1.0, { fired.add(\\x) }) ++ ">").postln;
clearPending.(slotKey.(\\t, 0), 1);
("WARM-FIRED<" ++ fired.join(",") ++ ">").postln;
// Cold load: the window is unbounded (notes keep queueing for the whole open), and the release
// drops the note whose onset has passed while keeping the future-stamped one.
fired = List.new;
statePending[slotKey.(\\t, 0)] = (seq: 2, at: now - 0.2, cold: true);
("COLD-QUEUED-STALE<" ++ waitForLoad.(\\t, 0, now - 0.1, { fired.add(\\stale) }) ++ ">").postln;
("COLD-QUEUED-FAR<" ++ waitForLoad.(\\t, 0, now + 5, { fired.add(\\future) }) ++ ">").postln;
clearPending.(slotKey.(\\t, 0), 2);
("COLD-FIRED<" ++ fired.join(",") ++ ">").postln;
// The one-knob filter's cutoff mapping at its three cardinal positions.
("MAP<lpf-closed>" ++ (18000 * (900 ** -1)).clip(20, 18000)).postln;
("MAP<lpf-open>" ++ (18000 * (900 ** 0)).clip(20, 18000)).postln;
("MAP<hpf-closed>" ++ (20 * (900 ** 1)).clip(20, 18000)).postln;
// And the resonance control's rq mapping. rq is 1/Q, so it runs DOWNWARD from 1: the endpoint
// that matters is res-off, which must be a flat 1 - a polarity slip there would make an
// untouched desk resonant, which is exactly what the separate control exists to avoid.
("RES<off>" ++ (1 - (0.62 * 0.clip(0, 1)))).postln;
("RES<full>" ++ (1 - (0.62 * 1.clip(0, 1)))).postln;
${DEFAULT_CASES.map(([name]) => `("DEFAULT<${name}>" ++ channelDefault.(${JSON.stringify(name)})).postln;`).join('\n')}
0.exit;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-mixstage-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the track SynthDef builds with the DJ stage, and its neutrals are really neutral', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here, so the def went unbuilt: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  if (/Class not defined|Class extension for nonexistent class/.test(out) && !out.includes('DEF-OK')) {
    t.skip('sclang has no VSTPlugin extension here, so the def cannot build');
    return;
  }
  assert.match(out, /^DEF-OK<poptart_probe_probe>$/m, `the SynthDef did not build:\n${out}`);
  assert.match(out, /^DEF-CUE-OK<poptart_probe_probecue>$/m, `the SynthDef did not build with the cue send armed:\n${out}`);
  assert.match(out, /^DJ-OK<poptart_dj>$/m, `the DJ stage did not build:\n${out}`);
  assert.match(out, /^DESTROY-OK<true>$/m, `the destroyTrack closure did not compile:\n${out}`);
  assert.match(out, /^BIRTH<\[ ?deck, 0\.0, fader, 0\.5 ?\]>$/m,
    'createTrack must parse trailing name/value pairs into Synth birth args');
  assert.match(out, /^BIRTH-EMPTY<0>$/m, 'a bare createTrack message must yield no birth args');
  // The note hold: warm swaps flush what they held; cold loads drop the missed notes.
  assert.match(out, /^WARM-QUEUED<true>$/m, 'a note at a warm swap onset must wait for the program');
  assert.match(out, /^WARM-PAST-WINDOW<false>$/m, 'a note far past a warm swap must pass straight through');
  assert.match(out, /^WARM-FIRED<a>$/m, 'releasing a warm swap must flush its held note');
  assert.match(out, /^COLD-QUEUED-STALE<true>$/m, 'a cold load must claim notes however late they run');
  assert.match(out, /^COLD-QUEUED-FAR<true>$/m, "a cold load's wait window must not expire while it opens");
  assert.match(out, /^COLD-FIRED<future>$/m, 'a cold release must drop the missed note and keep the future one');
  assert.match(out, /^MAP<lpf-closed>20(\.0)?$/m, 'filter full-left should close the LPF to 20 Hz');
  assert.match(out, /^MAP<lpf-open>18000(\.0)?$/m, 'filter at center should park the LPF open at 18 kHz');
  assert.match(out, /^MAP<hpf-closed>18000(\.0)?$/m, 'filter full-right should close the HPF to 18 kHz');
  assert.match(out, /^RES<off>1(\.0)?$/m, 'resonance at 0 must be rq 1 - a flat filter, no peak');
  assert.match(out, /^RES<full>0\.38$/m, 'resonance at 1 must be rq 0.38 (Q ~2.6)');
  for (const [name, expected] of DEFAULT_CASES) {
    const m = out.match(new RegExp(`^DEFAULT<${name}>(.*)$`, 'm'));
    assert.ok(m, `sclang printed no channelDefault for "${name}"`);
    assert.strictEqual(m[1].trim(), expected, `channelDefault("${name}")`);
  }
});

// Where the deck meter and the headphone cue TAP the channel, which is the difference between a
// meter you can gain-stage with and a meter that lies.
//
// Both sit post trim/EQ/filter and PRE fader x crossfader, on purpose: the question a channel
// meter answers is "what is this deck making", the way a hardware desk's does, so that trim is
// set against it and a faded-out deck still shows what it will be when the fader comes up. What
// must never happen is the meter drifting ahead of TRIM - a meter that ignores the one control
// it exists to help you set is worse than none, and nothing about it would look wrong on screen.
//
// Source-shape rather than a render: the tap is one Out.ar in a 300-line graph with VSTPlugin and
// a dozen buses in it, and the thing that can break is an edit moving a line, not the arithmetic.
test('the deck meter and the cue tap read the channel AFTER trim', () => {
  const def = extractDjDef();
  const at = (needle, what) => {
    const i = def.indexOf(needle);
    assert.ok(i > 0, `${what} not found in the track def - this test needs updating`);
    return i;
  };
  const trim = at('djIsolator.(In.ar(in, 2) * trim', 'the trim stage');
  const meter = at('Out.ar(meterBus', 'the deck meter send');
  const cue = at('Out.ar(cueBus', 'the headphone cue send');
  assert.ok(trim < meter, 'the deck meter is read BEFORE trim - it will show level on a dead channel');
  assert.ok(trim < cue, 'the headphone cue is taken before trim');
  // ...and the EQ is fed the trimmed signal in that same call: re-deriving the EQ from `sig`
  // elsewhere would reinstate the full-level signal downstream of trim and feed it to both taps.
  assert.strictEqual(def.split('djIsolator.(').length, 2, 'the EQ must be applied exactly once, to the trimmed signal');
});

test('...and both of them are read BEFORE the fader', () => {
  // The other half of the same decision, and the one that is deliberate rather than a bug: a
  // deck faded out still meters, and still feeds the headphones, which is what makes it possible
  // to line the next record up at all.
  const def = extractDjDef();
  const meter = def.indexOf('Out.ar(meterBus');
  // Where the fader is APPLIED to the direct path.
  const applied = def.indexOf('live * ((1 - fxAmt) * faderAmt');
  assert.ok(applied > 0, 'the fader stage moved - this test needs updating');
  assert.ok(meter < applied, 'the meter now follows the fader, so a cued deck reads as silent');
});
