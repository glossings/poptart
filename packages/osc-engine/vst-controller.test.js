'use strict';

// VstController and VstHost (server/vst.js) - VSTPlugin's controller and class side, in Node -
// against a real scsynth and real plugins.
//
// What the engine leans on: a plugin opens into a track def's slot by key, parameters set and read
// back by index and by name, a control bus maps onto one, programs go to and from files, a program
// captured as bytes restores byte-identical (through the temp-file path and through a server
// buffer), a note sounds, the emulated transport runs at the tempo it is given, and a search of a
// folder finds what is in it. The plugins are picked from VSTPlugin's own cache: a small effect and
// a small synth, never Native Instruments (their licensing crashes headless hosts). Skipped where
// there is no scsynth, no audio device, or none of the plugins.
//
// Run alone, sandbox off.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { bootEngine, skipReason } = require('./test-support/scsynth');
const { VstHost, VstController, parseIni, cacheFilePath } = require('./server/vst');
const { Synth, Bus } = require('./server/objects');

const PORT = 57452;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (f) => new Promise((r) => f(r));

// Small, free-standing plugins, in order of preference.
const EFFECTS = ['Safety Limiter', 'Diopser', 'OTT'];
const SYNTHS = ['TAL BassLine 101', 'Vital'];

function cached() {
  try {
    return [...new Set(new VstHost({ send() {} }, { warn() {} }).readPlugins().values())];
  } catch {
    return [];
  }
}

function pick(list, names, synth) {
  for (const n of names) {
    const d = list.find((x) => x.name === n && !!x.synth === synth && !x.bridged
      && !/native instruments/i.test(x.vendor ?? '') && x.path && fs.existsSync(x.path));
    if (d) return d;
  }
  return null;
}

test('the VSTPlugin cache and a search result parse into descs', () => {
  const ini = [
    '[version]', '0.6.2', '[ignore]', 'n=1', '/x/crashed.vst3', '[plugins]', 'n=2',
    '[plugin]', 'path=/x/A.vst3', 'id=00', 'name=A', 'vendor=V', 'category=Fx', 'version=1', 'sdkversion=VST 3.7.0',
    'flags=105', '[inputs]', 'n=2', '2,0,Input', '2,1,Sidechain', '[outputs]', 'n=1', '2,0,Output',
    '[parameters]', 'n=2', 'Gain,dB,1a,1', 'Mix,%,2b,0', '[programs]', 'n=1', 'Init', '[keys]', 'n=2', 'A.vst3', '/x/A.vst3',
    '[plugin]', 'path=/x/B.vst', 'id=01', 'name=B', 'vendor=V', 'category=Synth', 'version=1', 'sdkversion=VST 2.4',
    'flags=3', '[inputs]', 'n=0', '[outputs]', 'n=1', '2,0,', '[parameters]', 'n=0', '[keys]', 'n=1', 'B', '',
  ].join('\n');
  const [a, b] = parseIni(ini);
  assert.strictEqual(a.key, 'A.vst3');
  assert.strictEqual(a.name, 'A');
  assert.strictEqual(a.findParamIndex('Mix'), 1);
  assert.strictEqual(a.findParamIndex('Nope'), null);
  assert.deepStrictEqual(a.parameters[1], { name: 'Mix', label: '%', automatable: false });
  assert.strictEqual(a.inputs[1].type, 'aux');
  assert.strictEqual(a.programs[0].name, 'Init');
  // flags 0x105: editor, singlePrecision, bridged
  assert.deepStrictEqual([a.editor, a.synth, a.singlePrecision, a.bridged], [true, false, true, true]);
  assert.ok(a.isVst3);
  assert.strictEqual(b.key, 'B');
  assert.strictEqual(b.synth, true);
  assert.strictEqual(b.outputs[0].channels, 2);
  assert.ok(!b.isVst3);
  assert.ok(cacheFilePath('/d').endsWith(`cache_${process.arch === 'arm64' ? 'aarch64' : 'amd64'}.ini`));
});

