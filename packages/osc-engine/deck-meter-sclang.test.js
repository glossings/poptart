'use strict';

// The DJ deck meter reader in sc/poptart.scd (\poptart_deck_meter): a SendPeakRMS level feed per
// deck plus the three band energies that COLOR the deck's waveform strip.
//
// What this guards: (1) the def still builds - poptart.scd only reloads on a restart, so a graph
// error in it fails silently mid-session; (2) it loads into a default-configured scsynth, which
// is where a def that overran the wire buffers says so; (3) the bands really do split where they
// claim to. That last one is the whole point of the feed: the shares it sends are drawn with the
// same color function as a song file's offline analysis (wav.js's envelope, same 200Hz / 2kHz
// one-pole split), so a strip drawn from this and a strip drawn from that have to agree about
// what "low" means - otherwise two stacked decks are colored by two different rules.
//
// Like the other *-sclang tests: the source is lifted out of the shipped file, run in a real
// sclang, and skipped (not failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57198'; // its own, so a package run's sclangs don't race for one (see the notes)
const RENDER_SR = 48000;

/** The shipped reader def, whole. */
function extractDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^ {4}SynthDef\(\\poptart_deck_meter, \{[\s\S]*?^ {4}\}\)\.add;$/m);
  assert.ok(m, 'could not find the \\poptart_deck_meter def in sc/poptart.scd');
  return m[0];
}

/**
 * Just the measurement out of that def - everything down to the first reply, which ends with
 * `energy`. Lifted rather than copied so the render below measures what the engine sends.
 */
function extractMeasurement() {
  const m = extractDef().match(/\{ \|bus, id\|\n([\s\S]*?)\n\s*SendPeakRMS/);
  assert.ok(m, 'could not find the band measurement in \\poptart_deck_meter');
  assert.match(m[1], /var energy =/, 'the measurement should end at the named `energy`');
  return m[1];
}

const scoreProgram = () => {
  const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
  return fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : '';
};

function runSclang(dir, script) {
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the deck meter def builds, and its reply carries the deck id before the bands', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-deckmeter-'));
  const out = runSclang(dir, `(
var def, reply;
${extractDef()}
def = SynthDescLib.global[\\poptart_deck_meter].def;
("BUILT<" ++ def.children.size ++ ">").postln;
// SendReply's inputs are [trig, replyID, name length, ...name, ...values]. Both halves of the
// layout the forwarder reads are here: the deck id travels as the replyID (m[2] to the handler
// beside this def) and the three energies follow it (m[3] on), so one handler serves both decks.
reply = def.children.detect { |u| u.isKindOf(SendReply) };
("REPLY-ID<" ++ reply.inputs[1].class.name ++ ">").postln;
("REPLY-VALUES<" ++ reply.inputs.copyRange(3, reply.inputs.size - 1).count { |x| x.isKindOf(UGen) } ++ ">").postln;
0.exit;
)
`);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  const built = out.match(/^BUILT<(\d+)>$/m);
  assert.ok(built, `the deck meter def did not build:\n${out}`);
  assert.ok(Number(built[1]) > 10, `the def has only ${built[1]} UGens - the bands are missing`);
  // An OutputProxy there is the def's own `id` argument. A constant (an Integer) would mean both
  // decks replying under the same id, which is one deck's colors on both strips.
  assert.match(out, /^REPLY-ID<OutputProxy>$/m, `the reply does not carry the deck id:\n${out}`);
  assert.match(out, /^REPLY-VALUES<3>$/m, `the reply should carry three band energies:\n${out}`);
});

test('the bands split where the file analysis splits, so both waveforms are colored alike', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-deckbands-'));
  const wav = path.join(dir, 'bands.wav');
  // One tone per band's middle, each rendered for a quarter second: 60Hz is under the 200Hz
  // corner, 700Hz sits between the two, 6kHz is over 2kHz. The measurement is lifted from the
  // def and its three energies are written out as three audio channels (via K2A) - the memory
  // of what this feed sends, measured offline, with no server booted.
  const out = runSclang(dir, `(
var score, opts, probe;
probe = SynthDef(\\probe, { |bus|
${extractMeasurement()}
    Out.ar(0, K2A.ar(energy));
});
score = Score.new;
score.add([0, [\\d_recv, probe.asBytes]]);
score.add([0, [\\d_recv, SynthDef(\\tone, { |bus, freq = 100|
    Out.ar(bus, SinOsc.ar(freq, 0, 0.5) ! 2) }).asBytes]]);
[[0.0, 60], [0.3, 700], [0.6, 6000]].do { |pair, i|
    score.add([pair[0], [\\s_new, \\tone, 2000 + i, 0, 0, \\bus, 16, \\freq, pair[1]]]);
    score.add([pair[0] + 0.28, [\\n_free, 2000 + i]]);
};
score.add([0.01, [\\s_new, \\probe, 1001, 1, 0, \\bus, 16]]);
score.add([0.9, [\\c_set, 0, 0]]);
${scoreProgram()}
opts = ServerOptions.new.numOutputBusChannels_(3);
score.recordNRT(${JSON.stringify(path.join(dir, 'b.osc'))}, ${JSON.stringify(wav)},
    nil, ${RENDER_SR}, "WAV", "float", opts, action: { "NRT-DONE".postln; 0.exit });
)
`);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  if (!out.includes('NRT-DONE')) {
    t.skip(`scsynth did not render here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.doesNotMatch(out, /exceeded number of interconnect buffers/, 'the measurement overran the wire buffers');
  const r = readWavRaw(wav);
  assert.ok(r && r.channels === 3, 'the render should have one channel per band');
  // Read each tone near the end of its quarter second, by which time the 10Hz smoother has
  // settled, and ask which band holds most of the energy.
  const shareAt = (sec) => {
    const f = Math.round(sec * RENDER_SR);
    const e = [0, 1, 2].map((c) => Math.max(0, r.data[f * r.channels + c]));
    const total = e[0] + e[1] + e[2];
    assert.ok(total > 1e-9, `nothing measured at ${sec}s - the probe heard silence`);
    return e.map((v) => v / total);
  };
  const low = shareAt(0.26);
  const mid = shareAt(0.56);
  const high = shareAt(0.86);
  assert.ok(low[0] > 0.8, `a 60Hz tone read as ${low.map((v) => v.toFixed(2))} - it belongs in the low band`);
  assert.ok(mid[1] > 0.6, `a 700Hz tone read as ${mid.map((v) => v.toFixed(2))} - it belongs in the mid band`);
  assert.ok(high[2] > 0.8, `a 6kHz tone read as ${high.map((v) => v.toFixed(2))} - it belongs in the high band`);
});
