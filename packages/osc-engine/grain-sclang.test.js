'use strict';

// The granular sampler voice in the engine (sc/poptart.scd) - Sig#grain.
//
// Two things only the server can answer. That the graphs BUILD: the voice at both channel counts,
// and the track synth with the four grain controls it republishes for its voices to map. And that
// the voice SOUNDS the way its comment says - rendered offline (NRT, no audio device, no boot) and
// measured: a stereo file keeps its sides, pan moves them, a mono file sits in the middle, size
// and rate are seconds and grains per second, the window buffer is the grain's envelope, and the
// gate releases the voice. Like the other *-sclang tests the source under test is lifted out of
// the shipped poptart.scd; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { writeWav, readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');
const SR = 48000;
const LANG_PORT = '57291';

function extract(name) {
  const m = SRC.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

/** One `SynthDef((…))` call, balanced on parentheses (see bend-sclang.test.js). */
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

const grainDef = (nc) => synthDef('poptart_sample_grain_').replace(/\bnc\b/g, String(nc));
const MAX_OVERLAP = /grainMaxOverlap = (\d+)/.exec(SRC)[1];

function runSclang(body, timeout = 120000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-grain-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, body);
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(90, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    // On a UDP port of its own. Test files run in parallel and every sclang takes a lang port from
    // the same short run starting at 57120; nothing here touches the network (a def build and an
    // offline render), so these launches stay out of the range the tests that DO need one draw from.
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, runner], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const mark = (out, tag) => out.match(new RegExp(`${tag}<([^>]*)>`))?.[1] ?? null;

test('the granular voice builds at both channel counts, one GrainBuf per side', (t) => {
  const out = runSclang(`(
var grainMaxOverlap = ${MAX_OVERLAP};
[1, 2].do { |n|
    var def = if (n == 1) { ${grainDef(1)} } { ${grainDef(2)} };
    var ctl = { |name| def.allControlNames.detect({ |c| c.name == name }) };
    ("DEF<" ++ n ++ ":" ++ def.name ++ ":"
        ++ def.children.count({ |u| u.class == GrainBuf }) ++ ":"
        ++ def.children.any({ |u| u.class == Impulse and: { u.rate == \\audio } }) ++ ":"
        ++ [\\bufL, \\bufR, \\begin, \\rate, \\gate, \\bend, \\grainpos, \\grainsize, \\grainrate, \\grainpan, \\posLive, \\win]
            .every({ |name| ctl.(name).notNil }) ++ ":"
        ++ ctl.(\\win).defaultValue ++ ">").postln;
};
0.exit;
)
`);
  if (!/DEF</.test(out)) {
    t.skip(`sclang did not build the grain defs here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  for (const nc of [1, 2]) {
    const [name, grainBufs, audioTrig, controls, win] = (out.match(new RegExp(`DEF<${nc}:([^>]*)>`))?.[1] ?? '').split(':');
    assert.equal(name, `poptart_sample_grain_${nc}`);
    // GrainBuf reads one channel: a stereo file is a GrainBuf per side, off the same trigger.
    // (A two-channel GrainBuf expands to one UGen with two outputs, so the count is per side.)
    assert.equal(Number(grainBufs), nc, `${nc} side(s)`);
    assert.equal(audioTrig, 'true', 'grains start on their sample, not their block');
    assert.equal(controls, 'true', 'every control the playSample handler sets or maps');
    assert.equal(Number(win), -1, 'no window means the built-in bell');
  }
});

test('the track synth carries the four grain controls and republishes them', (t) => {
  const out = runSclang(`(
var server = Server(\\poptartGrainProbe, NetAddr("127.0.0.1", 57998));
var playChannels = 2, maxSlots = 8, cueOffset = nil;
var bendPollHz = ${/var bendPollHz = (\d+)/.exec(SRC)[1]};
var maxBusSends = 4;
var deckMeterBus = Bus.control(server, 4);
var trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };
var buildTrackDef, channelDefault, def;
server.options.numOutputBusChannels = 2;
${extract('buildTrackDef')}
${extract('channelDefault')}
def = buildTrackDef.(\\probe);
("BUILT<" ++ def.isKindOf(SynthDef) ++ ">").postln;
[\\grainpos, \\grainsize, \\grainrate, \\grainpan, \\grainOut].do { |n|
    var c = def.allControlNames.detect({ |k| k.name == n });
    ("CTL<" ++ n ++ ":" ++ c.notNil ++ ":" ++ (c !? { |k| k.defaultValue } ? "none") ++ ":" ++ channelDefault.(n.asString) ++ ">").postln;
};
("WIDE<" ++ def.children.any({ |u| u.class == ReplaceOut and: { u.rate == \\control } and: { u.inputs.size == 5 } }) ++ ">").postln;
("ADDOUT<" ++ def.children.any({ |u| u.class == Out and: { u.rate == \\control } }) ++ ">").postln;
0.exit;
)
`);
  if (!/BUILT</.test(out)) {
    t.skip(`sclang did not build the track def here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  assert.equal(mark(out, 'BUILT'), 'true');
  const ctl = (n) => (out.match(new RegExp(`CTL<${n}:([^>]*)>`))?.[1] ?? '').split(':');
  // The synth's own default, and what a cleared modulator leaves behind (channelDefault) - both
  // have to be pattern-core's CHANNEL_DEFAULTS, or a granular voice is left reading 0 grains a second.
  for (const [name, dflt] of [['grainpos', 0], ['grainsize', 0.08], ['grainrate', 20], ['grainpan', 0]]) {
    const [present, synthDefault, cleared] = ctl(name);
    assert.equal(present, 'true', name);
    assert.ok(Math.abs(Number(synthDefault) - dflt) < 1e-6, `${name} defaults to ${dflt} (got ${synthDefault})`);
    assert.ok(Math.abs(Number(cleared) - dflt) < 1e-6, `${name} clears to ${dflt} (got ${cleared})`);
  }
  assert.equal(ctl('grainOut')[0], 'true');
  assert.equal(mark(out, 'WIDE'), 'true', 'one four-wide ReplaceOut (bus index + four values)');
  assert.equal(mark(out, 'ADDOUT'), 'false', 'a control bus written with Out would accumulate');
});

test('the stepped channel controls include every grain control', () => {
  const list = /var steppedChannelControls = #\[([^\]]*)\]/.exec(SRC)?.[1] ?? '';
  for (const name of ['grainpos', 'grainsize', 'grainrate', 'grainpan']) {
    assert.ok(list.includes(`\\${name}`), `${name} must be set outright: a ramp smears a per-grain rand() into a drift`);
  }
});

test('the side and window helpers run: what they hand back before and after a read', (t) => {
  // A server that was never booted: allocation works (it is local bookkeeping), every message
  // goes nowhere, and no read ever completes - which is exactly the "not yet" half of both
  // helpers, the half an event can actually meet.
  const out = runSclang(`(
var server = Server(\\poptartGrainHelpers, NetAddr("127.0.0.1", 57997));
var grainSides = IdentityDictionary.new, grainWindows = Dictionary.new;
var grainWindowFrames = 1024;
var grainSidesFor, grainWindowFor, freeGrainSides;
var mono, stereo, pair, window;
${extract('grainSidesFor')}
${extract('freeGrainSides')}
${extract('grainWindowFor')}
mono = Buffer.new(server, 100, 1);
stereo = Buffer.new(server, 100, 2);
stereo.path = "/nowhere/stereo.wav";
pair = grainSidesFor.(mono);
("MONO<" ++ (pair[0] === mono) ++ ":" ++ (pair[1] === mono) ++ ">").postln;
("STEREO<" ++ grainSidesFor.(stereo).isNil ++ ":" ++ grainSides[stereo.bufnum] ++ ":" ++ grainSidesFor.(stereo).isNil ++ ">").postln;
freeGrainSides.(stereo);
("FREED<" ++ grainSides[stereo.bufnum].isNil ++ ">").postln;
("BELL<" ++ grainWindowFor.("") ++ ">").postln;
window = "[{\\"x\\":0,\\"y\\":0,\\"c\\":0},{\\"x\\":0.1,\\"y\\":1,\\"c\\":-4},{\\"x\\":1,\\"y\\":0,\\"c\\":0}]";
("WINDOW<" ++ grainWindowFor.(window) ++ ":" ++ grainWindowFor.(window) ++ ":" ++ grainWindows.size ++ ">").postln;
// Past the cap, entries nothing has asked for in a while go - and ones just asked for stay.
60.do { |i| grainWindowFor.("[{\\"x\\":0,\\"y\\":" ++ (i / 100) ++ "},{\\"x\\":1,\\"y\\":0}]") };
("KEPT<" ++ grainWindows.size ++ ">").postln;
grainWindows.do { |e| e[\\used] = e[\\used] - 60 };
grainWindowFor.(window);
grainWindowFor.("[{\\"x\\":0,\\"y\\":1},{\\"x\\":1,\\"y\\":0.5}]");
("EVICTED<" ++ grainWindows.size ++ ":" ++ grainWindows[window].notNil ++ ">").postln;
0.exit;
)
`);
  if (!/MONO</.test(out)) {
    t.skip(`sclang did not run the grain helpers here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  assert.equal(mark(out, 'MONO'), 'true:true', 'a mono file is both of its own sides');
  assert.equal(mark(out, 'STEREO'), 'true:loading:true', 'a stereo file is "not yet" until both reads land, and is only read once');
  assert.equal(mark(out, 'FREED'), 'true', 'a reloaded pack takes its side copies with it');
  assert.equal(mark(out, 'BELL'), '-1', 'no window is the built-in bell');
  assert.equal(mark(out, 'WINDOW'), '-1:-1:1', 'a window still being sent plays the bell, and is only sent once');
  assert.equal(mark(out, 'KEPT'), '61', 'nothing recently asked for is evicted, however many there are');
  assert.equal(mark(out, 'EVICTED'), '2:true', 'stale windows go; the one just asked for stays');
});

const rms = (seg) => Math.sqrt(seg.reduce((a, v) => a + v * v, 0) / Math.max(1, seg.length));

function channel(render, c, fromSec, toSec) {
  const from = Math.round(fromSec * SR);
  const to = Math.min(Math.round(toSec * SR), render.frames);
  const seg = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < seg.length; i++) seg[i] = render.data[(from + i) * render.channels + c];
  return seg;
}

test('rendered: sides, pan, size and rate, the window, and the gate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-grain-nrt-'));
  try {
    const tone = new Float32Array(SR * 2);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const tonePath = path.join(dir, 'tone.wav');
    const silentPath = path.join(dir, 'silent.wav');
    writeWav(tonePath, { sampleRate: SR, channels: 1, data: tone });
    writeWav(silentPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR * 2) });
    const outPath = path.join(dir, 'render.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    // Voices, two output channels each. bufL 0 is a tone and bufR 1 is silence - a "stereo file"
    // whose sides are as different as two sides can be.
    //   0/1   stereo, pan 0: the file as recorded - tone left, nothing right
    //   2/3   stereo, pan 1: both sides carried to the right edge
    //   4/5   mono, pan 0: the same level on both sides
    //   6/7   mono, 10ms grains at 20 a second: sound a fifth of the time, not all of it
    //   8/9   mono, through an all-zero window: silence, so the window IS the grain's envelope
    //   10/11 mono, gate closed at 0.5s with a 50ms release: gone by 0.7s
    const voice = (id, def, out, extra) => `[0.05, ["/s_new", "${def}", ${id}, 0, 0, "out", ${out}, "bufL", 0, "bufR", 1,
        "begin", 0.25, "rate", 1.0, "amp", 1.0, "grainsize", 0.1, "grainrate", 40, ${extra}]]`;
    const script = `(
var grainMaxOverlap = ${MAX_OVERLAP}, mono, stereo;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
mono = ${grainDef(1)};
stereo = ${grainDef(2)};
("DEFS-OK<" ++ mono.name ++ " " ++ stereo.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", mono.asBytes]],
    [0.0, ["/d_recv", stereo.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(tonePath)}]],
    [0.0, ["/b_allocRead", 1, ${JSON.stringify(silentPath)}]],
    [0.0, ["/b_alloc", 2, 1024, 1]],
    ${voice(1000, 'poptart_sample_grain_2', 0, '"grainpan", 0')},
    ${voice(1001, 'poptart_sample_grain_2', 2, '"grainpan", 1')},
    ${voice(1002, 'poptart_sample_grain_1', 4, '"grainpan", 0')},
    ${voice(1003, 'poptart_sample_grain_1', 6, '"grainsize", 0.01, "grainrate", 20')},
    ${voice(1004, 'poptart_sample_grain_1', 8, '"win", 2')},
    ${voice(1005, 'poptart_sample_grain_1', 10, '"rel", 0.05')},
    [0.5, ["/n_set", 1005, "gate", 0]],
    [1.2, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(12), duration: 1.2,
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
    const out = runSclang(script, 300000);
    if (!out.includes('DEFS-OK<')) {
      t.skip(`sclang did not build the grain defs here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
      return;
    }
    if (!out.includes('RENDER-DONE')) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const render = readWavRaw(outPath);
    assert.ok(render && render.channels === 12, 'unreadable render');
    const level = (c, from = 0.3, to = 1.0) => rms(channel(render, c, from, to));
    const floor = 1e-4;

    assert.ok(level(0) > 0.05, `stereo, pan 0: the left side sounds (${level(0).toFixed(4)})`);
    assert.ok(level(1) < floor, `stereo, pan 0: and stays out of the right (${level(1).toFixed(6)})`);

    assert.ok(level(2) < floor, `stereo, pan 1: nothing left on the left (${level(2).toFixed(6)})`);
    assert.ok(level(3) > 0.05, `stereo, pan 1: the left side has travelled right (${level(3).toFixed(4)})`);

    assert.ok(level(4) > 0.05, 'mono, pan 0: sounds');
    assert.ok(Math.abs(level(4) - level(5)) / level(4) < 0.01, `mono, pan 0: centered (${level(4).toFixed(4)} / ${level(5).toFixed(4)})`);
    // The mono voice gets back the 3 dB an equal-power pan takes at center, so a side of it sits
    // where the same material does as one side of a stereo pair.
    assert.ok(Math.abs(level(4) - level(0)) / level(0) < 0.05, `mono at center matches a stereo side (${level(4).toFixed(4)} vs ${level(0).toFixed(4)})`);

    // 10ms grains, 20 a second: a fifth of the second has a grain in it. A bell is quiet at its
    // edges, so "sounding" is measured well under the peak and lands a little below that fifth.
    const sparse = channel(render, 6, 0.1, 1.1);
    const sounding = sparse.reduce((n, v) => n + (Math.abs(v) > 0.01 ? 1 : 0), 0) / sparse.length;
    t.diagnostic(`10ms grains at 20/s sound ${(sounding * 100).toFixed(1)}% of the time`);
    assert.ok(sounding > 0.08 && sounding < 0.22, `size is seconds and rate is grains a second (${sounding.toFixed(3)})`);

    assert.ok(level(8) < floor, `an all-zero window silences the grain (${level(8).toFixed(6)})`);

    assert.ok(level(10, 0.1, 0.45) > 0.05, 'gated voice: sounds while its gate is open');
    assert.ok(level(10, 0.7, 1.1) < floor, `gated voice: released and gone (${level(10, 0.7, 1.1).toFixed(6)})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