test('plugins on a real server: open, parameters, programs, state, notes, transport and search', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const list = cached();
  const effect = pick(list, EFFECTS, false);
  const synth = pick(list, SYNTHS, true);
  if (!effect) { t.skip('none of the test effects is installed'); return; }
  let rig;
  try {
    rig = await bootEngine({ port: PORT, sections: [] });
  } catch (err) {
    t.skip(`no real-time server here: ${err.message}`);
    return;
  }
  const { S, E } = rig;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-vst-'));
  const said = [];
  const host = new VstHost(S, { post: (x) => said.push(x), warn: (x) => said.push(`WARNING: ${x}`) });
  const fxIndex = rig.defs.meta.poptart_fx.vstplugins.slot;
  const headIndex = rig.defs.meta.poptart_head.vstplugins.slot0;
  try {
    const inBus = Bus.audio(S, 2);
    const fxNode = Synth.new(S, 'poptart_fx', ['in', inBus.index, 'out', E.routeNowhere, 'scBus', E.silentBus.index], null, 'addToTail');
    await S.sync();
    const ctl = new VstController(S, fxNode, fxIndex, host);

    await t.test('opens by key into a track def slot', async () => {
      const ok = await ask((r) => ctl.open(effect.key, { editor: true, action: (self, v) => r(v) }));
      assert.strictEqual(ok, true, `${effect.name} did not open: ${said.join(' | ')}`);
      assert.ok(ctl.isOpen);
      assert.strictEqual(ctl.info.name, effect.name);
      assert.strictEqual(ctl.info.numParameters, effect.numParameters);
      assert.ok(ctl.latency != null, 'the open reports a latency');
      // The host knows it under its key and under what it was asked by.
      assert.strictEqual(host.plugins().get(effect.key), ctl.info);
      // A second open while one is in flight is refused, as the class refuses it.
      const busy = new VstController(S, Synth.new(S, 'poptart_fx', ['in', inBus.index, 'out', E.routeNowhere], null, 'addToTail'), fxIndex, host);
      const first = ask((r) => busy.open(effect.key, { action: (self, v) => r(v) }));
      const second = await ask((r) => busy.open(effect.key, { action: (self, v) => r(v) }));
      assert.strictEqual(second, false);
      assert.strictEqual(await first, true);
    });

    await t.test('sets and reads parameters by index and by name, and maps a bus', async () => {
      const name = ctl.info.parameters[0].name;
      ctl.set(0, 0.25);
      assert.ok(Math.abs(await ask((r) => ctl.get(0, r)) - 0.25) < 1e-6);
      ctl.set(name, 0.75);
      assert.ok(Math.abs(await ask((r) => ctl.get(name, r)) - 0.75) < 1e-6);
      ctl.setn(0, [0.5]);
      const values = await ask((r) => ctl.getn(0, 1, r));
      assert.ok(Math.abs(values[0] - 0.5) < 1e-6);
      assert.throws(() => ctl.get('no such parameter', () => {}), /unknown parameter/);
      const bus = Bus.control(S, 1);
      bus.set(0.4);
      await S.sync();
      ctl.map(0, bus);
      await sleep(100);
      assert.ok(Math.abs(await ask((r) => ctl.get(0, r)) - 0.4) < 1e-6, 'a mapped parameter follows its bus');
      bus.set(0.6);
      await sleep(100);
      assert.ok(Math.abs(await ask((r) => ctl.get(0, r)) - 0.6) < 1e-6);
      ctl.unmap(0);
      ctl.set(0, 0.3);
      assert.ok(Math.abs(await ask((r) => ctl.get(0, r)) - 0.3) < 1e-6, 'an unmapped parameter takes a set again');
      // A plain index maps as a one-channel control bus; an audio bus goes to /mapa.
      assert.deepStrictEqual(ctl.mapMsg(0, 7).map((m) => m[3]), ['/map']);
      assert.deepStrictEqual(ctl.mapMsg(0, Bus.audio(S, 2)).map((m) => m[3]), ['/mapa']);
    });

    await t.test('programs go to and from files, and state round-trips byte-identical', async () => {
      ctl.set(0, 0.2);
      const file = path.join(dir, `p${ctl.info.isVst3 ? '.vstpreset' : '.fxp'}`);
      assert.strictEqual(await ask((r) => ctl.writeProgram(file, (self, ok) => r(ok))), true);
      assert.ok(fs.statSync(file).size > 0);
      ctl.set(0, 0.9);
      assert.strictEqual(await ask((r) => ctl.readProgram(file, (self, ok) => r(ok))), true);
      assert.ok(Math.abs(await ask((r) => ctl.get(0, r)) - 0.2) < 1e-6, 'the program file put the value back');

      const data = await ask((r) => ctl.getProgramData(r));
      assert.ok(Buffer.isBuffer(data) && data.length > 0);
      ctl.set(0, 0.95);
      assert.strictEqual(await ask((r) => ctl.setProgramData(data, (self, ok) => r(ok))), true);
      const again = await ask((r) => ctl.getProgramData(r));
      assert.strictEqual(Buffer.compare(data, again), 0, 'the program did not round-trip byte-identical');
      // The temp files are gone.
      assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith(`vst_${process.pid}_`)));

      // Through a server buffer (the class's path for a server on another machine).
      const viaBuf = await ask((r) => ctl.receiveProgramData(null, 3, r));
      assert.strictEqual(Buffer.compare(data, viaBuf), 0, 'the buffer transfer changed the program');
      ctl.set(0, 0.95);
      assert.strictEqual(await ask((r) => ctl.sendProgramData(viaBuf, null, (self, ok) => r(ok))), true);
      assert.strictEqual(Buffer.compare(data, await ask((r) => ctl.getProgramData(r))), 0);
    });

    await t.test('the emulated transport runs at the tempo it is given', async () => {
      ctl.setTempo(120);
      ctl.setPlaying(true);
      ctl.setTransportPos(16);
      await sleep(50);
      const a = await ask((r) => ctl.getTransportPos(r));
      await sleep(500);
      const b = await ask((r) => ctl.getTransportPos(r));
      assert.ok(a >= 16 && a < 16.5, `transport at ${a}, set to 16`);
      // 120 bpm is two beats a second.
      assert.ok(Math.abs((b - a) - 1) < 0.3, `transport moved ${b - a} beats in half a second at 120 bpm`);
      ctl.setPlaying(false);
    });

    if (synth) {
      await t.test('a note on a synth sounds, and its larger state restores the same every time', async () => {
        const out = Bus.audio(S, 2);
        const headNode = Synth.new(S, 'poptart_head', ['inBus', E.silentBus.index, 'out', out.index,
          'bendOut', Bus.control(S, 1).index, 'grainOut', Bus.control(S, 4).index], null, 'addToTail');
        const levels = [];
        const off = S.on('/poptart/recLevel', (a) => levels.push(Math.max(Number(a[2]), Number(a[4]))));
        Synth.new(S, 'poptart_rec_meter', ['bus', out.index], null, 'addToTail');
        await S.sync();
        const inst = new VstController(S, headNode, headIndex, host);
        const ok = await ask((r) => inst.open(synth.key, { editor: true, action: (self, v) => r(v) }));
        assert.strictEqual(ok, true, `${synth.name} did not open: ${said.join(' | ')}`);
        inst.setPlaying(true);
        inst.setTempo(120);
        await sleep(300);
        levels.length = 0;
        inst.midi.noteOn(0, 48, 110);
        await sleep(500);
        inst.midi.noteOff(0, 48, 0);
        inst.midi.allNotesOff(0);
        off();
        assert.ok(Math.max(0, ...levels) > 1e-3, `${synth.name} played nothing for a note (peak ${Math.max(0, ...levels)})`);

        // Some synths re-serialize a loaded program a little differently from a fresh one (TAL's
        // chunk header does), so the check is that one program, restored twice, comes back as the
        // same bytes both times: what reaches the plugin is the same both times.
        const data = await ask((r) => inst.getProgramData(r));
        assert.ok(data && data.length > 0);
        const restored = [];
        for (let i = 0; i < 2; i++) {
          inst.set(0, 0.123 * (i + 1));
          assert.strictEqual(await ask((r) => inst.setProgramData(data, (self, v) => r(v))), true);
          restored.push(await ask((r) => inst.getProgramData(r)));
        }
        assert.strictEqual(Buffer.compare(restored[0], restored[1]), 0, `${synth.name}'s ${data.length}-byte program did not restore the same twice`);
        inst.close();
        assert.ok(!inst.isOpen);
      });
    }

    await t.test('a search of a folder finds the plugin in it', async () => {
      const folder = path.join(dir, 'plugins');
      fs.mkdirSync(folder);
      fs.symlinkSync(effect.path, path.join(folder, path.basename(effect.path)));
      const fresh = new VstHost(S, { post: (x) => said.push(x), warn: (x) => said.push(`WARNING: ${x}`) });
      let called = 0;
      await fresh.search({ dir: folder, options: { timeout: 20, save: false, parallel: false }, verbose: true, action: () => { called += 1; } });
      assert.strictEqual(called, 1);
      const found = fresh.pluginList();
      assert.strictEqual(found.length, 1, `found ${found.map((d) => d.name)}`);
      assert.strictEqual(found[0].name, effect.name);
      assert.strictEqual(found[0].numParameters, effect.numParameters);
      assert.ok(fresh.pluginCount() >= 1);
      // An open through a fresh controller resolves it from the search result, no second probe.
      const c = new VstController(S, Synth.new(S, 'poptart_fx', ['in', inBus.index, 'out', E.routeNowhere], null, 'addToTail'), fxIndex, fresh);
      assert.strictEqual(await ask((r) => c.open(found[0].key, { action: (self, v) => r(v) })), true);
      assert.strictEqual(c.info, found[0]);
    });

    await t.test('a freed synth leaves its controller empty', async () => {
      fxNode.free();
      await S.sync();
      await sleep(50);
      assert.strictEqual(ctl.synth, null);
      assert.ok(!ctl.isOpen);
    });
  } finally {
    await rig.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
