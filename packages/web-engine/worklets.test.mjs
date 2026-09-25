// The committed worklet bundles.
//
// These are the files a browser actually loads, and they are built artifacts - so they are
// tested as artifacts: read from disk, run in a sandbox with the handful of globals an
// AudioWorkletGlobalScope provides, and driven block by block to check they make the sound
// their sources make. A bundler bug that dropped a module or reordered two of them would pass
// every other test in this package and fail here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { WORKLETS, bundle, collect, readModule, topLevelNames } from './build/bundle-worklets.mjs';
import { WAVETABLE } from './src/devices/wavetable.mjs';
import { DEVICES } from './src/catalog.mjs';
import { PLAITS_ENGINES } from './build/devices/mutable.mjs';
import { DISTORT } from './src/devices/distort.mjs';
import { REVERB } from './src/devices/reverb.mjs';
import { TRACK_BEND_PARAM, defaultValues, normalize } from './src/descriptor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const BLOCK = 128;

/** Loads one built bundle into a sandbox that looks enough like an AudioWorkletGlobalScope. */
function loadBundle(file, rate = SR) {
  const source = fs.readFileSync(path.join(here, 'public', 'worklets', file), 'utf8');
  const registered = new Map();
  const sandbox = {
    sampleRate: rate,
    currentFrame: 0,
    currentTime: 0,
    registerProcessor: (name, cls) => registered.set(name, cls),
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (m) => { this.port.onmessage?.({ data: m }); },
          _send(m) { this.onmessage?.({ data: m }); },
        };
      }
    },
    Math,
    Float32Array,
    Float64Array,
    Uint8Array,
    Object,
    Array,
    Number,
    Error,
    JSON,
    String,
    Map,
    Set,
    console,
    // A ported device's DSP is a compiled module it instantiates itself.
    WebAssembly,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: file });
  return { registered, context };
}

/**
 * The parameters object a worklet's process() is handed: every control as the POSITION its
 * AudioParam carries, from real values with the descriptor's defaults filled in. A block-long
 * array is handed over as it is, already in positions.
 */
function paramsFor(descriptor, overrides = {}) {
  const values = { ...defaultValues(descriptor), ...overrides };
  const out = {};
  for (const p of descriptor.params) {
    const v = values[p.id];
    out[p.id] = v instanceof Float32Array ? v : Float32Array.of(normalize(p, v));
  }
  return out;
}

const peak = (buf) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('every worklet named in the build is committed and registers its processors', () => {
  for (const w of WORKLETS) {
    const file = path.join(here, 'public', 'worklets', w.out);
    assert.ok(fs.existsSync(file), `${w.out} has not been built`);
    const { registered } = loadBundle(w.out);
    // One each, except the bundle that carries the ported devices: they share an implementation
    // and differ only in their controls, so it registers a name per device.
    assert.ok(registered.size >= 1, `${w.out} registers no processor at all`);
  }
});

test('every device in the catalog has a processor that is actually registered somewhere', () => {
  // The gap this closes: a descriptor naming a processor nobody registered is a device that
  // throws the moment a pattern asks for it, and nothing before that point would have noticed.
  const registered = new Set();
  for (const w of WORKLETS) for (const name of loadBundle(w.out).registered.keys()) registered.add(name);
  const missing = DEVICES
    .filter((d) => d.build !== 'nodes')
    .filter((d) => !registered.has(d.processor))
    .map((d) => `${d.id} wants "${d.processor}"`);
  assert.deepEqual(missing, []);
});

// ---- the ported devices ---------------------------------------------------------------------------

/** One compiled device, hosted by the bundle a browser would load. */
function portedDevice(id, rate = SR) {
  const { registered, context } = loadBundle('poptart-wasm.js', rate);
  const descriptor = DEVICES.find((d) => d.id === id);
  const Processor = registered.get(descriptor.processor);
  assert.ok(Processor, `${id} should register as ${descriptor.processor}`);
  const bytes = fs.readFileSync(path.join(here, 'public', 'devices', `${id}.wasm`));
  const node = new Processor({ processorOptions: { module: new WebAssembly.Module(bytes) } });
  node.__context = context;
  return { node, descriptor };
}

