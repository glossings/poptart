'use strict';

// The sclang-free engine (POPTART_ENGINE=node): OscEngine boots scsynth itself and runs the
// engine (engine/) in this process. The '/poptart/*' protocol between OscEngine and the engine is
// unchanged - _send dispatches into the engine instead of onto a socket, and what the engine tells
// arrives at _handleMessage as sclang's messages did. The sclang path stays the default.

const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const osc = require('osc');
const { Server, poptartOptions } = require('./server/server');
const { locateServer } = require('./server/locate');
const { bootDefs, sendDefs, extensionFlags, DefRegistry } = require('./server/defs');
const { VstHost } = require('./server/vst');
const { startEngine } = require('./engine/boot');
const { ensurePoptartExtension, ensureDeviceExtension } = require('./extensions');
const { pidfilePath, reapOrphanedEngine, recordEnginePids, clearEnginePids, killAndAwaitExit } = require('./orphans');
const { preparePluginScan, scanWarnings, noteProbe } = require('./plugin-scan');
const { openEngineLog } = require('./engine-log');
const { poptartHome } = require('./home');

/** 'node' or 'sclang' (the default): an explicit choice, else POPTART_ENGINE. */
function engineMode(choice = null) {
  const v = String(choice ?? process.env.POPTART_ENGINE ?? '').trim().toLowerCase();
  return v === 'node' ? 'node' : 'sclang';
}

// The arguments as sclang received them: OSC carried floats as float32.
const plainArgs = (args) => args.map((a) => (a && typeof a === 'object' && 'type' in a
  ? (a.type === 'f' ? Math.fround(a.value) : a.value) : a));

