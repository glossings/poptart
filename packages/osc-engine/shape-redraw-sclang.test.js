'use strict';

// A drawn lfo() shape redrawn while it plays (a shape dragged in the editor), through a real
// scsynth: the def is shapeLfoDef from sc/poptart.scd, lifted, not copied, and the redraw is the
// replace setParamShapeLFO does - a synth of the new shape takes the old one's place, born with
// phaseIn on the bus the old one wrote its phase to. What has to hold: the phase carries straight
// across the redraw (no restart from the start phase), the output follows the NEW shape from that
// phase on, and a trigger afterwards still takes the phase back over.
//
// Skipped, not failed, where sclang or scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SR = 48000;
const BLOCK = 64;
const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function lift(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `${name} is not in poptart.scd any more`);
  return m[0];
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'redraw.wav');
  const q = (s) => JSON.stringify(s);
  const points = (y1) => q(JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: y1 }]));
  const script = `(
var shapeLfoDef, a, b, readKr, score, options;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
${lift('shapeLfoDef')}
// A ramp from 0 to 1 over a period, redrawn as a ramp from 0 to 0.5.
a = shapeLfoDef.(\\sr_a, ${points(1)}.parseJSON, \\free);
b = shapeLfoDef.(\\sr_b, ${points(0.5)}.parseJSON, \\free);
readKr = SynthDef(\\sr_read, { |out, bus| Out.ar(out, K2A.ar(In.kr(bus))) });
score = Score([
    [0.0, ['/d_recv', a.asBytes]],
    [0.0, ['/d_recv', b.asBytes]],
    [0.0, ['/d_recv', readKr.asBytes]],
    [0.0, ['/s_new', 'sr_a', 1000, 0, 0, 'out', 3, 'phaseOut', 4, 'rate', 1, 'phase', 0]],
    [0.0, ['/s_new', 'sr_read', 1100, 1, 0, 'out', 0, 'bus', 3]],
    [0.0, ['/s_new', 'sr_read', 1101, 1, 0, 'out', 1, 'bus', 4]],
    // The redraw: addAction 4 replaces node 1000 in place, as Synth.replace does.
    [0.3, ['/s_new', 'sr_b', 1001, 4, 1000, 'out', 3, 'rate', 1, 'phase', 0, 't_trig', 0, 'phaseIn', 4, 'phaseOut', 4]],
    // An anchor after it (a trigger with a phase): the anchored phase takes over from the carried one.
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
    text = execFileSync(sclang, ['-u', '57303', file], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('a drawn shape redrawn while it plays carries its phase across, and follows the new shape from there', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-redraw-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('RENDER-DONE') && fs.existsSync(out), `the render failed:\n${text.trim().split('\n').slice(-12).join('\n')}`);
  const wav = readWavRaw(out);
  const s = (ch, i) => wav.data[i * wav.channels + ch];
  // The phase is read once a block and ramped between reads, so it is held to within two blocks.
  const slack = (2 * BLOCK) / SR;

  // Phase: t, straight through the redraw at 0.3 (a restart would drop it back to 0 there).
  let worst = 0;
  for (let i = Math.floor(0.05 * SR); i < Math.floor(0.69 * SR); i += 16) worst = Math.max(worst, Math.abs(s(1, i) - i / SR));
  assert.ok(worst < slack, `the phase strayed ${worst.toFixed(4)} from the clock across the redraw`);

  // The output: the old ramp before, the new half-height ramp at the same phase after.
  const before = Math.floor(0.25 * SR), after = Math.floor(0.5 * SR);
  assert.ok(Math.abs(s(0, before) - 0.25) < slack, `before the redraw: ${s(0, before)}`);
  assert.ok(Math.abs(s(0, after) - 0.25) < slack, `after the redraw, half of phase 0.5: ${s(0, after)}`);

  // The anchor at 0.7 sets the phase to 0.25 from there.
  const anchored = Math.floor(0.8 * SR);
  assert.ok(Math.abs(s(1, anchored) - 0.35) < slack, `the anchored phase: ${s(1, anchored)}`);
});