/**
 * Moves the clock the worklet reads when it works out where a note lands.
 *
 * `currentFrame` is a global of the AudioWorkletGlobalScope, so it lives in the sandbox the
 * bundle was loaded into rather than on the processor.
 */
function contextFrame(node, frame) {
  node.__context.currentFrame = frame;
}

/** A block of a sine, as an input port, plus the output port to render into. */
function stereoBlock(startPhase = 0, hz = 220) {
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  let phase = startPhase;
  for (let i = 0; i < BLOCK; i++) {
    const s = Math.sin(phase * 2 * Math.PI) * 0.5;
    phase += hz / SR;
    left[i] = s;
    right[i] = s;
  }
  return { input: [[left, right]], phase };
}

test('every ported device is committed as a binary and passes audio through its worklet', () => {
  for (const descriptor of DEVICES.filter((d) => d.build === 'wasm')) {
    const file = path.join(here, 'public', 'devices', `${descriptor.id}.wasm`);
    assert.ok(fs.existsSync(file), `${descriptor.id}.wasm has not been built`);

    const { node } = portedDevice(descriptor.id);
    const params = paramsFor(descriptor);
    const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    let phase = 0;
    let loudest = 0;
    // An instrument makes nothing until it is played; an effect ignores this entirely.
    if (descriptor.kind === 'synth') node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: 0 });
    // Long enough for a reverb to build a tail and a compressor to settle.
    for (let block = 0; block < 400; block++) {
      const made = stereoBlock(phase);
      phase = made.phase;
      out[0][0].fill(0);
      out[0][1].fill(0);
      assert.equal(node.process(made.input, out, params), true, `${descriptor.id} stopped rendering`);
      // An effect is judged late, once a reverb has built its tail and a compressor has settled.
      // An instrument is judged across the whole run: several of these have percussive envelopes
      // and are correctly silent a second after the note, which is not the same as broken.
      if (descriptor.kind === 'synth' || block > 340) loudest = Math.max(loudest, peak(out[0][0]));
      for (const v of out[0][0]) {
        assert.ok(Number.isFinite(v), `${descriptor.id} produced a value that is not a number`);
      }
    }
    assert.ok(loudest > 1e-4, `${descriptor.id} is silent at its own defaults (peak ${loudest})`);
  }
});

// ---- what a control is allowed to do --------------------------------------------------------

/** Every value the panel can produce for a control: an enumerated one's options, or its ends. */
function settingsFor(p) {
  if (p.options) return p.options.map((_, i) => i);
  const lo = Number.isFinite(p.min) ? p.min : 0;
  const hi = Number.isFinite(p.max) ? p.max : 1;
  return [lo, (lo + hi) / 2, hi];
}

/** Runs a ported device for a while and returns the error it died of, or null. */
function survives(id, rate, overrides, blocks = 80) {
  const { node, descriptor } = portedDevice(id, rate);
  const params = paramsFor(descriptor, overrides);
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  let phase = 0;
  if (descriptor.kind === 'synth') node.port._send({ kind: 'noteOn', note: 48, velocity: 1, time: 0 });
  try {
    for (let block = 0; block < blocks; block++) {
      const made = stereoBlock(phase);
      phase = made.phase;
      node.process(made.input, out, params);
    }
  } catch (err) {
    return err.message;
  }
  return null;
}

// The browser picks the sample rate, not us, and 44.1k is as ordinary as 48k. A device compiled
// with a fixed heap and no growth does not degrade when something goes wrong in it - it traps,
// and a trapped processor is silent for the rest of the page's life. So this is checked at the
// rates a page is actually handed rather than only at the one the build was tried at.
const RATES = [44100, 48000, 96000];

