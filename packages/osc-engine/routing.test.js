'use strict';

// Branches on the desktop, rendered: the shipped defs of a track (synthdef/defs.js) - its head, its
// effects' nodes, the crossovers, the terms and the strip - laid out by route-desktop.js for real
// plans out of pattern-core, as routeApply lays them out, offline through scsynth with poptart's
// own devices loaded, the way slot-kind.test.js renders them.
//
// What is checked is what comes out: a clean branch plus two filtered ones adds up to the clean
// signal plus each filter alone (and each filter took its own cutoff - .param() reached the right
// branch); bands nobody touches come back flat, three of them or four; a device in a branch, or in
// a band, is struck by notes exactly when the same device in a plain line is; a crossover follows a
// modulator and a pattern; and the summing matches the browser engine's, sample for sample, with
// no block of delay on either - a .bands() at the end of a leveled branch included.
//
// Skipped (not failed) where scsynth or the device binary is not here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { renderNRT, ugen, G } = require('./test-support/nrt');
const { desktopRouting } = require('./route-desktop');
const { nativeDevice } = require('./native-devices');

const SR = 48000;
const BLOCK = 256;
const DUR = 2.0;
const SCX = path.join(__dirname, 'native', 'devices', 'bin', 'PoptartDevices.scx');
const NOWHERE = 1000000;

const core = () => import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));
const web = async () => ({
  ...(await import(path.join(__dirname, '..', 'web-engine', 'fake-context.mjs'))),
  ...(await import(path.join(__dirname, '..', 'web-engine', 'fake-render.mjs'))),
  ...(await import(path.join(__dirname, '..', 'web-engine', 'src', 'engine', 'track.mjs'))),
  ...(await import(path.join(__dirname, '..', 'web-engine', 'src', 'descriptor.mjs'))),
});

/** A device control's position, as /set takes it (the descriptor's own curve). */
function position(normalize, id, param, value) {
  const p = nativeDevice(id).params.find((q) => q.id === param);
  return normalize(p, value);
}

const paramIndex = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);

/**
 * Every scenario: a track with its own input, output pair and chain. `sig` is the chain as code
 * (or `spec` a layout written out by hand); `devices` what to open in which slot and how to set
 * it; `notes` struck into a slot; `lfo` a crossover's frequency driven by a modulator; `steps` one
 * set per cycle.
 */
