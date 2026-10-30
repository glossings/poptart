'use strict';

// Brings the engine up on a booted scsynth: the sections, the shared buses and groups, the master
// meter, the pressure gauge, the keylock probe, and the ready - poptart.scd's waitForBoot block.

const { Engine } = require('./core');
const { Synth, Group, Bus } = require('../server/objects');

// The engine's parts, each a port of one stretch of poptart.scd (see core.js's conventions).
const SECTIONS = [
  'tracks', 'routing', 'loads', 'ids', 'params', 'expr', 'notes', 'sampler', 'songs',
  'state', 'record', 'mixer', 'view-taps', 'scan', 'midi', 'osc-in', 'clock',
];

function installSections(E, only = null) {
  const installed = [];
  for (const name of only ?? SECTIONS) {
    let mod;
    try {
      mod = require(`./${name}`);
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`/${name}'`)) continue;
      throw err;
    }
    mod.install(E);
    installed.push(name);
  }
  return installed;
}

/** The pressure gauge: /status every 3s, said when the node table passes 60% (poptart.scd's statusWatch). */
function watchStatus(E) {
  const S = E.S;
  S.on('/status.reply', (a) => {
    // a: [unused, numUGens, numSynths, numGroups, numDefs, avgCPU, peakCPU, nominalSR, actualSR]
    const nodes = Number(a[2]) + Number(a[3]);
    const peakCPU = Number(a[6]);
    const limit = S.options.maxNodes;
    E.tell('/poptart/serverLoad', nodes, limit, E.liveVoices.size, peakCPU);
    if (nodes > limit * 0.6) {
      if (!E.statusNodesHigh) {
        E.statusNodesHigh = true;
        E.warn(`poptart: the audio server is getting full - ${nodes} of ${limit} nodes in use (${E.liveVoices.size} `
          + `sample voices sounding, peak CPU ${Math.round(peakCPU * 10) / 10}%). Past this it stops being able to `
          + 'create anything, and it cannot recover without an engine restart - stop a track if you can');
      }
    } else if (nodes < limit * 0.4) {
      E.statusNodesHigh = false;
    }
  });
  E.sched(0, () => { S.send(['/status']); return 3; });
}

/**
 * Says when the engine's own loop was held up: every message to the server that is not on the
 * direct path waits behind it. The successor of poptart.scd's "sclang stalled" line.
 */
function watchStalls(E) {
  let last = E.elapsed();
  E.sched(0.02, () => {
    const now = E.elapsed();
    const gap = now - last - 0.02;
    if (gap > 0.08) E.warn(`poptart: engine stalled ~${Math.round(gap * 1000)}ms`);
    last = now;
    return 0.02;
  });
}

/** The keylock pitch shifter's latency, measured once (see rbProbeDef in synthdef/defs.js). */
function probeKeylock(E) {
  if (!E.defs.has('poptart_rbprobe')) return;
  const S = E.S;
  const probe = Synth.basicNew('poptart_rbprobe', S);
  S.once('/poptart/rbDelay', (a) => a[0] === probe.nodeID, (a) => {
    E.rbDelay = Number(a[2]);
    E.tell('/poptart/ids/rbDelay', E.rbDelay);
    E.post(`poptart: keylock pitch shifter delay ${Math.trunc(E.rbDelay)} samples`);
  });
  S.send(probe.newMsg(null, [], 'addToHead'));
}

/**
 * The engine on `server` (booted, defs loaded). Resolves once it has said /poptart/ready.
 * `sections` limits which parts are installed (tests).
 */
async function startEngine({ server, config, tell, output, defs, vst = null, devices = null, sections = null, scan = true }) {
  const S = server;
  const E = new Engine({ server, config, tell, output, defs, vst, devices });
  S.defaultGroup = Group.basicNew(S, 1);
  S.send(['/g_new', 1, 0, 0]);
  E.installed = installSections(E, sections);

  E.silentBus = Bus.audio(S, 2);
  E.trashBus = Bus.audio(S, 2);
  E.deckMeterBus = Bus.audio(S, 4);
  E.recGroup = Group.new(S, null, 'addToTail');
  E.levelGroups = [Group.new(S, null, 'addToHead')];
  await S.sync();
  E.masterSynth = Synth.new(S, 'poptart_master', [], E.recGroup, 'addAfter');
  if (E.cueOffset != null && defs.has('poptart_headphones')) {
    E.headphoneSynth = Synth.new(S, 'poptart_headphones', ['level', E.headphoneLevel, 'mix', E.headphoneMix],
      E.masterSynth, 'addAfter');
  }
  watchStatus(E);
  watchStalls(E);
  E.post('poptart: server booted, ready');
  probeKeylock(E);
  // Node allocates every id itself now, so there is no separate block: lo = hi = 0 says so.
  E.tell('/poptart/ids/server', E.scsynthPort, 0, 0, S.sampleRate ?? E.sampleRate, E.rbDelay, E.openWaitMax + E.coldWaitMax);
  E.tell('/poptart/ready', S.pid ?? -1);
  if (scan && typeof E.runScan === 'function') {
    E.runScan(() => E.post(`poptart: initial plugin search done (${E.vst?.pluginCount?.() ?? 0} plugins)`));
  }
  return E;
}

module.exports = { startEngine, installSections, SECTIONS };