test('no control setting traps a ported device, at any sample rate a browser might use', () => {
  // Two real ones this pins down. Braids: eleven of its forty-eight shapes read off the end of
  // their own state when handed a part-sized block, which the wrapper used to do whenever the
  // resampling did not come out even - so they died at 44.1k and were fine at 48k. Warps: the
  // carrier setting indexes a table of five two different ways, and the module's own panel stops
  // at four for that reason, so offering all six killed it near the vocoder end of the algorithm.
  const dead = [];
  for (const descriptor of DEVICES.filter((d) => d.build === 'wasm')) {
    for (const rate of RATES) {
      for (const p of descriptor.params) {
        for (const value of settingsFor(p)) {
          const why = survives(descriptor.id, rate, { [p.id]: value });
          if (why) dead.push(`${descriptor.id} @${rate} with ${p.id}=${value}: ${why}`);
        }
      }
    }
  }
  assert.deepEqual(dead, [], 'a trapped device is silent until the page is reloaded');
});

test('nor does any combination of a device\'s controls at their limits', () => {
  // One control at a time would have missed Warps, which needed its algorithm and its carrier
  // both at the top before the vocoder's index ran off the end.
  const dead = [];
  for (const descriptor of DEVICES.filter((d) => d.build === 'wasm')) {
    const ends = [
      ['bottom', (p) => settingsFor(p)[0]],
      ['top', (p) => settingsFor(p)[settingsFor(p).length - 1]],
    ];
    for (const rate of RATES) {
      for (const [label, pick] of ends) {
        const overrides = Object.fromEntries(descriptor.params.map((p) => [p.id, pick(p)]));
        const why = survives(descriptor.id, rate, overrides);
        if (why) dead.push(`${descriptor.id} @${rate} all at ${label}: ${why}`);
      }
    }
  }
  assert.deepEqual(dead, [], 'a trapped device is silent until the page is reloaded');
});

test('an instrument starts on the sample it was scheduled for, not at the block boundary', () => {
  // The block is cut at the note edge and rendered in pieces for this reason. Starting notes at
  // block boundaries instead would put every one up to three milliseconds late, which on the
  // desktop side was a real bug worth fixing rather than a rounding error.
  const { node, descriptor } = portedDevice('Plaits');
  const params = paramsFor(descriptor, { decay: 0.9 });
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];

  // "Quiet" rather than "exactly zero": the low-pass gate is a filter settling from its initial
  // state, so it leaves a fraction of a percent behind it rather than digital silence.
  const QUIET = 1e-3;

  node.process([], out, params);
  assert.ok(peak(out[0][0]) < QUIET, `should be quiet before it is played, got ${peak(out[0][0])}`);

  // A note sixty samples into the next block.
  node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: (BLOCK + 60) / SR });
  out[0][0].fill(0);
  node.process([], out, params);
  assert.ok(peak(out[0][0]) < QUIET, 'and still quiet through the block before it');

  contextFrame(node, BLOCK);
  out[0][0].fill(0);
  node.process([], out, params);
  assert.ok(peak(out[0][0].subarray(0, 60)) < QUIET, 'nothing before the note inside its own block');
  assert.ok(peak(out[0][0].subarray(60)) > QUIET * 10, 'and it sounds from there');
});

test('an instrument plays the pitch it is given', () => {
  const { node, descriptor } = portedDevice('Plaits');
  const hz = (note) => {
    const { node: fresh } = portedDevice('Plaits');
    const params = paramsFor(descriptor, { decay: 1, engine: 8 });
    const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    fresh.port._send({ kind: 'noteOn', note, velocity: 1, time: 0 });
    let crossings = 0;
    let counted = 0;
    for (let block = 0; block < 200; block++) {
      fresh.process([], out, params);
      if (block > 40 && block < 160) {
        for (let i = 1; i < BLOCK; i++) if (out[0][0][i - 1] < 0 && out[0][0][i] >= 0) crossings++;
        counted += BLOCK;
      }
    }
    return crossings / (counted / SR);
  };
  // Sixty is middle C in poptart's spelling, and the module counts it the same way, so the
  // number passes through untouched. An octave up doubles it.
  assert.ok(Math.abs(hz(60) - 261.6) < 8, `note 60 came out at ${hz(60).toFixed(1)} Hz`);
  assert.ok(Math.abs(hz(72) - 523.3) < 16, `note 72 came out at ${hz(72).toFixed(1)} Hz`);
  void node;
});