async function scenarios() {
  const { note, s, sine, routePlan } = await core();
  const { normalize } = await web();
  const ducker = { id: 'Ducker', set: [[paramIndex('Ducker', 'amount'), 1]] };
  const filterAt = (hz) => ({ id: 'Filter', set: [[paramIndex('Filter', 'cutoff'), position(normalize, 'Filter', 'cutoff', hz)], [paramIndex('Filter', 'resonance'), 0]] });
  const xo3000 = (3000 - 20) / 19980;
  return [
    { name: 'dry', input: 'tones', sig: note('c2').synth('X') },
    { name: 'filters', input: 'tones', sig: note('c2').synth('X').split((x) => x, (b) => b.fx('Filter').param('Cutoff', 400), (b) => b.fx('Filter').param('Cutoff', 3000).postgain(0.5)), devices: { 1: filterAt(400), 2: filterAt(3000) } },
    { name: 'alone400', input: 'tones', sig: note('c2').synth('X').fx('Filter'), devices: { 1: filterAt(400) } },
    { name: 'alone3000', input: 'tones', sig: note('c2').synth('X').fx('Filter'), devices: { 1: filterAt(3000) } },
    { name: 'bands', input: 'tones', sig: s('x').bands([250, 2500], (l) => l, (m) => m, (h) => h) },
    { name: 'bands4', input: 'tones', sig: s('x').bands([120, 900, 6000], (a) => a, (b) => b, (c) => c, (d) => d) },
    { name: 'panned', input: 'tones', sig: note('c2').synth('X').split((x) => x.pan(-0.5).postgain(0.7), (x) => x.pan(0.75), (x) => x.split((y) => y.postgain(0.25), (y) => y.pan(1)).pan(-0.25)) },
    { name: 'held', input: 'tones', sig: note('c2').synth('X').split((x) => x.postgain(0.5), (b) => b.bands([500], (l) => l, (h) => h.postgain(0))) },
    // A .bands() at the end of a branch with its own level and pan: allowed, and laid out like any.
    { name: 'leveled', input: 'tones', sig: note('c2').synth('X').split((x) => x.postgain(0.25), (b) => b.bands([400, 3000], (l) => l, (m) => m, (h) => h).postgain(0.5).pan(-0.4)) },
    // A device struck by notes, in a branch and in a plain chain: the Ducker, which dips on each
    // note routed into it.
    { name: 'dry1k', input: 'tone', sig: note('c2').synth('X') },
    { name: 'gate', input: 'tone', sig: note('c2').synth('X').split((x) => x.postgain(0), (b) => b.fx('Ducker').midi('self')), devices: { 1: ducker }, notes: { slot: 1, at: [0.5, 1.2] } },
    { name: 'gateAlone', input: 'tone', sig: note('c2').synth('X').fx('Ducker').midi('self'), devices: { 1: ducker }, notes: { slot: 1, at: [0.5, 1.2] } },
    // ...and in a band: the low band of a 3 kHz split, ducked, is the same crossover's low output
    // ducked in a line written out by hand - sample for sample, so the notes land with the audio.
    { name: 'gateBand', input: 'tone', sig: note('c2').synth('X').bands([3000], (l) => l.fx('Ducker').midi('self'), (h) => h.postgain(0)), devices: { 1: ducker }, notes: { slot: 1, at: [0.5, 1.2] } },
    {
      name: 'gateLowpass', input: 'tone', devices: { 1: ducker }, notes: { slot: 1, at: [0.5, 1.2] }, xo: { 1: xo3000 },
      spec: {
        steps: [
          { k: 'xover', id: 'x1', xo: 1, in: 'chain', key: 'none', out: 'o:x1', rest: 'r:x1', ap: 'a:x1' },
          { k: 'fx', slot: 1, in: 'o:x1', out: 'o:1' },
        ],
        out: 'o:1',
        buses: { 'o:x1': 2, 'r:x1': 2, 'a:x1': 2, 'o:1': 2 },
        warnings: [],
      },
    },
    { name: 'swept', input: 'tone', sig: s('x').bands([sine(1).range(300, 3000)], (l) => l, (h) => h.postgain(0)), lfo: { xo: 1, hz: 1 } },
    { name: 'stepped', input: 'tone', sig: s('x').bands(['<250 4000>'], (l) => l, (h) => h.postgain(0)), steps: { xo: 1, at: [0, 1] } },
  ].map((sc) => {
    const r = sc.sig ? routePlan(sc.sig) : null;
    const spec = sc.spec ?? desktopRouting(r?.plan ?? null, { count: sc.sig?.fxChain.length ?? 0 });
    return { ...sc, plan: r?.plan ?? null, controls: r?.controls ?? {}, spec };
  });
}

const tones = [110, 330, 1000, 3300, 9000];

const SinOsc = ugen('SinOsc', [440, 0]);
const UNITY_AT = 1990;
const F = (v) => ({ type: 'f', value: v }); // a float, as sclang's 48.0 went out

/** The test's own source and modulator defs. */
function testDefs() {
  const sine = (f, amp) => G.mul(SinOsc.ar(f, 0), amp);
  const pair = (x) => [x, x];
  return [
    new G.SynthDef('rt_tones', { out: 0 }, (c) => { U.Out.ar(c.out, pair(tones.map((f) => sine(f, 0.1)).reduce((x, y) => G.add(x, y)))); }),
    new G.SynthDef('rt_tone', { out: 0 }, (c) => { U.Out.ar(c.out, pair(sine(1000, 0.3))); }),
    new G.SynthDef('rt_lfo', { out: 0, lo: 0, hi: 1, freq: 1 }, (c) => {
      // SinOsc.kr(freq).range(lo, hi)
      U.Out.kr(c.out, G.add(G.mul(G.add(G.mul(SinOsc.kr(c.freq, 0), 0.5), 0.5), G.sub(c.hi, c.lo)), c.lo));
    }),
  ];
}

/**
 * The score for every scenario: each a track as routeApply makes one - its group, the chain group
 * with the route-control publishers at its head, the head, the steps in order and the strip - fed
 * a tone through the head's input bus.
 */
