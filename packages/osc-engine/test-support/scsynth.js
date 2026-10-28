'use strict';

process.env.POPTART_SILENT = '1'; // tests never play through the speakers

// A real scsynth for tests: booted on a port of the test's own, with poptart's SynthDefs (built in
// Node by ../synthdef), and the engine started on it. skipReason() says why a machine cannot run
// these, so a test skips rather than fails there.
//
// Run these files one at a time, sandbox off; every test must call quit() on every path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, poptartOptions } = require('../server/server');
const { locateServer } = require('../server/locate');
const { bootDefs, sendDefs, extensionFlags, DefRegistry } = require('../server/defs');
const { ensureDeviceExtension, ensurePoptartExtension } = require('../extensions');
const { startEngine } = require('../engine/boot');

const TEST_HOME = path.join(os.tmpdir(), 'poptart-test-home');

function skipReason() {
  return locateServer().scsynthPath ? null : 'no scsynth on this machine';
}

/** The defs an engine with this config boots with: { entries, meta }. */
async function testDefs({ outChannels = 2, cueOffset = null, mixFreqs = [] } = {}) {
  const loc = locateServer();
  ensurePoptartExtension({ extensionsDir: loc.extensionsDir });
  ensureDeviceExtension({ extensionsDir: loc.extensionsDir });
  const entries = bootDefs({
    numOutputBusChannels: Math.max(2, outChannels), cueOffset, mixFreqs, flags: extensionFlags(loc.extensionsDir),
  });
  return { entries, meta: Object.fromEntries(entries.map((e) => [e.name, e.meta])) };
}

/**
 * Boots scsynth on `port` and starts the engine with `sections` (null = all). Returns
 * { S, E, told, output, quit }: `told` collects every message the engine sent Node,
 * `output` everything printed.
 */
async function bootEngine({ port, sections = null, config = {}, vst = null, devices = null, quiet = true, scan = false } = {}) {
  if (!port || port < 57400 || port > 57499) throw new Error('tests use UDP ports 57400-57499');
  const loc = locateServer();
  const defs = await testDefs(config);
  const told = [];
  let output = '';
  const write = (t) => {
    output += t;
    if (!quiet) process.stdout.write(t);
  };
  const S = new Server({
    scsynthPath: loc.scsynthPath,
    options: poptartOptions({ port, ugenPluginsPath: loc.ugenPluginsPath, ...config.server }),
    onOutput: write,
  });
  const quit = async () => {
    try { E?.stop(); } catch { /* best effort */ }
    await S.quit();
  };
  let E = null;
  try {
    await S.boot();
    await sendDefs(S, defs.entries);
    E = await startEngine({
      server: S, defs: new DefRegistry(defs.meta), vst, devices, sections, scan,
      config: { nodePort: 0, ...config },
      tell: (address, args) => told.push({ address, args }),
      output: write,
    });
  } catch (err) {
    await quit();
    throw err;
  }
  return { S, E, told, get output() { return output; }, quit, defs };
}

/** Resolves with the first told message at `address` (passing `match`), waiting up to timeoutMs. */
async function toldWhen(told, address, match = () => true, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const m = told.find((x) => x.address === address && match(x.args));
    if (m) return m;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no ${address} told within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

module.exports = { bootEngine, testDefs, skipReason, toldWhen, TEST_HOME, fs };
