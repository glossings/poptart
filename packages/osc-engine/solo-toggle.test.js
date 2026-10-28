'use strict';

process.env.POPTART_SILENT = '1'; // tests never play through the speakers

// Soloing a track and taking the solo off again, the way the editor does it: a solo is a label
// marker, and the evaluation it triggers stops every track it soloes away (Scheduler#stop - the
// engine track stays, warm) and brings each one back on the next with a fresh Scheduler, hushed on
// the play. Done a few times over, every track must still sound on its tap meter, and no write may
// go to a node the server does not have - on the node engine (POPTART_ENGINE=node) and on sclang.
//
// What this guards on the node engine: a fresh Scheduler's setPattern sends the chain's wiring and
// then resets every channel control, bassmono among them, in one burst. The wiring used to wait a
// turn for its track (awaitTrack always yields), so the bass mono stage was born first, reading
// the chain's old output bus, and the wiring's moves and `in` for it reached the server before the
// node existed: "/n_set Node N not found", and the track silent until its next evaluation.
//
// Real scsynth on ports 57460-57463, sandbox off; skipped where there is none (the sclang run also
// where sclang is missing). The home folder is a temp one, and the plugin scan walks an empty
// folder, so nothing outside the test is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipReason } = require('./test-support/scsynth');
const { privateScRoot } = require('./private-sc');

const NODE_PORT = 57460;
const SCSYNTH_PORT = 57461;
const OSC_IN_PORT = 57462;
const SCLANG_PORT = 57463;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function soloRound(t, engine) {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const P = await import('../pattern-core/src/signal.mjs');
  const { Scheduler } = await import('../pattern-core/src/scheduler.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-solo-'));
  const plugins = path.join(home, 'no-plugins');
  fs.mkdirSync(plugins);
  const env = {
    POPTART_SC_ROOT: privateScRoot(), POPTART_HOME: home, POPTART_VST_DIRS: plugins,
    POPTART_SCSYNTH_PORT: String(SCSYNTH_PORT),
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const { OscEngine } = require('./index');
  const e = new OscEngine({ engine, nodePort: NODE_PORT, oscInPort: OSC_IN_PORT, scPort: SCLANG_PORT });
  const fails = [];
  const output = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => {
    output.push(String(s));
    return write(s, ...rest);
  };
  const schedulers = new Map();
  try {
    await e.start(48000, 256);
    e._node?.S.on('/fail', (a) => fails.push(a.map(String).join(' ')));

    // Several tracks, each on one of poptart's own devices, carrying what a set does: a polled
    // param, a native lfo, an envelope, channel controls and an effect.
    const notes = P.note('c3 e3 g3 c4').fast(2);
    const songs = {
      lead: () => notes.synth('Plaits').param('Timbre', '0.2 0.5 0.8').param('Harmonics', P.lfo('0,0 0.5,1 1,0', { rate: 2 })),
      bass: () => P.note('c2 ~ c2 g1').fast(2).synth('Plaits').param('Morph', P.env({ attack: 0.01, decay: 0.2, sustain: 0.3 }))
        .fx('Delay').pan(P.sine(0.25)),
      keys: () => notes.synth('Plaits').param('Decay', P.sine(0.3)).fx('Chorus').gain(0.8),
    };
    const play = (key) => {
      e.hush(key);
      const sch = new Scheduler(e, { trackId: key, label: key });
      schedulers.set(key, sch);
      sch.setPattern(songs[key]());
      sch.start();
    };
    const stop = (key) => {
      schedulers.get(key)?.stop();
      schedulers.delete(key);
    };
    for (const key of Object.keys(songs)) play(key);
    // Every track's tap meter runs throughout; a window reads the loudest each one got.
    let peaks = new Map();
    e.onRecLevel = (track, peak) => peaks.set(track, Math.max(peaks.get(track) ?? 0, peak));
    await sleep(2500); // the devices open
    for (const key of Object.keys(songs)) e.tapTrack(key, true);
    await sleep(500);

    // Solo `lead`, then take it off; then solo `bass` and take that off - three times over. After
    // each solo comes off, every track is heard again.
    const silent = [];
    for (let round = 0; round < 3; round++) {
      for (const solo of ['lead', 'bass']) {
        for (const key of Object.keys(songs)) if (key !== solo) stop(key);
        await sleep(700);
        for (const key of Object.keys(songs)) if (!schedulers.has(key)) play(key);
        await sleep(400); // the first notes back
        peaks = new Map();
        await sleep(1000);
        for (const key of Object.keys(songs)) {
          if (!((peaks.get(key) ?? 0) > 0.01)) silent.push(`${key} after unsoloing ${solo} (round ${round + 1}): peak ${peaks.get(key) ?? 0}`);
        }
      }
    }
    for (const key of Object.keys(songs)) e.tapTrack(key, false);

    assert.deepEqual(silent, [], 'every track sounds once a solo comes off');
    const nodeFails = fails.filter((f) => /Node [0-9]+ not found/.test(f));
    assert.deepEqual(nodeFails, [], 'nothing was sent to a node the server does not have');
    const gone = output.filter((l) => /has no node|FAILURE IN SERVER \/n_set/.test(l));
    assert.deepEqual(gone, [], 'the engine never found a write to a freed node');
  } finally {
    process.stdout.write = write;
    for (const sch of schedulers.values()) sch.stop();
    const pid = e._scsynthPid;
    await e.stop();
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    // stop() resolves only once the process is gone (a killed one included), so this checks at once.
    if (pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, 'scsynth is gone after stop');
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('node engine: soloing and unsoloing over and over leaves every track sounding, and nothing writes to a freed node',
  (t) => soloRound(t, 'node'));

test('sclang: the same solos leave every track sounding, and nothing writes to a freed node', (t) => {
  const { resolveSclangPath } = require('./index');
  const sclang = resolveSclangPath();
  if (!sclang || !fs.existsSync(sclang)) { t.skip('no sclang on this machine'); return null; }
  return soloRound(t, 'sclang');
});