async function render(list) {
  const all = synthdef.defsFor({ numOutputBusChannels: list.length * 2 });
  const def = (name) => all.find((d) => d.name === name);
  const fxIx = def('poptart_fx').meta.poptartDevices.nslot;
  const xoIx = def('poptart_xover').meta.poptartDevices.nslot;
  let audio = 512;
  let kr = 2000;
  let ids = 1000;
  const nextAudio = (ch = 2) => { const b = audio; audio += ch; return b; };
  const nextKr = (ch = 1) => { const b = kr; kr += ch; return b; };
  const msgs = [];
  list.forEach((s, t) => {
    const { spec } = s;
    assert.deepEqual(spec.warnings, [], `${s.name}: ${spec.warnings.join(' ')}`);
    const group = ids++; const chain = ids++; const krGroup = ids++; const head = ids++; const strip = ids++; const src = ids++;
    const inBus = nextAudio();
    const chainIn = nextAudio();
    const index = { chain: chainIn };
    for (const id of Object.keys(spec.buses)) index[id] = nextAudio();
    const busOf = (v) => (v === 'none' || v == null ? NOWHERE : index[v] ?? NOWHERE);
    msgs.push([0.0, ['/g_new', (group), 1, 0]]);
    msgs.push([0.0, ['/s_new', (s.input === 'tone' ? 'rt_tone' : 'rt_tones'), (src), 0, (group), 'out', (inBus)]]);
    msgs.push([0.0, ['/g_new', (chain), 1, (group)]]);
    msgs.push([0.0, ['/g_new', (krGroup), 0, (chain)]]);
    msgs.push([0.0, ['/s_new', 'poptart_head', (head), 1, (chain), 'inBus', (inBus), 'out', (chainIn), 'bendOut', (nextKr()), 'grainOut', (nextKr(4))]]);
    msgs.push([0.0, ['/s_new', 'poptart_track_shared', (strip), 1, (chain), 'in', (busOf(spec.out)), 'post', (NOWHERE), 'ctl', (nextKr(6)), 'out', (t + 1), 'pairs', (list.length)]]);
    // The route controls: a level/pan publisher per gain, a frequency per crossover.
    const gains = {};
    const gainBus = (g) => {
      if (!g) return UNITY_AT;
      if (gains[g] == null) {
        gains[g] = nextKr(2);
        const level = s.controls[`rl${g}`]?.sample(0, 1, 0) ?? 1;
        const pan = s.controls[`rp${g}`]?.sample(0, 1, 0) ?? 0;
        msgs.push([0.0, ['/s_new', 'poptart_gainkr', (ids++), 1, (krGroup), 'out', (gains[g]), 'level', (level), 'pan', (pan)]]);
      }
      return gains[g];
    };
    const xoNodes = {};
    const nodeOf = {};
    for (const st of spec.steps) {
      const id = ids++;
      if (st.k === 'fx') {
        nodeOf[st.slot] = id;
        msgs.push([0.0, ['/s_new', 'poptart_fx', (id), 2, (strip), 'in', (busOf(st.in)), 'out', (busOf(st.out)), 'scBus', (NOWHERE)]]);
      } else if (st.k === 'xover') {
        const xbus = nextKr();
        const value = s.xo?.[st.xo] ?? s.controls[`xo${st.xo}`]?.sample(0, 1, 0) ?? 0.049;
        const xo = ids++;
        xoNodes[st.xo] = { node: xo, bus: xbus };
        msgs.push([0.0, ['/s_new', 'poptart_xokr', (xo), 1, (krGroup), 'out', (xbus), 'value', (s.controls[`xo${st.xo}`]?.lfoIR ? 0 : value)]]);
        msgs.push([0.0, ['/s_new', 'poptart_xover', (id), 2, (strip), 'in', (busOf(st.in)), 'key', (busOf(st.key)), 'out', (busOf(st.out)), 'rest', (busOf(st.rest)), 'ap', (busOf(st.ap))]]);
        msgs.push([0.0, ['/u_cmd', (id), xoIx, '/open', 'Crossover']]);
        msgs.push([0.01, ['/u_cmd', (id), xoIx, '/map', 0, (xbus)]]);
      } else {
        msgs.push([0.0, ['/s_new', 'poptart_term', (id), 2, (strip), 'in', (busOf(st.in)), 'out', (busOf(st.out)), 'gain', (gainBus(st.g))]]);
      }
    }
    for (const [slot, d] of Object.entries(s.devices ?? {})) {
      const node = nodeOf[slot];
      msgs.push([0.0, ['/u_cmd', (node), fxIx, '/open', (d.id)]]);
      msgs.push([0.0, ['/n_set', (node), 'active', 1, 'native', 1]]);
      for (const [i, v] of d.set) msgs.push([0.01, ['/u_cmd', (node), fxIx, '/set', (i), (v)]]);
    }
    for (const at of s.notes?.at ?? []) {
      msgs.push([(at), ['/u_cmd', (nodeOf[s.notes.slot]), fxIx, '/noteOn', F(48), F(1)]]);
      msgs.push([(at + 0.05), ['/u_cmd', (nodeOf[s.notes.slot]), fxIx, '/noteOff', F(48)]]);
    }
    if (s.lfo) {
      // A native modulator is a control bus mapped onto the control: here the crossover's own sine,
      // its bounds already positions, mapped onto its publisher.
      const ir = s.controls[`xo${s.lfo.xo}`].lfoIR;
      const bus = nextKr();
      msgs.push([0.0, ['/s_new', 'rt_lfo', (ids++), 0, (group), 'out', (bus), 'lo', (ir.min), 'hi', (ir.max), 'freq', (s.lfo.hz)]]);
      msgs.push([0.0, ['/n_map', (xoNodes[s.lfo.xo].node), 'value', (bus)]]);
    }
    for (const at of s.steps?.at ?? []) {
      const v = s.controls[`xo${s.steps.xo}`].sample(at + 0.5, 1, at + 0.5);
      msgs.push([(at + 0.01), ['/n_set', (xoNodes[s.steps.xo].node), 'value', (v)]]);
    }
  });
  const defs = ['poptart_track_shared', 'poptart_head', 'poptart_fx', 'poptart_xover', 'poptart_term', 'poptart_gainkr', 'poptart_xokr']
    .map((n) => def(n).def).concat(testDefs());
  const score = [...defs.map((d) => [0, ['/d_recv', d]]), [0, ['/c_setn', UNITY_AT, 2, 1, 0]], ...msgs];
  return renderNRT(score, {
    duration: DUR, sampleRate: SR, outChannels: list.length * 2,
    extra: ['-a', '8192', '-c', '8192', '-z', String(BLOCK), '-w', '1024', '-m', '262144', '-n', '8192'],
  });
}

