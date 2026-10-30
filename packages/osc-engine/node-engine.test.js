'use strict';

process.env.POPTART_SILENT = '1'; // tests never play through the speakers

// The node engine end to end, through OscEngine itself (POPTART_ENGINE=node): boot with no sclang
// process, a track with one of poptart's own synths, its params read back, a note that sounds,
// the plugin list, and a clean stop that leaves no scsynth behind.
//
// Real scsynth on ports 57440-57443, sandbox off; skipped where there is none. The home folder is
// a temp one, and the plugin scan walks an empty folder, so nothing outside the test is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { skipReason } = require('./test-support/scsynth');
const { privateScRoot } = require('./private-sc');

const NODE_PORT = 57440;
const SCSYNTH_PORT = 57441;
const OSC_IN_PORT = 57442;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sclang processes THIS test started: descendants of this process only. Other suites running
// at the same time start sclang of their own, and counting those failed the test for nothing.
function sclangRunning(pidsBefore) {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    const parent = new Map();
    const sclang = [];
    for (const line of out.split('\n')) {
      const [pid, ppid, ...comm] = line.trim().split(/\s+/);
      if (!pid) continue;
      parent.set(Number(pid), Number(ppid));
      if (/sclang/.test(comm.join(' '))) sclang.push(Number(pid));
    }
    const mine = (pid) => {
      for (let p = parent.get(pid), n = 0; p > 1 && n < 64; p = parent.get(p), n++) if (p === process.pid) return true;
      return false;
    };
    return sclang.filter((pid) => mine(pid) && !pidsBefore.has(pid));
  } catch {
    return [];
  }
}

test('POPTART_ENGINE=node runs a track with no sclang process', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-node-engine-'));
  const plugins = path.join(home, 'no-plugins');
  fs.mkdirSync(plugins);
  const env = {
    POPTART_SC_ROOT: privateScRoot(), POPTART_HOME: home, POPTART_VST_DIRS: plugins,
    POPTART_SCSYNTH_PORT: String(SCSYNTH_PORT),
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const before = new Set(sclangRunning(new Set()));
  const { OscEngine } = require('./index');
  const e = new OscEngine({ engine: 'node', nodePort: NODE_PORT, oscInPort: OSC_IN_PORT });
  const states = [];
  e.onScanState = (s) => states.push(s.phase ?? s.scanning);
  try {
    await e.start(48000, 256);
    assert.equal(e.engineMode, 'node');
    assert.deepEqual(sclangRunning(before), [], 'no sclang was started');
    assert.ok(e._scsynthPid > 1, 'scsynth was booted by this process');

    e.createTrack('lead');
    e.loadInstrument('lead', 'Plaits');
    // The open is asynchronous: ask until the device answers.
    let params = null;
    for (let i = 0; i < 50 && !params; i++) {
      params = await e.getParams('lead', 0).catch(() => null);
      if (!params) await sleep(100);
    }
    assert.ok(params, 'the device opened');
    assert.ok(Array.isArray(params) ? params.length : Object.keys(params).length, 'the device answers with its params');

    // A note on the device: the engine's tap meter hears it.
    const levels = [];
    e.onRecLevel = (track, peak) => levels.push(peak);
    e.tapTrack('lead', true);
    const at = e.getTime() + 0.2;
    e.noteOn('lead', 60, 0.9, at);
    e.noteOff('lead', 60, at + 0.6);
    await sleep(1200);
    e.tapTrack('lead', false);
    assert.ok(levels.length > 0, 'the tap meter reported');
    assert.ok(Math.max(...levels) > 0.01, `the note sounded (peak ${Math.max(0, ...levels)})`);

    const known = await e.getKnownPlugins();
    assert.ok(Array.isArray(known), 'the plugin list answers');
  } finally {
    const pid = e._scsynthPid;
    await e.stop();
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    if (pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, 'scsynth is gone after stop');
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
