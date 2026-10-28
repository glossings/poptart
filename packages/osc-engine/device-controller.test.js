'use strict';

// DeviceController (server/device.js) - the handle the engine drives one of poptart's own devices
// through, against a real scsynth with poptart's SynthDefs.
//
// It has VstController's method names on purpose, which is what lets the param, ramp, modulator,
// MIDI and note paths treat devices and plugins as one kind of thing. Checked here:
//  - the surface those paths use: a control resolves by id and by display name in any case, a set,
//    a map and a note leave as the right unit commands (MIDI velocity as the 0..1 a device reads),
//    a program round-trips into another controller, and an open nothing answers answers itself;
//  - the live report: where each control is as the DEVICE last read it (a bus mapped onto one is
//    only known to the UGen), a granulator's grains and Distort's meters;
//  - a preset captured by the engine's Node half and restored through readProgram sounds sample for
//    sample like the device it was taken from, and not like the device at its defaults.
//
// Needs scsynth and an audio device; skipped where there is none. Nothing sounds: every device
// writes to a private bus. Run alone, sandbox off.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { bootEngine, skipReason } = require('./test-support/scsynth');
const { DeviceController } = require('./server/device');
const { Synth, Bus, Buffer: ScBuffer } = require('./server/objects');
const { writeWav, readWavRaw } = require('./wav.js');
const { nativeDevice, paramPosition, deviceParam } = require('./native-devices');

const PORT = 57451;
const SR = 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (f) => new Promise((r) => f(r));

/** A device's controls as the controller is opened with them: id, name and resting position. */
const paramsOf = (id) => {
  const d = nativeDevice(id);
  return d.params.map((p) => ({ id: p.id, name: p.name, default: paramPosition(d, p.id, p.default) }));
};
const indexOf = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);
const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

function head(t) {
  const { S, E } = t;
  return Synth.new(S, 'poptart_head', ['inBus', E.silentBus.index, 'out', E.routeNowhere,
    'bendOut', Bus.control(S, 1).index, 'grainOut', Bus.control(S, 4).index], null, 'addToTail');
}

function fx(t, inBus, outBus) {
  const { S, E } = t;
  return Synth.new(S, 'poptart_fx', ['in', inBus, 'out', outBus, 'scBus', E.silentBus.index, 'active', 1, 'native', 1],
    null, 'addToTail');
}

/** A looping sample voice of `file` onto `bus`, at the head of the default group. */
async function source(t, file, bus, channels) {
  const buf = ScBuffer.read(t.S, file);
  await buf.ready;
  Synth.new(t.S, `poptart_sample_loop_${channels}`, ['out', bus, 'buf', buf.bufnum, 'dur', 1, 'gate', 1], null, 'addToHead');
  return buf;
}