test('a ported effect with no binary gets out of the way rather than muting the track', () => {
  // The binary is fetched at boot and a fetch can fail. Writing silence here would not cost one
  // effect, it would cost the whole track: a slot is wired all-wet, so an effect that outputs
  // nothing is a mute on everything upstream of it. Passing the input through costs the effect.
  const { registered } = loadBundle('poptart-wasm.js');
  const descriptor = DEVICES.find((d) => d.id === 'Galactic');
  const node = new (registered.get(descriptor.processor))({});
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  const made = stereoBlock();
  assert.equal(node.process(made.input, out, paramsFor(descriptor)), true);
  assert.deepEqual([...out[0][0]], [...made.input[0][0]], 'the input should have come straight through');
  assert.deepEqual([...out[0][1]], [...made.input[0][1]]);
});

test('a ported instrument with no binary is silent, having no input to pass', () => {
  const { registered } = loadBundle('poptart-wasm.js');
  const descriptor = DEVICES.find((d) => d.id === 'Plaits');
  const node = new (registered.get(descriptor.processor))({});
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: 0 });
  assert.equal(node.process([], out, paramsFor(descriptor)), true);
  assert.equal(peak(out[0][0]), 0);
});

test('a ported device reads the control it is given, not the one next to it', () => {
  // The controls reach the module as one shared array in descriptor order, so an off-by-one
  // here would be every knob doing its neighbor's job - audible, but easy to explain away.
  const { node, descriptor } = portedDevice('Galactic');
  const render = (overrides) => {
    const params = paramsFor(descriptor, overrides);
    const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    let phase = 0;
    let loudest = 0;
    for (let block = 0; block < 200; block++) {
      const made = stereoBlock(phase);
      phase = made.phase;
      node.process(made.input, out, params);
      if (block > 150) loudest = Math.max(loudest, peak(out[0][0]));
    }
    return loudest;
  };
  const dry = render({ drywet: 0 });
  const wet = render({ drywet: 1 });
  assert.ok(Math.abs(dry - 0.5) < 0.02, `all dry, the sine comes back at its own level: ${dry}`);
  assert.ok(wet < dry * 0.95 || wet > dry * 1.05, `the mix control should change the level: ${dry} against ${wet}`);
});

test('the committed bundles are up to date with their sources', () => {
  // A stale bundle is the one way this package can pass every test and still ship the wrong
  // audio, so the artifact is compared against what building it now would produce.
  for (const w of WORKLETS) {
    const built = bundle(path.join(here, w.entry));
    const committed = fs.readFileSync(path.join(here, 'public', 'worklets', w.out), 'utf8');
    assert.equal(committed, built, `${w.out} is out of date - run "npm run build" in packages/web-engine`);
  }
});

test('the bundle needs nothing a worklet scope does not have', () => {
  // Loading it in the sandbox above would have thrown on an undefined global; this pins the
  // list so that adding a dependency on, say, `window` fails here rather than in a browser.
  for (const w of WORKLETS) {
    const source = fs.readFileSync(path.join(here, 'public', 'worklets', w.out), 'utf8');
    for (const forbidden of ['window.', 'document.', 'globalThis.', 'require(', 'import ']) {
      assert.ok(!source.includes(forbidden), `${w.out} refers to ${forbidden}, which a worklet has no access to`);
    }
  }
});

test('the wavetable worklet plays a note, at the sample it was asked for', () => {
  const { registered, context } = loadBundle('poptart-synths.js');
  const Processor = registered.get('poptart-wavetable');
  assert.ok(Processor, 'the processor should register under the name the descriptor gives');
  const node = new Processor({});

  // A worklet's inputs and outputs are indexed by PORT first and channel second, so one stereo
  // output port is [[left, right]] rather than [left, right].
  const channels = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const out = [channels];
  const params = paramsFor(WAVETABLE, { 'ampenv.attack': 0 });

  // Silent before the note.
  node.process([], out, params);
  assert.equal(peak(channels[0]), 0);

  // A note a hundred samples into the next block.
  node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: (BLOCK + 100) / SR });
  context.currentFrame = BLOCK;
  channels[0].fill(0);
  node.process([], out, params);
  assert.equal(peak(channels[0].subarray(0, 100)), 0, 'nothing should sound before the note');
  assert.ok(peak(channels[0].subarray(100)) > 0, 'and the note should start inside the block');
});