/** OscEngine#start for the node engine. `self` is the OscEngine. */
async function startNodeEngine(self, sampleRate, bufferSize, { MIX_BAND_FREQS, clarify }) {
  const loc = locateServer({ sclangPath: process.env.POPTART_SCLANG ? self.sclangPath : null });
  if (!loc.scsynthPath) {
    throw Object.assign(new Error(
      'could not find scsynth (SuperCollider\'s audio server). Install SuperCollider, or set POPTART_SCSYNTH to the scsynth binary.'),
    { code: 'NO_SCSYNTH' });
  }
  if (!fs.existsSync(path.join(loc.extensionsDir, 'VSTPlugin'))) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] VSTPlugin not found in ${loc.extensionsDir} - plugins will not open`);
  }
  const reaped = reapOrphanedEngine({ file: self._pidfile });
  if (reaped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] killed leftover engine processes from an earlier run: ${reaped.join(', ')}`);
  }
  const ext = ensurePoptartExtension({ extensionsDir: loc.extensionsDir });
  if (ext.skipped) console.warn(`[poptart] keylock pitch shifter not installed (${ext.skipped}); decks fall back to the SOLA keylock`); // eslint-disable-line no-console
  const dev = ensureDeviceExtension({ extensionsDir: loc.extensionsDir });
  if (dev.skipped) console.warn(`[poptart] poptart's own devices not installed (${dev.skipped}); synth("Plaits") and the other built-in devices will not sound`); // eslint-disable-line no-console

  const scan = preparePluginScan();
  self._stopping = false;
  self._journalFile = scan.journalFile;
  self._scan.total = scan.plugins.length;
  for (const line of scanWarnings(scan)) console.warn(`[poptart] ${line}`); // eslint-disable-line no-console
  self._log = openEngineLog();
  self._log.note(`engine starting (node) - device: ${self.outDevice ?? 'system default'}, sr: ${sampleRate}, block: ${bufferSize}, scsynth: ${loc.scsynthPath}`);
  for (const line of scanWarnings(scan)) self._log.note(line);

  // Everything scsynth and the engine print goes where sclang's output went: the scan's progress
  // counter, the engine log, the death watch and the terminal.
  const output = (text, isError = false) => {
    const s = String(text);
    self._scan.feed(s);
    self._log?.write(s);
    self._watchServerDeath(s);
    (isError ? process.stderr : process.stdout).write(`[engine] ${clarify(s)}`);
  };

  // A plugin's editor window sends its hotkeys to POPTART_HOTKEY_PORT over UDP (see onHotkey).
  const hotkeys = await new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (err) => { output(`WARNING: poptart: hotkey port ${self.nodePort}: ${err.message}\n`); resolve(null); });
    sock.on('message', (buf) => {
      try {
        const p = osc.readPacket(buf, { metadata: false });
        if (p.address) self._handleMessage({ address: p.address, args: p.args ?? [] });
      } catch { /* not OSC */ }
    });
    sock.bind(self.nodePort, '127.0.0.1', () => resolve(sock));
  });

  const options = poptartOptions({
    port: Number(process.env.POPTART_SCSYNTH_PORT || 57110), sampleRate, blockSize: bufferSize,
    outDevice: self.outDevice, outChannels: self.outChannels, inChannels: self.inChannels, ugenPluginsPath: loc.ugenPluginsPath,
  });
  output(`poptart: booting scsynth (device: ${self.outDevice || 'system default'}, sr: ${sampleRate}, block: ${bufferSize}, `
    + `out: ${options.numOutputBusChannels}ch, audible: ${Math.max(2, Math.min(self.playChannels, options.numOutputBusChannels))}ch, `
    + `in: ${self.inChannels}ch, rt mem: ${Math.round(options.memSize / 1024)}MB, max nodes: ${options.maxNodes}, `
    + `wire bufs: ${options.numWireBufs}, audio buses: ${options.numAudioBusChannels})\n`);
  const S = new Server({
    scsynthPath: loc.scsynthPath,
    options,
    env: { POPTART_HOTKEY_PORT: String(self.nodePort) },
    onOutput: (t) => output(t),
    onExit: (code, signal, wasRunning) => {
      // The wording sclang used, which _watchServerDeath and the host's crash report look for.
      if (wasRunning) output(`Server 'poptart' exited with exit code ${code ?? 0}${signal ? ` (${signal})` : ''}\n`);
    },
  });
  const node = { S, E: null, hotkeys };
  self._node = node;
  try {
    await S.boot();
    self._scsynthPid = S.pid;
    recordEnginePids({ sclang: null, scsynth: S.pid }, { file: self._pidfile });
    const entries = bootDefs({
      numOutputBusChannels: options.numOutputBusChannels, cueOffset: self.cueOffset, mixFreqs: MIX_BAND_FREQS,
      flags: extensionFlags(loc.extensionsDir),
    });
    await sendDefs(S, entries);
    const vst = new VstHost(S, { post: (t) => output(`${t}\n`), warn: (t) => output(`WARNING: ${t}\n`) });
    // A real port for the direct path to send through, and the engine behind _send.
    self._port = {
      send: ({ address, args }) => node.E?.dispatch(address, plainArgs(args ?? [])),
      sendRaw: (bytes) => S.sendRaw(bytes),
      close() {},
    };
    self._direct.allocNode = () => S.nextNodeID();
    // The view taps' reads (see view-taps.js) are answered to the server's socket, not to sclang's.
    for (const address of ['/b_setn', '/c_set']) S.on(address, (args) => self._views.handle({ address, args }));
    S.on('/fail', (a) => {
      // The direct path's repair, as _handleMessage did for a relayed /fail.
      const m = String(a[1] ?? '').match(/[0-9]+/);
      const id = Number.isInteger(a[2]) ? a[2] : m ? Number(m[0]) : null;
      if (['/n_set', '/u_cmd', '/s_new'].includes(String(a[0]))) self._direct.serverFailed(id);
    });
    const homePlugins = path.join(poptartHome(), 'plugins');
    node.E = await startEngine({
      server: S,
      defs: DefRegistry.of(entries),
      vst,
      config: {
        nodePort: self.nodePort, oscInPort: self.oscInPort, sampleRate, blockSize: bufferSize,
        outDevice: self.outDevice, outChannels: self.outChannels, playChannels: self.playChannels,
        inChannels: self.inChannels, cueOffset: self.cueOffset,
        searchDirs: scan.dirs.length ? scan.dirs : (fs.existsSync(homePlugins) ? [homePlugins] : null),
        excludePaths: scan.exclude,
        parallelScan: process.env.POPTART_VST_PARALLEL === '1',
        mixFreqs: MIX_BAND_FREQS,
      },
      // In arrival order, but never inside the handler that said it - sclang's answers crossed a socket.
      tell: (address, args) => queueMicrotask(() => self._handleMessage({ address, args })),
      output,
    });
  } catch (err) {
    await stopNodeEngine(self);
    throw err;
  }
}

/** OscEngine#stop for the node engine. */
async function stopNodeEngine(self) {
  const node = self._node;
  self._node = null;
  self._stopping = true;
  if (self._journalFile) noteProbe(null, { file: self._journalFile });
  if (node) {
    try { node.E?.dispatch('/poptart/quit', []); } catch { /* best effort */ }
    try { node.E?.stop(); } catch { /* best effort */ }
    await node.S.quit();
    try { node.hotkeys?.close(); } catch { /* closed */ }
  }
  if (self._scsynthPid != null) {
    const pid = self._scsynthPid;
    self._scsynthPid = null;
    const { killed, gone } = await killAndAwaitExit(pid); // to the end of the process - see index.js stop()
    if (killed) console.warn(`[poptart] scsynth (pid ${pid}) did not quit - killed it so the next engine start can open the audio device`); // eslint-disable-line no-console
    if (!gone) console.warn(`[poptart] scsynth (pid ${pid}) is still exiting after a kill - the next engine start may find the audio device busy`); // eslint-disable-line no-console
  }
  if (self._oscAd) {
    self._oscAd.stop();
    self._oscAd = null;
  }
  clearEnginePids({ file: self._pidfile });
  self._direct.stop();
  self._direct.allocNode = null;
  self._log?.close();
  self._log = null;
  self._port = null;
}

module.exports = { engineMode, startNodeEngine, stopNodeEngine, plainArgs, pidfilePath };
