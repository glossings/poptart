'use strict';

// A drawn lfo() shape through a real scsynth: the tables are the files the engine writes for one
// (OscEngine#_shapeTables), read into Buffers, and the modulator is the one shape def sc/poptart.scd
// boots with (poptart_shape_lfo, and its sample-rate twin), lifted, not copied. A redraw (a shape
// dragged in the editor) is a new table under the running synth, so what has to hold is: the phase
// carries straight across it (no restart from the start phase), the output follows the NEW shape
// from that phase on, and an anchor afterwards still takes the phase over. The sample-rate twin -
// what drives a control of poptart's own devices - plays the same shape, and moves every sample
// rather than once a block.
//
// Skipped, not failed, where sclang or scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath, OscEngine } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SR = 48000;
const BLOCK = 64;
const SCD = path.join(__dirname, 'sc', 'poptart.scd');

/** The boot-time shape defs, as a list rather than added. */
function shapeDefs() {
  const src = fs.readFileSync(SCD, 'utf8');
  const from = src.indexOf('    [\\kr, \\ar].do { |at|\n        SynthDef(if (at == \\ar) { \\poptart_shape_lfo_ar }');
  assert.ok(from > 0, 'the shape modulator defs are not in poptart.scd any more');
  const end = src.indexOf('        }).add;\n    };', from);
  return src.slice(from, end + '        }).add;\n    };'.length)
    .replace('].do { |at|', '].collect { |at|')
    .replace(/\}\)\.add;\n {4}\};$/, '}) };');
}

/** What the engine writes for a set of shapes: the table files, as it sends them. */
let serial = 0; // file names are the engine's own serial: one per stand-in here, so none collide
function tables(shapes) {
  const engine = { _shapeKeys: new Map(), _shapeFileSerial: (serial += 1000) };
  const [, paths] = OscEngine.prototype._shapeTables.call(engine, 't', 1, 'x', shapes);
  return JSON.parse(paths);
}

function render(dir, files) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'redraw.wav');
  const q = (s) => JSON.stringify(s);
  const script = `(
var defs, readKr, readAr, score, options;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
defs = ${shapeDefs()}
readKr = SynthDef(\\sr_read, { |out, bus| Out.ar(out, K2A.ar(In.kr(bus))) });
readAr = SynthDef(\\sr_read_ar, { |out, bus| Out.ar(out, In.ar(bus, 1)) });
score = Score([
    [0.0, ['/d_recv', defs[0].asBytes]],
    [0.0, ['/d_recv', defs[1].asBytes]],
    [0.0, ['/d_recv', readKr.asBytes]],
    [0.0, ['/d_recv', readAr.asBytes]],
    [0.0, ['/b_allocRead', 0, ${q(files[0])}]],
    [0.0, ['/b_allocRead', 1, ${q(files[1])}]],
    [0.0, ['/s_new', 'poptart_shape_lfo', 1000, 0, 0, 'out', 3, 'buf', 0, 'rate', 1, 'phase', 0]],
    [0.0, ['/s_new', 'poptart_shape_lfo_ar', 1001, 0, 0, 'out', 20, 'buf', 0, 'rate', 1, 'phase', 0]],
    [0.0, ['/s_new', 'sr_read', 1100, 1, 0, 'out', 0, 'bus', 3]],
    [0.0, ['/s_new', 'sr_read_ar', 1101, 1, 0, 'out', 1, 'bus', 20]],
    // The redraw: the running synths are pointed at the new table.
    [0.3, ['/n_set', 1000, 'buf', 1]],
    [0.3, ['/n_set', 1001, 'buf', 1]],
    // An anchor after it (a trigger with a phase): the anchored phase takes over.
    [0.7, ['/n_set', 1000, 't_trig', 1, 'phase', 0.25]],
    [0.7, ['/n_set', 1001, 't_trig', 1, 'phase', 0.25]],
    [1.0, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0);
options.sampleRate = ${SR};
score.recordNRT(
    ${q(path.join(dir, 'redraw.osc'))}, ${q(out)}, nil,
    sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
    options: options, duration: 1.0,
    action: { "RENDER-DONE".postln; 0.exit });
SystemClock.sched(90, { "RENDER-TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-u', '57303', file], { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('the engine writes a drawn shape as a table no smaller than 4096 points, larger for a busy shape', () => {
  const few = tables([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const many = tables([Array.from({ length: 1000 }, (_, i) => ({ x: i / 999, y: i % 2 }))]);
  try {
    const a = readWavRaw(few[0]);
    const b = readWavRaw(many[0]);
    assert.equal(a.data.length, 4096);
    assert.ok(Math.abs(a.data[2048] - 2048 / 4095) < 1e-5, 'a ramp is a ramp');
    assert.equal(b.data.length, 16384, 'sixteen points per breakpoint');
  } finally {
    for (const f of [...few, ...many]) fs.rmSync(f, { force: true });
  }
});

test('a drawn shape redrawn while it plays carries its phase across, and follows the new shape from there', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-redraw-'));
  // A ramp from 0 to 1 over a period, redrawn as a ramp from 0 to 0.5.
  const files = tables([[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0.5 }]]);
  try {
    const { text, out } = render(dir, files);
    if (!text.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    assert.ok(text.includes('RENDER-DONE') && fs.existsSync(out), `the render failed:\n${text.trim().split('\n').slice(-12).join('\n')}`);
    const wav = readWavRaw(out);
    const s = (ch, i) => wav.data[i * wav.channels + ch];
    const slack = (2 * BLOCK) / SR;

    for (const ch of [0, 1]) {
      const what = ch ? 'at the sample rate' : 'at the control rate';
      // The old ramp before the redraw, the new half-height ramp at the same phase after: a
      // restart at 0.3 would put 0.5s at 0.1.
      assert.ok(Math.abs(s(ch, Math.floor(0.25 * SR)) - 0.25) < slack, `${what}, before the redraw: ${s(ch, Math.floor(0.25 * SR))}`);
      assert.ok(Math.abs(s(ch, Math.floor(0.5 * SR)) - 0.25) < slack, `${what}, after it, half of phase 0.5: ${s(ch, Math.floor(0.5 * SR))}`);
      // The anchor at 0.7 sets the phase to 0.25 from there: 0.35 at 0.8, at half height.
      assert.ok(Math.abs(s(ch, Math.floor(0.8 * SR)) - 0.175) < slack, `${what}, the anchored phase: ${s(ch, Math.floor(0.8 * SR))}`);
    }
    // The sample-rate one moves every sample; the control-rate one once a block.
    const at = Math.floor(0.5 * SR) + 3;
    assert.ok(s(1, at + 1) !== s(1, at), 'the sample-rate shape holds still within a block');
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