test('the wavetable worklet keeps rendering while it has nothing to play', () => {
  const { registered } = loadBundle('poptart-synths.js');
  const node = new (registered.get('poptart-wavetable'))({});
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  const params = paramsFor(WAVETABLE);
  for (let i = 0; i < 50; i++) {
    assert.equal(node.process([], out, params), true, 'a synth must stay alive; the next note is a message away');
  }
});

test('a note released in the worklet dies away and stops', () => {
  const { registered, context } = loadBundle('poptart-synths.js');
  const node = new (registered.get('poptart-wavetable'))({});
  const channels = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const out = [channels];
  const params = paramsFor(WAVETABLE, { 'ampenv.attack': 0, 'ampenv.release': 0.05 });

  node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: 0 });
  node.process([], out, params);
  const sounding = peak(channels[0]);
  assert.ok(sounding > 0);

  node.port._send({ kind: 'noteOff', note: 60, time: 0 });
  let last = 0;
  for (let b = 0; b < 60; b++) {
    context.currentFrame += BLOCK;
    channels[0].fill(0);
    node.process([], out, params);
    last = peak(channels[0]);
  }
  assert.ok(last < sounding * 0.01, `the note should have gone: ${last} against ${sounding}`);
});

test('all-notes-off in the worklet drops what was queued as well as what is sounding', () => {
  const { registered } = loadBundle('poptart-synths.js');
  const node = new (registered.get('poptart-wavetable'))({});
  const channels = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const params = paramsFor(WAVETABLE);
  node.port._send({ kind: 'noteOn', note: 60, velocity: 1, time: 10 });
  node.port._send({ kind: 'allNotesOff', time: 0 });
  assert.equal(node.pending.length, 0);
  node.process([], [channels], params);
  assert.equal(peak(channels[0]), 0);
});

test('the distort worklet distorts what it is given', () => {
  const { registered } = loadBundle('poptart-effects.js');
  const Processor = registered.get('poptart-distort');
  const node = new Processor({});
  const input = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) input[i] = Math.sin((i / BLOCK) * Math.PI * 8) * 0.5;
  const channels = [new Float32Array(BLOCK)];
  node.process([[input]], [channels], paramsFor(DISTORT, { drive: 36, autogain: 0, mix: 1 }));
  assert.ok(peak(channels[0]) > peak(input), 'driving a signal should make it bigger');
  for (const v of channels[0]) assert.ok(Number.isFinite(v));
});

test('the distort worklet passes a signal through at no drive and full dry', () => {
  const { registered } = loadBundle('poptart-effects.js');
  const node = new (registered.get('poptart-distort'))({});
  const input = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) input[i] = Math.sin((i / BLOCK) * Math.PI * 8) * 0.3;
  const channels = [new Float32Array(BLOCK)];
  node.process([[input]], [channels], paramsFor(DISTORT, { mix: 0, output: 0 }));
  for (let i = 0; i < BLOCK; i++) assert.ok(Math.abs(channels[0][i] - input[i]) < 1e-5, `sample ${i} was changed`);
});

test('an effect worklet keeps rendering while its input is quiet, and stops when it is told to', () => {
  const { registered } = loadBundle('poptart-effects.js');
  const node = new (registered.get('poptart-distort'))({});
  const out = [[new Float32Array(BLOCK)]];
  const params = paramsFor(DISTORT);

  // A rest in a pattern looks exactly like being unplugged: the input arrives with no channels
  // either way. An effect that read that as "nobody needs me" would take itself out of the chain
  // during the first bar with a gap in it, and a processor that has returned false never comes
  // back - so the track would be silent from then on, with nothing in the console to say why.
  let alive = true;
  for (let b = 0; b < 2000 && alive; b++) alive = node.process([], out, params);
  assert.ok(alive, 'a quiet input is not a reason to stop');

  node.port._send({ kind: 'dispose' });
  assert.equal(node.process([], out, params), false, 'being told to stop is');
});

