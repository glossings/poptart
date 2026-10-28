'use strict';

// Plugin state through the Node engine's handlers (engine/state.js), as OscEngine drives them:
// '/poptart/getPluginState' writes the slot's program to a file and answers with its path,
// '/poptart/setPluginState' loads a program file into the slot and says so with
// '/poptart/stateLanded'. A capture, a restore of that capture and a second capture must give
// the same bytes - a program that drifts on a round trip is a preset that changes every eval.
// Also: a cancelled scheduled restore never lands and its file goes, getParams lists the
// plugin's parameters, and one of poptart's own devices round-trips its program too.
//
// Needs scsynth and a small plugin in the scan cache (never Native Instruments); skipped without.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootEngine, skipReason, toldWhen } = require('./test-support/scsynth');
const { nativeDevice, deviceParamArgs } = require('./native-devices');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'state', 'scan'];
const EFFECTS = ['Safety Limiter', 'Diopser', 'OTT'];
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

function pickPlugin(list, names) {
  for (const n of names) {
    const d = list.find((x) => x.name === n && !x.synth && !x.bridged
      && !/native instruments/i.test(x.vendor ?? '') && x.path && fs.existsSync(x.path));
    if (d) return d;
  }
  return null;
}

let requestId = 1;
/** Dispatches a request and resolves with its reply's payload (read from the reply file). */
async function ask(E, told, address, args) {
  const id = requestId++;
  E.dispatch(address, [id, ...args]);
  const m = await Promise.race([
    toldWhen(told, `${address}.reply`, (a) => a[0] === id, 20000),
    toldWhen(told, `${address}.error.reply`, (a) => a[0] === id, 20000).then((e) => { throw new Error(String(e.args[1])); }),
  ]);
  const json = fs.readFileSync(m.args[1], 'utf8');
  fs.unlinkSync(m.args[1]);
  return JSON.parse(json);
}

async function trackOf(E, key) {
  for (let i = 0; i < 100; i++) {
    const t = E.tracks.get(key);
    if (E.isTrack(t)) return t;
    await wait(0.02);
  }
  throw new Error(`track ${key} never built`);
}

async function capture(E, told, key, slot) {
  const { path: p } = await ask(E, told, '/poptart/getPluginState', [key, slot]);
  const bytes = fs.readFileSync(p);
  fs.unlinkSync(p);
  return bytes;
}

let landedSeq = 100;
async function restore(E, told, key, slot, bytes) {
  const seq = landedSeq++;
  const p = path.join(os.tmpdir(), `poptart-state-test-${process.pid}-${seq}.fxp`);
  fs.writeFileSync(p, bytes);
  E.dispatch('/poptart/setPluginState', [key, slot, p, 0, seq]);
  const m = await toldWhen(told, '/poptart/stateLanded', (a) => a[0] === key && a[1] === slot && a[2] === seq, 20000);
  assert.strictEqual(m.args[3], 1, 'the restore did not land');
  assert.ok(!fs.existsSync(p), 'the restore left its program file behind');
}

test('a plugin program captured, restored and captured again comes back byte for byte', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { VstHost } = require('./server/vst');
  const cache = [...new Set(new VstHost({ send() {} }, { warn() {} }).readPlugins().values())];
  const effect = pickPlugin(cache, EFFECTS);
  if (!effect) { t.skip('no small effect in the scan cache'); return; }
  const env = await bootEngine({ port: 57402, sections: SECTIONS });
  const { S, E, told, quit } = env;
  try {
    E.vst = new VstHost(S, { post: (x) => E.post(x), warn: (x) => E.warn(x) });
    E.vst.dict = E.vst.readPlugins();
    E.dispatch('/poptart/createTrack', ['st', 'dry', 0]);
    await trackOf(E, 'st');
    E.dispatch('/poptart/loadEffect', ['st', effect.name, 1]);
    await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'st' && a[1] === 1 && a[3] === 1, 30000);

    // The plugin list, from the cache before any in-session search.
    const known = await ask(E, told, '/poptart/getKnownPlugins', []);
    assert.ok(known.some((p) => p.name === effect.name), 'getKnownPlugins does not list the plugin');
    const params = await ask(E, told, '/poptart/getParams', ['st', 1]);
    assert.ok(params.length > 0 && params.every((p, i) => p.index === i && typeof p.name === 'string'));

    // Move a parameter first, so the program is not just the plugin's init state.
    E.tracks.get('st').controllers.get(1).set(0, 0.37);
    await S.sync();
    const a = await capture(E, told, 'st', 1);
    assert.ok(a.length > 0, 'an empty capture');
    E.tracks.get('st').controllers.get(1).set(0, 0.9);
    await S.sync();
    await restore(E, told, 'st', 1, a);
    const v = await new Promise((r) => E.tracks.get('st').controllers.get(1).get(0, r));
    assert.ok(Math.abs(v - 0.37) < 0.01, `the restore did not bring the parameter back (${v})`);
    const b = await capture(E, told, 'st', 1);
    assert.ok(a.equals(b), `the program came back different (${a.length} bytes, then ${b.length})`);

    // A scheduled restore that is cancelled before its onset never lands, and its file goes.
    const p = path.join(os.tmpdir(), `poptart-state-test-${process.pid}-cancel.fxp`);
    fs.writeFileSync(p, a);
    E.dispatch('/poptart/setPluginState', ['st', 1, p, 0.4, 500]);
    E.dispatch('/poptart/cancelPluginState', ['st', 1, 501]);
    await wait(0.8);
    assert.ok(!told.some((m) => m.address === '/poptart/stateLanded' && m.args[2] === 500), 'a cancelled restore landed');
    assert.ok(!fs.existsSync(p), 'a cancelled restore left its file behind');

    // A slot with nothing in it answers an error, not a hang.
    await assert.rejects(ask(E, told, '/poptart/getPluginState', ['st', 5]), /no plugin loaded in that slot/);
  } finally {
    await quit();
  }
});

test("one of poptart's own devices round-trips its program through the same handlers", async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const env = await bootEngine({ port: 57403, sections: SECTIONS });
  const { E, told, quit } = env;
  try {
    if (!E.hasNativeDevices) { t.skip("poptart's own devices are not installed"); return; }
    const filter = nativeDevice('Filter');
    E.dispatch('/poptart/createTrack', ['dv', 'dry', 0]);
    await trackOf(E, 'dv');
    E.dispatch('/poptart/loadDevice', ['dv', 1, filter.id, ...deviceParamArgs(filter)]);
    await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'dv' && a[1] === 1 && a[3] === 1);
    const ctl = E.tracks.get('dv').controllers.get(1);
    ctl.set(0, 0.25);
    const a = await capture(E, told, 'dv', 1);
    ctl.set(0, 0.75);
    await restore(E, told, 'dv', 1, a);
    const b = await capture(E, told, 'dv', 1);
    assert.ok(a.equals(b), `the device program came back different:\n${a}\n${b}`);
  } finally {
    await quit();
  }
});
