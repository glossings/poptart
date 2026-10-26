'use strict';

// A patterned LFO rate on the desktop engine (sc/poptart.scd). The scheduler sends each change of
// the rate as an anchor timestamped at its step - the phase its integral has reached there, and
// the rate from then on (see pattern-core's Scheduler#_scheduleRateChanges) - and a shape swap
// names the rate its new shape starts at.
//
// Two halves. The handlers are lifted out of the shipped file and run against stand-ins, to pin
// which control each message sets: a basic shape calls its rate \freq, a drawn one \rate, and a
// drawn one's next swap has to start at the rate it was last given. Then the real poptart_lfo_saw
// def is rendered offline under the anchors a real Scheduler sends for "<0.25 1 [2 4] 3>", and the
// output is held to the JS count - saw reads as its own phase, so a sample of it IS the phase.
//
// Skipped (not failed) where sclang or scsynth can't run, like the other *-sclang tests.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57311'; // its own, like every sclang harness: only ten are tried from 57120 up
const SR = 48000;

function scdSource() {
  return fs.readFileSync(SCD, 'utf8');
}

// The function an OSCdef registers, from its `OSCdef(\name, {` to the `}, '/address');` at column 0.
function extractHandler(name, address) {
  const re = new RegExp(`^OSCdef\\(\\\\${name}, (\\{ \\|msg\\|[\\s\\S]*?^\\}), '${address.replace(/\//g, '\\/')}'\\);$`, 'm');
  const m = scdSource().match(re);
  assert.ok(m, `could not find the ${name} handler in sc/poptart.scd`);
  // The stand-in synths are Events, which already understand `set` as something else; route the
  // handlers' sets to a recorder instead, and their Synth(...) builds to a stand-in maker.
  return m[1].replace(/\.set\(/g, '.recordSet(').replace(/\bSynth\(/g, 'mockSynth.(');
}

function extractLfoDef() {
  const src = scdSource();
  const start = src.indexOf('SynthDef(("poptart_lfo_" ++ shape).asSymbol, {');
  assert.ok(start >= 0, 'could not find the poptart_lfo_ defs in sc/poptart.scd');
  const end = src.indexOf('}).add;', start);
  return `${src.slice(start, end)}})`;
}

function runSclang(script, timeout = 60000) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-lfo-rate-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

test('an anchor with a rate sets it on the synth, by the name each shape kind uses', (t) => {
  const script = `(
var tracks = IdentityDictionary.new;
var server; // the swap handler names it, for a phase bus the drawn entry below already has
var bundleNow = { |latency, func| func.value };
var log = List.new;
var made = 0;
var mockSynth = { |def, args, target, addAction|
    made = made + 1;
    (know: true, def: def, args: args, recordSet: { |self ...a| log.add([self[\\def], a]) })
};
var stub = { |def| (know: true, def: def, recordSet: { |self ...a| log.add([self[\\def], a]) }) };
var anchor = ${extractHandler('poptartAnchorParamLFO', '/poptart/anchorParamLFO')};
var swap = ${extractHandler('poptartSetParamShape', '/poptart/setParamShape')};
var basic = (synth: stub.(\\basic), shape: \\saw);
var drawn = (synth: stub.(\\drawn), shape: \\custom, mode: \\free, rate: 0.5, lo: 0, hi: 1,
    defs: [\\shapeA, \\shapeB], current: 0, glide: 0, bus: 9, group: 1, phaseBus: 5);
tracks[\\t] = (lfos: (slot0_A: basic, slot0_B: drawn));

anchor.([nil, "t", 0, "A", 0.25, 0.1]);
anchor.([nil, "t", 0, "A", 0.5, 0.1, 2.0]);
anchor.([nil, "t", 0, "B", 0.75, 0.1, 3.0]);
log.do { |e| ("SET<" ++ e[0] ++ ":" ++ e[1].collect(_.asString).join(",") ++ ">").postln };
("DRAWN-RATE<" ++ drawn[\\rate] ++ ">").postln;

swap.([nil, "t", 0, "B", 1, 0.1, 1.5]);
("SWAP<" ++ drawn[\\synth][\\def] ++ ":" ++ drawn[\\synth][\\args].collect(_.asString).join(",") ++ ">").postln;
("SWAP-RATE<" ++ drawn[\\rate] ++ ">").postln;
swap.([nil, "t", 0, "B", 0, 0.1]);
("SWAP2<" ++ drawn[\\synth][\\args].collect(_.asString).join(",") ++ ">").postln;
0.exit;
)
`;
  const out = runSclang(script);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^SET<basic:t_trig,1,phase,0\.25>$/m, `a rateless anchor is the phase reset it always was:\n${out}`);
  assert.match(out, /^SET<basic:t_trig,1,phase,0\.5,freq,2\.0>$/m, `a basic shape's rate is \\freq:\n${out}`);
  assert.match(out, /^SET<drawn:t_trig,1,phase,0\.75,rate,3\.0>$/m, `a drawn shape's rate is \\rate:\n${out}`);
  assert.match(out, /^DRAWN-RATE<3\.0>$/m, `the drawn entry remembers the rate for its next swap:\n${out}`);
  assert.match(out, /^SWAP<shapeB:out,9,rate,1\.5,/m, `a swap starts the new shape at the rate it names:\n${out}`);
  assert.match(out, /^SWAP-RATE<1\.5>$/m, `and remembers it:\n${out}`);
  assert.match(out, /^SWAP2<out,9,rate,1\.5,/m, `a swap naming no rate keeps the one in force:\n${out}`);
});

test('the native saw, driven by the scheduler\'s anchors, plays the JS count', async (t) => {
  const { saw, note, lfoPhaseCount } = await import('../pattern-core/src/signal.mjs');
  const { Scheduler } = await import('../pattern-core/src/scheduler.mjs');
  const lfo = saw('<0.25 1 [2 4] 3>');
  const cps = 0.5;
  const DURATION = 8;

  // A real Scheduler against a recording engine, ticked the way its timer would.
  const calls = [];
  const state = { now: 0 };
  const engine = new Proxy({ getTime: () => state.now }, {
    get: (o, p) => (p in o ? o[p] : (...args) => { calls.push({ method: p, args }); }),
  });
  const sch = new Scheduler(engine, { trackId: 't', cps });
  sch.setPattern(note('c').synth('X').param('Cutoff', lfo));
  sch.start(0);
  clearInterval(sch._timer);
  for (state.now = 0; state.now < DURATION; state.now += 0.03) sch._tick();
  const seed = calls.find((c) => c.method === 'setParamLFO').args[3];
  const anchors = calls.filter((c) => c.method === 'anchorParamLFO').map((c) => c.args);
  assert.ok(anchors.length > 4);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-lfo-rate-nrt-'));
  try {
    const outPath = path.join(dir, 'render.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    const events = anchors
      .filter((a) => a[4] < DURATION)
      .map((a) => `    [${a[4]}, ["/n_set", 1000, "t_trig", 1, "phase", ${a[3]}, "freq", ${a[5]}]],`)
      .join('\n');
    const script = `(
var shape = \\saw;
var lfoDef = ${extractLfoDef()};
var tapDef = SynthDef(\\poptart_tap, { |in| Out.ar(0, K2A.ar(In.kr(in))) });
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
("DEF-OK<" ++ lfoDef.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", lfoDef.asBytes]],
    [0.0, ["/d_recv", tapDef.asBytes]],
    [0.0, ["/s_new", "poptart_lfo_saw", 1000, 0, 0, "out", 5, "freq", ${seed.rateHz}, "phase", 0, "lo", 0, "hi", 1]],
    [0.0, ["/s_new", "poptart_tap", 1001, 1, 0, "in", 5]],
${events}
    [${DURATION}, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(1), duration: ${DURATION},
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
    const out = runSclang(script, 120000);
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    assert.match(out, /DEF-OK<poptart_lfo_saw>/, `the LFO def did not build:\n${out}`);
    if (!out.includes('RENDER-DONE') || !fs.existsSync(outPath)) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const r = readWavRaw(outPath);
    assert.ok(r, 'unreadable render');
    // Offline, every timestamp lands on a control block (64 samples), and the Sweep counts in
    // blocks too: at the fastest rate here (2 Hz) that is a few thousandths of a turn.
    const first = anchors[0][4];
    let checked = 0;
    let worst = 0;
    for (let sec = first + 0.05; sec < DURATION - 0.05; sec += 0.0371) {
      const want = ((lfoPhaseCount(lfo.lfoIR, sec, cps, sec * cps) % 1) + 1) % 1;
      if (want < 0.02 || want > 0.98) continue; // the saw's wrap: a block either side is all of it
      const got = r.data[Math.round(sec * SR) * r.channels];
      worst = Math.max(worst, Math.abs(got - want));
      checked++;
    }
    t.diagnostic(`${checked} points, worst ${worst.toFixed(4)} turns`);
    assert.ok(checked > 100);
    assert.ok(worst < 0.01, `the native saw strays ${worst.toFixed(4)} turns from the JS count`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