test('the reverb worklet makes a tail, and outlives its input by far longer than an effect would', () => {
  const { registered } = loadBundle('poptart-effects.js');
  const node = new (registered.get('poptart-reverb'))({});
  const channels = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const out = [channels];
  const params = paramsFor(REVERB, { mix: 1 });
  const hit = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) hit[i] = Math.sin(i * 0.3) * 0.5;
  node.process([[hit, hit]], out, params);

  let loudest = 0;
  for (let b = 0; b < 200; b++) {
    channels[0].fill(0);
    node.process([], out, params);
    loudest = Math.max(loudest, peak(channels[0]));
  }
  assert.ok(loudest > 1e-4, 'there should be a tail');

  // The longest decay the descriptor allows is thirty seconds, and a reverb that stopped
  // rendering before its own tail had finished would cut it off mid-air.
  let alive = true;
  for (let b = 0; b < 20000 && alive; b++) alive = node.process([], out, params);
  assert.ok(alive, 'a reverb keeps rendering for as long as it is in the chain');
  node.port._send({ kind: 'dispose' });
  assert.equal(node.process([], out, params), false);
});

// --- the bundler itself -----------------------------------------------------------------

test('the bundler strips exports and flattens named imports', () => {
  const parsed = readModule('x.mjs', [
    "import { a, b } from './other.mjs';",
    'export const c = 1;',
    'export function d() { return a + b; }',
    'export { a };',
  ].join('\n'));
  assert.deepEqual(parsed.imports, ['./other.mjs']);
  assert.ok(parsed.body.includes('const c = 1;'));
  assert.ok(parsed.body.includes('function d()'));
  assert.ok(!parsed.body.includes('export'), 'no export keyword should survive');
  assert.ok(!parsed.body.includes('import'), 'no import statement should survive');
});

test('the bundler refuses what it cannot flatten, rather than guessing', () => {
  assert.throws(() => readModule('x.mjs', "import './side-effect.mjs';"), /side-effect import/);
  assert.throws(() => readModule('x.mjs', "import def from './x.mjs';"), /only single-line named imports/);
  assert.throws(() => readModule('x.mjs', "import { a } from 'some-package';"), /only single-line named imports/);
  assert.throws(() => readModule('x.mjs', 'export default class {}'), /default export/);
  assert.throws(() => readModule('x.mjs', "export * from './x.mjs';"), /star re-export/);
});

test('the bundler finds what a module declares at its top level, and only that', () => {
  const names = topLevelNames([
    'const a = 1;',
    'let b = 2;',
    'var c = 3;',
    'function d() {}',
    'class E {}',
    'async function f() {}',
    'export const g = 7;',
    '  const local = 4;',      // indented, so inside something
    '// const commented = 5;',
  ].join('\n'));
  // Indentation is the rule, and it is the right one for this codebase: everything at the top
  // level is written at column zero, so anything indented is inside a function or a block and
  // cannot collide with another module's names.
  assert.deepEqual(names, ['a', 'b', 'c', 'd', 'E', 'f', 'g']);
});

test('the bundler refuses a name two modules both declare', () => {
  const files = {
    '/w/entry.mjs': "import { x } from './dep.mjs';\nconst shared = 1;\nexport const y = x + shared;",
    '/w/dep.mjs': 'export const x = 1;\nconst shared = 2;',
  };
  assert.throws(() => bundle('/w/entry.mjs', (p) => files[p]), /"shared" is declared by both/);
});

test('the bundler puts a dependency before whatever imports it', () => {
  const files = {
    '/w/entry.mjs': "import { x } from './dep.mjs';\nconst y = x + 1;",
    '/w/dep.mjs': 'export const x = 1;',
  };
  const order = collect('/w/entry.mjs', (p) => files[p]).map((m) => path.basename(m.file));
  assert.deepEqual(order, ['dep.mjs', 'entry.mjs'], 'a const is not hoisted, so its module has to come first');
});

test('the bundler catches a circular import rather than looping', () => {
  const files = {
    '/w/a.mjs': "import { b } from './b.mjs';\nexport const a = 1;",
    '/w/b.mjs': "import { a } from './a.mjs';\nexport const b = 2;",
  };
  assert.throws(() => collect('/w/a.mjs', (p) => files[p]), /circular import/);
});