test('devices on a real server: the controller surface, the live report and a preset round trip', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  let rig;
  try {
    rig = await bootEngine({ port: PORT, sections: [] });
  } catch (err) {
    t.skip(`no real-time server here: ${err.message}`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-devctl-'));
  const { S } = rig;
  const headIndex = rig.defs.meta.poptart_head.poptartDevices.nslot0;
  const fxIndex = rig.defs.meta.poptart_fx.poptartDevices.nslot;
  try {
    await t.test('the controller resolves controls, sends unit commands and round-trips a program', async () => {
      const sent = [];
      const send = S.send.bind(S);
      S.send = (m) => {
        if (m[0] === '/u_cmd') sent.push(m.map(plain));
        send(m);
      };
      try {
        const synth = head(rig);
        await S.sync();
        const ctl = new DeviceController(S, synth, headIndex);
        const params = paramsOf('Plaits');
        const opened = ask((r) => ctl.open('Plaits', params, (self, ok) => r(ok)));
        // A control nobody has set is at its default, where the UGen opened it - not at 0.
        assert.strictEqual(await ask((r) => ctl.get(1, r)), params[1].default);
        assert.strictEqual(await opened, true, 'Plaits did not open');

        // Either spelling, any case - the rule the browser follows too.
        const lpg = indexOf('Plaits', 'lpgcolor');
        assert.ok(lpg > 0);
        assert.strictEqual(ctl.info.findParamIndex('lpgcolor'), lpg);
        assert.strictEqual(ctl.info.findParamIndex(nativeDevice('Plaits').params[lpg].name), lpg);
        assert.strictEqual(ctl.info.findParamIndex(nativeDevice('Plaits').params[lpg].name.toUpperCase()), lpg);
        assert.strictEqual(ctl.info.findParamIndex('nope'), null);
        assert.strictEqual(ctl.info.numParameters, params.length);
        // What hush asks before an all-notes-off: a device is not a VST 3, and says so.
        assert.ok(!String(ctl.info.sdkVersion ?? '').includes('VST 3'));

        ctl.set(0, 0.25, 1, 0.75);
        ctl.map(1, 42);
        ctl.unmap(1);
        ctl.midi.noteOn(0, 60, 127);
        ctl.midi.noteOn(0, 48, 64);
        ctl.midi.noteOff(0, 60, 0);
        ctl.midi.allNotesOff(0);
        const at = [synth.nodeID, headIndex];
        const has = (cmd, ...args) => sent.some((m) => m[1] === at[0] && m[2] === at[1] && m[3] === cmd
          && args.every((a, i) => (typeof a === 'number' ? Math.abs(m[4 + i] - a) < 1e-6 : m[4 + i] === a))
          && m.length === 4 + args.length);
        assert.ok(has('/open', 'Plaits'), `no open in ${JSON.stringify(sent)}`);
        assert.ok(has('/set', 0, 0.25, 1, 0.75), `no set in ${JSON.stringify(sent)}`);
        assert.ok(has('/map', 1, 42), `no map in ${JSON.stringify(sent)}`);
        assert.ok(has('/unmap', 1), `no unmap in ${JSON.stringify(sent)}`);
        // MIDI's 0..127 arrives as 0..1 and the channel is dropped: a device is one instrument.
        assert.ok(has('/noteOn', 60, 1), `no full-velocity note in ${JSON.stringify(sent)}`);
        assert.ok(has('/noteOn', 48, 64 / 127), `no half-velocity note in ${JSON.stringify(sent)}`);
        assert.ok(has('/noteOff', 60), `no note off in ${JSON.stringify(sent)}`);
        assert.ok(has('/allNotesOff'), `no all-notes-off in ${JSON.stringify(sent)}`);
        // A set is answered from the controller, the authority on these controls.
        assert.strictEqual(await ask((r) => ctl.get(1, r)), 0.75);

        // The program round trip, by name, into a different controller.
        const program = path.join(dir, 'program.json');
        assert.strictEqual(await ask((r) => ctl.writeProgram(program, (self, ok) => r(ok))), true);
        const other = new DeviceController(S, head(rig), headIndex);
        assert.strictEqual(await ask((r) => other.open('Plaits', params, (self, ok) => r(ok))), true);
        assert.strictEqual(await ask((r) => other.readProgram(program, (self, ok) => r(ok))), true);
        assert.strictEqual(await ask((r) => other.get(1, r)), 0.75);

        // The answer the server never sends: an open on a node that is not there answers itself, once, no.
        const saved = DeviceController.openTimeout;
        DeviceController.openTimeout = 0.5;
        try {
          const ghost = new DeviceController(S, Synth.basicNew('poptart_head', S, 999999), headIndex);
          let calls = 0;
          const ok = await ask((r) => ghost.open('Plaits', params, (self, v) => { calls += 1; r(v); }));
          await sleep(200);
          assert.strictEqual(ok, false);
          assert.strictEqual(calls, 1);
        } finally {
          DeviceController.openTimeout = saved;
        }
      } finally {
        S.send = send;
      }
    });

    await t.test('a device says where its controls really are, and what it is doing', async () => {
      const sine = path.join(dir, 'sine.wav');
      const data = new Float32Array(SR);
      for (let i = 0; i < SR; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
      writeWav(sine, { sampleRate: SR, channels: 1, data });
      const src = Bus.audio(S, 2);
      const buf = await source(rig, sine, src.index, 1);
      const filter = new DeviceController(S, fx(rig, src.index, Bus.audio(S, 2).index), fxIndex);
      const distort = new DeviceController(S, fx(rig, src.index, Bus.audio(S, 2).index), fxIndex);
      const grains = new DeviceController(S, head(rig), headIndex);
      const empty = new DeviceController(S, head(rig), headIndex);
      await S.sync();
      const opened = await Promise.all([
        ask((r) => filter.open('Filter', paramsOf('Filter'), (c, ok) => r(ok))),
        ask((r) => distort.open('Distort', paramsOf('Distort'), (c, ok) => r(ok))),
        ask((r) => grains.open('Granular', paramsOf('Granular'), (c, ok) => r(ok))),
      ]);
      assert.deepStrictEqual(opened, [true, true, true]);

      // One control set outright, one under a control bus - which only the UGen can say the value of.
      filter.set(indexOf('Filter', 'cutoff'), 0.3);
      const bus = Bus.control(S, 1);
      bus.set(0.77);
      await S.sync();
      filter.map(indexOf('Filter', 'resonance'), bus);
      await sleep(200);
      const [positions, report] = await ask((r) => filter.report((p, rep) => r([p, rep])));
      assert.ok(Math.abs(positions[indexOf('Filter', 'cutoff')] - 0.3) < 1e-4);
      assert.ok(Math.abs(positions[indexOf('Filter', 'resonance')] - 0.77) < 1e-4, 'a control under a bus reads where the bus is');
      assert.strictEqual(positions.length, nativeDevice('Filter').params.length);
      assert.strictEqual(report.length, 0, 'the Filter reports nothing of its own');
      bus.set(0.12);
      await sleep(200);
      const [moved] = await ask((r) => filter.report((p, rep) => r([p, rep])));
      assert.ok(Math.abs(moved[indexOf('Filter', 'resonance')] - 0.12) < 1e-4, 'the answer follows the bus');

      const slot = deviceParam(nativeDevice('Granular'), 'sample').options.length;
      grains.loadSample(indexOf('Granular', 'sample'), slot, buf);
      grains.set(indexOf('Granular', 'sample'), paramPosition(nativeDevice('Granular'), 'sample', slot));
      await sleep(200);
      grains.midi.noteOn(0, 60, 127);
      await sleep(400);
      const [, g] = await ask((r) => grains.report((p, rep) => r([p, rep])));
      assert.ok(g && g.length >= 4 && g.length % 4 === 0, `the granulator reported no grains: ${g}`);
      for (let i = 0; i < g.length; i += 4) {
        const [from, life, pan] = g.slice(i, i + 4);
        assert.ok(from >= 0 && from <= 1 && life >= 0 && life <= 1 && pan >= -1 && pan <= 1, `grain ${i / 4}: ${g.slice(i, i + 4)}`);
      }
      const [, d] = await ask((r) => distort.report((p, rep) => r([p, rep])));
      assert.ok(d && d.length === 2, `Distort's meters did not come back: ${d}`);
      assert.ok(d[1] > 0.1, `Distort reported no input level: ${d}`);
      const [none] = await ask((r) => empty.report((p, rep) => r([p, rep])));
      assert.deepStrictEqual(none, [], 'an empty slot answers with no controls');
      // A node that is gone answers nothing, and the report says so.
      const gone = new DeviceController(S, Synth.basicNew('poptart_head', S, 999998), headIndex);
      assert.deepStrictEqual(await ask((r) => gone.report((p, rep) => r([p, rep]), 0.3)), [null, null]);
    });

    await t.test('a device preset captured and restored sounds like the device it was taken from', async () => {
      const program = await presetProgram();
      try {
        // Two saws, a stereo source the Filter has something to do with.
        const saw = path.join(dir, 'saw.wav');
        const frames = SR;
        const data = new Float32Array(frames * 2);
        for (let i = 0; i < frames; i++) {
          data[i * 2] = (((110 * i) / SR) % 1) * 0.4 - 0.2;
          data[i * 2 + 1] = (((165 * i) / SR) % 1) * 0.4 - 0.2;
        }
        writeWav(saw, { sampleRate: SR, channels: 2, data });
        const src = Bus.audio(S, 2);
        await source(rig, saw, src.index, 2);
        const outs = [Bus.audio(S, 2), Bus.audio(S, 2), Bus.audio(S, 2)];
        const ctls = outs.map((o) => new DeviceController(S, fx(rig, src.index, o.index), fxIndex));
        await S.sync();
        const params = paramsOf('Filter');
        await Promise.all(ctls.map((c) => ask((r) => c.open('Filter', params, (self, ok) => r(ok)))));
        // The source: every control where the Node half recorded it, as the pattern set it.
        ctls[0].set(...nativeDevice('Filter').params.flatMap((p, i) => [i, program.positions[p.id]]));
        // The restore: the program the Node half wrote, read into a fresh device.
        assert.strictEqual(await ask((r) => ctls[1].readProgram(program.programFile, (self, ok) => r(ok))), true);
        // ctls[2] stays at its defaults.
        await sleep(300);

        const files = outs.map((o, i) => path.join(dir, `out${i}.wav`));
        const bufs = files.map(() => ScBuffer.alloc(S, 65536, 2));
        await Promise.all(bufs.map((b) => b.ready));
        bufs.forEach((b, i) => b.write(files[i], 'wav', 'float', 0, 0, true));
        await S.sync();
        let recs;
        S.makeBundle(null, () => {
          recs = outs.map((o, i) => Synth.new(S, 'poptart_rec_disk', ['bus', o.index, 'buf', bufs[i].bufnum], null, 'addToTail'));
        });
        await sleep(400);
        S.makeBundle(null, () => recs.forEach((r) => r.free()));
        await S.sync();
        bufs.forEach((b) => b.close());
        await S.sync();
        bufs.forEach((b) => b.free());
        await S.sync();

        const wavs = files.map((f) => readWavRaw(f));
        const n = Math.min(...wavs.map((w) => w.data.length / w.channels));
        assert.ok(n > SR * 0.2, `the recordings are short: ${n} frames`);
        let same = 0;
        let fromDefaults = 0;
        let energy = 0;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            const a = wavs[0].data[i * 2 + c];
            same = Math.max(same, Math.abs(a - wavs[1].data[i * 2 + c]));
            fromDefaults = Math.max(fromDefaults, Math.abs(a - wavs[2].data[i * 2 + c]));
            energy += a * a;
          }
        }
        assert.ok(energy > 1e-3, 'the Filter passed nothing');
        assert.ok(same < 1e-6, `the restored preset sounds different from the device it was taken from (by ${same.toExponential(2)})`);
        assert.ok(fromDefaults > 1e-2, 'the preset sounded like the defaults: nothing was captured or nothing restored');
      } finally {
        fs.rmSync(program.programFile, { force: true });
      }
    });
  } finally {
    await rig.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The engine's Node half, its sends captured rather than sent. */
function nodeEngine() {
  const { OscEngine } = require('./index.js');
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  e._warnOnce = () => {};
  return { e, sent };
}

/** A Filter set somewhere audible, captured as a preset, and the program its restore writes. */
async function presetProgram() {
  const source = nodeEngine();
  source.e.loadEffect('t', 'Filter', 1);
  source.e.setParam('t', 1, 'mode', 'bandpass');
  source.e.setParam('t', 1, 'cutoff', paramPosition(nativeDevice('Filter'), 'cutoff', 700));
  source.e.setParam('t', 1, 'resonance', 0.65);
  source.e.setParam('t', 1, 'drive', paramPosition(nativeDevice('Filter'), 'drive', 2));
  const preset = await source.e.getPluginState('t', 1);
  const positions = source.e.deviceSlot('t', 1).positions;
  const target = nodeEngine();
  target.e.loadEffect('t', 'Filter', 1);
  target.e.setPluginState('t', 1, preset);
  await target.e._stateIdle();
  const restore = target.sent.find((m) => m.addr === '/poptart/setPluginState');
  assert.ok(restore, 'the restore never wrote a program');
  return { programFile: restore.args[2], positions };
}
