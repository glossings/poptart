'use strict';

// Announces the OSC input port over Bonjour, so a controller app's "browse for hosts" (TouchOSC's
// Browse button, and anything else that looks for the _osc._udp service) lists this machine as
// "poptart" with the port filled in - the alternative is reading the Mac's IP off the network
// settings and typing it into a phone, once per network.
//
// macOS only for now: the announcement is the system's own `dns-sd -R`, which registers the
// service for as long as it runs and withdraws it when it exits - so the handle here IS that
// process, and stopping the announcement is killing it. Its pid is written to the engine's
// pidfile alongside sclang/scsynth (see orphans.js), because a Node that dies without reaching
// stop() would otherwise leave a dns-sd behind, and the next boot's registration would then come
// up as "poptart (2)". Elsewhere (no dns-sd, or not darwin) this is a no-op that says so once -
// a cross-platform announcer is a TODO.md item.

const { spawn } = require('node:child_process');

const SERVICE_TYPE = '_osc._udp';

/**
 * Start announcing `port` as the OSC service `name`. Returns a handle: { pid, stop() }. `pid` is
 * null when nothing was started (wrong platform, dns-sd missing) - stop() is then a no-op.
 */
function advertiseOsc(port, { name = 'poptart', platform = process.platform, spawnFn = spawn, log = console } = {}) {
  if (platform !== 'darwin') {
    log.log?.(`[poptart] OSC input on udp ${port} - not announced over Bonjour on ${platform} (macOS only so far), enter the host by hand in the controller`);
    return { pid: null, stop() {} };
  }
  let proc;
  try {
    proc = spawnFn('dns-sd', ['-R', name, SERVICE_TYPE, '.', String(port)], { stdio: 'ignore' });
  } catch (err) {
    log.warn?.(`[poptart] OSC input on udp ${port} - Bonjour announcement failed to start (${err.message})`);
    return { pid: null, stop() {} };
  }
  let stopped = false;
  proc.on('error', (err) => {
    // ENOENT arrives here asynchronously (spawn itself doesn't throw for a missing binary).
    if (!stopped) log.warn?.(`[poptart] OSC input on udp ${port} - Bonjour announcement failed (${err.message}); enter the host by hand in the controller`);
  });
  proc.on('exit', (code, signal) => {
    if (!stopped && code !== 0) log.warn?.(`[poptart] Bonjour announcer exited (${signal ?? code}) - "Browse" in the controller app will no longer find this machine`);
  });
  log.log?.(`[poptart] OSC input on udp ${port} announced over Bonjour as "${name}" (${SERVICE_TYPE})`);
  return {
    pid: proc.pid ?? null,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    },
  };
}

module.exports = { advertiseOsc, SERVICE_TYPE };