test('an effect makes no sound of its own: silence in, silence out, wherever its controls sit', () => {
  // Warps is the one that can break this rule, and did: its carrier can be the module's own
  // oscillator, which runs whether or not anything is coming in - so on that setting an effect
  // with nothing playing through it drones for ever. Its carrier therefore defaults to the
  // external one. The rule is worth holding for every effect, at both ends of every control:
  // an effect that sounds on its own is a synth somebody did not ask for.
  const loud = [];
  for (const descriptor of DEVICES.filter((d) => d.kind === 'fx' && d.build === 'wasm')) {
    for (const p of descriptor.params) {
      for (const value of settingsFor(p)) {
        const { node } = portedDevice(descriptor.id);
        const params = paramsFor(descriptor, { [p.id]: value });
        const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
        let heard = 0;
        for (let b = 0; b < 200; b++) {
          node.process([[new Float32Array(BLOCK), new Float32Array(BLOCK)]], out, params);
          // Past the first blocks, so a reverb's own initial state is not counted as a sound.
          if (b > 40) heard = Math.max(heard, peak(out[0][0]));
        }
        if (heard > 1e-3) loud.push(`${descriptor.id} with ${p.id}=${value} sounds at ${heard.toFixed(3)} with nothing going in`);
      }
    }
  }
  assert.deepEqual(loud, []);
});

test('a bend moves the ported instruments\' notes while they sound', () => {
  // An octave up on the track's bend input, arriving after the note has started: the pitch should double, measured as the
  // rate the output crosses zero on the way up once it has settled. Settings are each module's
  // plainest pitched sound, so the crossing count is the fundamental's.
  const settings = {
    Plaits: { decay: 1, engine: 8 },
    Braids: { shape: 0, decay: 1 },                                  // a saw, held as long as it goes
    Rings: { damping: 0.9, brightness: 0.3 },                        // a long, dark ring (Rings' damping is its sustain)
    Elements: { bowlevel: 1, strikelevel: 0, damping: 0.1, brightness: 0.3 }, // bowed: it sounds for as long as it is held
  };
  // Where the loudest partial between 60 Hz and 1 kHz sits, from a direct transform of the settled
  // output in 1 Hz steps. A bend moves every partial, and every mode of a resonator, by the same
  // ratio, so this doubles for an octave whether the sound has a clean period (a saw) or not (a
  // bowed resonator, whose inharmonic modes defeat a period estimate).
  const rate = (id, bend) => {
    const { node, descriptor } = portedDevice(id);
    const params = paramsFor(descriptor, settings[id]);
    const bent = { ...params, [TRACK_BEND_PARAM]: Float32Array.of(bend) };
    const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    node.port._send({ kind: 'noteOn', note: 48, velocity: 1, time: 0 });
    const kept = [];
    for (let block = 0; block < 120; block++) {
      node.process([], out, block >= 8 ? bent : params);
      if (block >= 56) kept.push(...out[0][0]);
    }
    const n = kept.length;
    let best = 0;
    let bestHz = 0;
    for (let hz = 60; hz <= 1000; hz += 1) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * hz) / SR;
      for (let i = 0; i < n; i++) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        re += kept[i] * hann * Math.cos(w * i);
        im -= kept[i] * hann * Math.sin(w * i);
      }
      const mag = re * re + im * im;
      if (mag > best) { best = mag; bestHz = hz; }
    }
    return best > 1e-6 ? bestHz : 0;
  };
  for (const id of Object.keys(settings)) {
    const flat = rate(id, 0);
    const up = rate(id, 12);
    assert.ok(flat > 0, `${id} should sound`);
    const ratio = up / flat;
    assert.ok(Math.abs(ratio - 2) < 0.1, `${id}: an octave of bend moved the pitch by ${ratio.toFixed(2)}x (${flat.toFixed(1)} -> ${up.toFixed(1)} Hz)`);
  }
});