/** The same chain through the browser engine, its devices loaded, rendered by the spec's formulas. */
async function renderWeb(sig, plan, controls, input, frames) {
  const { FakeAudioContext, fakeWorkletFor, renderFake } = await web();
  const { WebAudioEngine } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'engine', 'web-audio-engine.mjs'));
  const { catalog } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'catalog.mjs'));
  const { CROSSOVER, CrossoverProcessor } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'devices', 'crossover.mjs'));
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, routeWaitMs: 1, AudioWorkletNode: fakeWorkletFor(catalog) });
  engine.createTrack('t');
  for (const { slot, name, sig: value } of Object.values(sig.paramSignals)) engine.setParam('t', slot, name, value.sample(0, 1, 0), 0);
  engine.setRouting('t', plan);
  const track = engine.tracks.get('t');
  for (const [name, c] of Object.entries(controls)) track.setChannel(name, c.sample(0, 1, 0), 0, 0);
  const devices = { [CROSSOVER.processor]: { descriptor: CROSSOVER, make: (sr) => new CrossoverProcessor(sr) } };
  return renderFake(ctx, track.postGain, { frames, inject: new Map([[track.chainIn, [input, input]]]), devices });
}

test('branches on the desktop: sums, bands, a struck gate, a moving crossover, and the browser\'s numbers', async (t) => {
  if (!fs.existsSync(SCX)) { t.skip('no PoptartDevices.scx in this checkout'); return; }
  {
    const list = await scenarios();
    const wav = await render(list);
    if (!wav.data) { t.skip(wav.why); return; }
    assert.ok(!/FAILURE IN SERVER/.test(wav.text), `the server refused something:\n${wav.text.split('\n').filter((l) => /FAILURE|ERROR/.test(l)).join('\n')}`);
    assert.equal(wav.channels, list.length * 2);
    const ch = (name, side = 0) => {
      const k = list.findIndex((s) => s.name === name) * 2 + side;
      return Float64Array.from({ length: wav.frames }, (_, i) => wav.data[i * wav.channels + k]);
    };
    // What every tones scenario was fed, as the plain track plays it.
    const source = ch('dry');
    const worst = (a, b, from, to, shift = 0) => {
      let m = 0;
      for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i - shift]));
      return m;
    };
    const rms = (x, from, to) => { let p = 0; for (let i = from; i < to; i++) p += x[i] * x[i]; return Math.sqrt(p / (to - from)); };
    const at = (sec) => Math.round(sec * SR);

    // 1. The clean signal plus two filtered branches - each filter at its own cutoff, the second at
    //    half level - is exactly the clean signal plus each filter rendered alone.
    const sum = ch('filters');
    const a = ch('alone400');
    const b = ch('alone3000');
    const want = sum.map((_, i) => source[i] + a[i] + 0.5 * b[i]);
    const off = worst(sum, want, at(0.2), at(1.9));
    assert.ok(off < 1e-4, `clean + filters is off by ${off.toExponential(2)}`);
    assert.ok(rms(a, at(0.5), at(1.5)) < rms(b, at(0.5), at(1.5)) * 0.9, 'the two branches did not take their own cutoffs');

    // 2. Bands nobody touches: the input at the all-pass's phase, no later - flat to a hundredth of
    //    a dB at every tone.
    const bands = ch('bands');
    const amp = (x, f, from, n) => {
      let c = 0; let s = 0;
      for (let i = from; i < from + n; i++) { const w = (2 * Math.PI * f * i) / SR; c += x[i] * Math.cos(w); s += x[i] * Math.sin(w); }
      return (2 * Math.hypot(c, s)) / n;
    };
    for (const f of tones) {
      const n = Math.round((Math.floor((0.8 * f)) * SR) / f);
      const level = 20 * Math.log10(amp(bands, f, at(1.0), n) / 0.1);
      assert.ok(Math.abs(level) < 0.01, `bands left ${f} Hz at ${level.toFixed(4)} dB`);
    }

    // 3. Parity with the browser's wiring of the same chains: sample for sample, with no delay on
    //    either - the bands, a band split inside a branch, and branch levels and pans merged, nested
    //    and composed. A pan off center is held to 1e-3 (-60 dB): the desktop's law is Balance2, the
    //    strip's own, which reads a 2048-step sine table without interpolating; the browser's is a
    //    curve it does interpolate. Centered, both are exact.
    for (const [name, tolerance] of [['bands', 1e-5], ['bands4', 1e-5], ['held', 1e-5], ['panned', 1e-3], ['leveled', 1e-3]]) {
      const s = list.find((x) => x.name === name);
      const [l, r] = await renderWeb(s.sig, s.plan, s.controls, source, wav.frames);
      const d = Math.max(worst(ch(name, 0), l, at(0.5), at(1.9)), worst(ch(name, 1), r, at(0.5), at(1.9)));
      assert.ok(d < tolerance, `${name}: the desktop and the browser differ by ${d.toExponential(2)}`);
    }
    assert.ok(Math.abs(rms(ch('panned', 0), at(0.5), at(1.5)) - rms(ch('panned', 1), at(0.5), at(1.5))) > 0.01, 'the pans did not place the branches');

    // 4. A device in a branch hears the notes routed into it exactly as it does in a plain chain -
    //    and they did something: after each note the ducked tone is not the tone.
    const gate = ch('gate');
    const alone = ch('gateAlone');
    const tone = ch('dry1k');
    const gateOff = worst(gate, alone, at(0.2), at(1.9));
    assert.ok(gateOff < 1e-5, `the device in the branch is not the device in the chain (off by ${gateOff.toExponential(2)})`);
    for (const note of [0.5, 1.2]) {
      const dip = rms(tone, at(note), at(note + 0.05)) - rms(alone, at(note), at(note + 0.05));
      assert.ok(dip > 0.05, `the note at ${note}s did not duck the tone (by ${dip.toFixed(4)})`);
    }
    // In a band, the same: the notes reach the device after a crossover on the sample they would
    // reach it after the same filter in a plain chain, so the dip lands where it did.
    const bandOff = worst(ch('gateBand'), ch('gateLowpass'), at(0.2), at(1.9));
    assert.ok(bandOff < 1e-5, `the device in the band is not the device after the filter (off by ${bandOff.toExponential(2)})`);
    const banded = ch('gateBand');
    assert.ok(rms(tone, at(0.5), at(0.55)) - rms(banded, at(0.5), at(0.55)) > 0.05, 'the note did not duck the band');

    // 5. A crossover follows an lfo() on it: the low band of a 1 kHz tone swells as the crossover
    //    sweeps above it and fades as it sweeps below - so the level moves with a 1 Hz sine.
    const swept = ch('swept');
    const window = (sec) => rms(swept, at(sec), at(sec + 0.05));
    const levels = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75].map(window);
    assert.ok(Math.max(...levels) > 0.15 && Math.min(...levels) < 0.05, `the swept crossover did not move the band: ${levels.map((v) => v.toFixed(3)).join(' ')}`);

    // 6. ...and a pattern on it switches it: 250 Hz for the first cycle (the 1 kHz tone is above
    //    the low band), 4 kHz for the next (inside it).
    const stepped = ch('stepped');
    assert.ok(rms(stepped, at(0.5), at(0.9)) < 0.03, 'at 250 Hz the low band should hold little of a 1 kHz tone');
    assert.ok(rms(stepped, at(1.5), at(1.9)) > 0.18, 'at 4 kHz the low band should hold the 1 kHz tone');
  }
});
