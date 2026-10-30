'use strict';

// The mixer's analysis SynthDef (sc/poptart.scd, buildMixDef) and the tap reconcile around it.
// The analyzer is the PoptartSpectrum unit (native/devices/PoptartSpectrum.cpp, the browser's
// measurement) wherever poptart's own devices are installed, and a bank of band-pass filters
// where they are not. For the unit: the def builds around it and loads and runs in scsynth. For
// the bank: (1) both defs still BUILD against the band list the engine ships; (2) the
// analyzer's graph ORDER - its frame clock has to be the first UGen so sclang's sort interleaves
// filters and followers, or every filtered band is live at once (384 wires against scsynth's
// default 64) and the def silently fails to load, which shows up as a mixer whose plots just
// never move; (3) that it really does load into a default-configured scsynth, checked by an NRT
// render (offline, no audio device); (4) mixReconcile compiles.
//
// Like the other *-sclang tests, the source under test is lifted out of the shipped poptart.scd
// (not a copy), run in a real sclang, and skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath, MIX_BAND_FREQS } = require('./index.js');
const { userExtensionsDir, DEVICE_BINARY } = require('./extensions.js');

const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX_DIR = path.dirname(DEVICE_BINARY); // this platform's build (extensions.js)

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extractClosure(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

// The most audio-rate wires live at once when scsynth runs the def in sclang's sorted order: an
// ar output takes a wire buffer when its unit runs and gives it back once its last consumer has.
// This is the number "exceeded number of interconnect buffers" compares against the server's
// numWireBufs (64 by default).
const MAX_WIRES_SC = `
maxWires = { |def|
    var consumers = IdentityDictionary.new, live = 0, peak = 0;
    def.children.do { |u| u.inputs.do { |in| if (in.isKindOf(OutputProxy)) { in = in.source };
        if (in.isKindOf(UGen) and: { in.rate == \\audio }) { consumers[in] = (consumers[in] ? 0) + 1 } } };
    def.children.do { |u| var seen = IdentitySet.new;
        if (u.rate == \\audio) { live = live + u.numOutputs; peak = max(peak, live) };
        u.inputs.do { |in| if (in.isKindOf(OutputProxy)) { in = in.source };
            if (in.isKindOf(UGen) and: { in.rate == \\audio } and: { seen.includes(in).not }) {
                seen.add(in); consumers[in] = consumers[in] - 1;
                if (consumers[in] == 0) { live = live - in.numOutputs } } } };
    peak
};`;

// `native`: with poptart's own classes (PoptartSpectrum) or without them (the filter bank). The
// installed copy is left out either way, so which one is built does not depend on this machine.
function runSclang(dir, native) {
  const conf = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(conf, `${native ? `includePaths:\n  - ${NATIVE_DIR}\n` : ''}excludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  const script = `(
var mixBandFreqs, buildMixDef, mixBank, maxWires, analysis, meter, score, opts;
var mixReconcile, mixReconciling = false, mixDirty = false, mixOn = false;
var mixTaps = IdentityDictionary.new, mixWanted = IdentitySet.new, mixMaster, tracks = IdentityDictionary.new;
var startMixTap, stopMixTap, stopMixMaster, mixForwards, recGroup;
${extractClosure('buildMixDef')}
${extractClosure('mixBank')}
${MAX_WIRES_SC}
buildMixDef.(${JSON.stringify(MIX_BAND_FREQS)}.collect(_.asFloat));
analysis = SynthDescLib.global[\\poptart_mix_analysis].def;
meter = SynthDescLib.global[\\poptart_mix_meter].def;
("BUILT<" ++ analysis.children.size ++ "," ++ meter.children.size ++ ">").postln;
("FIRST<" ++ analysis.children.first.class.name ++ ">").postln;
("WIRES<" ++ maxWires.(analysis) ++ ">").postln;
${extractClosure('mixReconcile')}
("RECONCILE-OK<" ++ mixReconcile.isKindOf(Function) ++ ">").postln;
// Load it into a default-configured scsynth: pink noise on a private bus, one analyzer reading
// it, half a second. A def that overran the wire buffers prints "exception in GraphDef_Recv"
// and "SynthDef not found" here instead of loading.
score = Score.new;
score.add([0, [\\d_recv, analysis.asBytes]]);
score.add([0, [\\d_recv, SynthDef(\\src, { |bus| Out.ar(bus, PinkNoise.ar(0.3 ! 2)) }).asBytes]]);
score.add([0.01, [\\s_new, \\src, 1000, 0, 0, \\bus, 16]]);
score.add([0.01, [\\s_new, \\poptart_mix_analysis, 1001, 1, 0, \\bus, 16]]);
score.add([0.5, [\\c_set, 0, 0]]);
opts = ServerOptions.new.blockSize_(256).numOutputBusChannels_(2);
opts.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${JSON.stringify(SCX_DIR)}];
score.recordNRT(${JSON.stringify(path.join(dir, 'a.osc'))}, ${JSON.stringify(path.join(dir, 'a.wav'))},
    nil, 48000, "WAV", "int16", opts, action: { "NRT-DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-l', conf, '-u', native ? '57334' : '57335', file], {
      encoding: 'utf8',
      timeout: 90000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the mixer analyzer is the native spectrum unit where it is installed, and it loads and runs', (t) => {
  if (!fs.existsSync(DEVICE_BINARY)) { t.skip('no PoptartDevices.scx in this checkout'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-mixanalysis-'));
  const out = runSclang(dir, true);
  if (!out.includes('Welcome to SuperCollider')) { t.skip('sclang did not start here'); return; }
  const built = out.match(/^BUILT<(\d+),(\d+)>$/m);
  assert.ok(built, `the analysis defs did not build:\n${out}`);
  assert.ok(Number(built[1]) < 20, `analysis def has ${built[1]} UGens - expected the one unit, not the filter bank`);
  assert.match(out, /^RECONCILE-OK<true>$/m, `mixReconcile did not compile:\n${out}`);
  assert.ok(out.includes('NRT-DONE'), `scsynth did not render:\n${out.trim().split('\n').slice(-8).join('\n')}`);
  assert.doesNotMatch(out, /not installed|SynthDef not found|exception in GraphDef_Recv/, `the analyzer did not load:\n${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without poptart\'s own devices, the filter-bank analyzer builds, sorts within the default wire buffers, and loads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-mixanalysis-'));
  const out = runSclang(dir, false);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here, so the defs went unbuilt: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  const built = out.match(/^BUILT<(\d+),(\d+)>$/m);
  assert.ok(built, `the analysis defs did not build:\n${out}`);
  // 96 bands x (2 BPF + 4 binops + 4 Peak) plus the handful around them; the meter def is tiny.
  assert.ok(Number(built[1]) > 900, `analysis def has ${built[1]} UGens - expected the full bank`);
  assert.ok(Number(built[2]) < 10, `meter def has ${built[2]} UGens - expected a bare SendPeakRMS`);
  assert.match(out, /^FIRST<Impulse>$/m, 'the frame clock must be the first UGen built (see the def comment)');
  const wires = out.match(/^WIRES<(\d+)>$/m);
  assert.ok(wires, `no wire count printed:\n${out}`);
  assert.ok(Number(wires[1]) <= 16, `${wires[1]} audio wires live at once - the sort has lost its interleave (limit 64)`);
  assert.match(out, /^RECONCILE-OK<true>$/m, `mixReconcile did not compile:\n${out}`);
  if (!out.includes('NRT-DONE')) {
    t.skip(`scsynth did not render here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.doesNotMatch(out, /exceeded number of interconnect buffers/, 'the analyzer overran the default wire buffers');
  assert.doesNotMatch(out, /SynthDef not found/, 'the analyzer did not load into scsynth');
});