/** Plays one note for `holdSec` on a ported instrument, then renders on; the output after the off. */
function afterNoteOff(id, settings, { holdSec = 0.25, thenSec = 4, notes = [[48, 0]], offs = [48] } = {}) {
  const { node, descriptor } = portedDevice(id);
  const params = paramsFor(descriptor, settings);
  const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  const blockSec = BLOCK / SR;
  const holdBlocks = Math.round(holdSec / blockSec);
  const tail = [];
  for (let block = 0; block < holdBlocks + Math.round(thenSec / blockSec); block++) {
    for (const [note, at] of notes) if (block === at) node.port._send({ kind: 'noteOn', note, velocity: 1, time: 0 });
    if (block === holdBlocks) for (const note of offs) node.port._send({ kind: 'noteOff', note, time: 0 });
    node.process([], out, params);
    if (block >= holdBlocks) tail.push(...out[0][0]);
  }
  return tail;
}

test('every ported instrument goes quiet after its note ends - every Plaits engine included', () => {
  // Chiptune was the one that did not: played from notes it envelopes itself and skips the
  // low-pass gate, and with Timbre Mod at zero its envelope never decays. The last half second
  // of twelve after the note-off must be silent, whatever the model: the longest tails here are
  // a Decay near the top and the 6-op engines' own patch releases, and both end within ten.
  const cases = [
    ...PLAITS_ENGINES.map((name, engine) => ['Plaits', { engine }, name]),
    // The chiptune preset the bug was found with: long decay, arpeggiator, some of the bass.
    ['Plaits', { engine: 7, harmonics: 0.264, timbre: 0.764, morph: 0.207, blend: 0.233, decay: 0.858, lpgcolor: 0.5 }, 'Chiptune, long decay'],
    ['Braids', {}, 'default'],
    ['Rings', {}, 'default'],
    ['Elements', {}, 'default'],
  ];
  const ringing = [];
  for (const [id, settings, label] of cases) {
    const tail = afterNoteOff(id, settings, { thenSec: 12 });
    const end = peak(tail.slice(-Math.round(0.5 * SR)));
    if (end > 1e-3) ringing.push(`${id} ${label}: ${end.toFixed(4)} twelve seconds after the note ended`);
  }
  assert.deepEqual(ringing, []);
});

test('a monophonic module ignores the off of a note another note already replaced', () => {
  // Legato: 50 starts while 48 is held, then 48's off arrives. 50 is the note sounding, so it
  // plays on; the off it belongs to has not come.
  for (const [id, settings] of [['Plaits', { engine: 8, decay: 1 }], ['Elements', { bowlevel: 1, strikelevel: 0 }]]) {
    const tail = afterNoteOff(id, settings, { notes: [[48, 0], [50, 40]], offs: [48], thenSec: 1 });
    assert.ok(peak(tail.slice(-Math.round(0.25 * SR))) > 1e-2, `${id} should still be playing 50`);
  }
});

test('a ported device with a sidechain hears both of the track\'s channels', () => {
  // With a sidechain the module's second input is the other signal, so the track has to arrive
  // on the first one summed to mono. Taking only its left channel would drop anything panned
  // right. The same sine on the left alone and on the right alone should therefore be heard
  // identically. No catalog device declares a sidechain today, so one is given one here.
  const base = DEVICES.find((d) => d.id === 'Galactic');
  const render = (side) => {
    const { context } = loadBundle('poptart-wasm.js');
    const Processor = vm.runInContext('WasmDeviceProcessor', context);
    const bytes = fs.readFileSync(path.join(here, 'public', 'devices', `${base.id}.wasm`));
    const descriptor = { ...base, sidechain: true };
    const node = new Processor({ processorOptions: { module: new WebAssembly.Module(bytes) } }, descriptor);
    const params = paramsFor(base);
    const out = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    const heard = [];
    let phase = 0;
    for (let b = 0; b < 40; b++) {
      const made = stereoBlock(phase);
      phase = made.phase;
      const silent = new Float32Array(BLOCK);
      const track = side === 'left' ? [made.input[0][0], silent] : [silent, made.input[0][1]];
      node.process([track, [new Float32Array(BLOCK)]], out, params);
      heard.push(...out[0][0], ...out[0][1]);
    }
    return heard;
  };
  const left = render('left');
  const right = render('right');
  assert.ok(peak(left) > 1e-3, 'the track should be heard at all');
  for (let i = 0; i < left.length; i++) {
    assert.ok(Math.abs(left[i] - right[i]) < 1e-6, `sample ${i}: ${left[i]} from the left, ${right[i]} from the right`);
  }
});
