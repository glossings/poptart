'use strict';

// Supervising the poptart server from the desktop shell (PACKAGING.md, Stage 2).
//
// The web-app is a plain Node HTTP server plus a browser page, so the desktop build does not
// reimplement any of it: it starts `packages/web-app/server.js` unchanged as a child process
// and points a window at the port it opens. Keeping the server a separate process (rather than
// require()-ing it into the Electron main process) buys three things: server.js stays a normal
// Node program that `npm run dev` runs identically, a crash in it cannot take the window with
// it, and shutting the audio engine down is a matter of signalling one pid.
//
// Deliberately free of `require('electron')` so it can be unit-tested with plain node - the
// interesting logic here is port selection, readiness and shutdown, none of which needs a GUI.

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ENTRY = path.join(__dirname, '..', 'web-app', 'server.js');

/**
 * An unused loopback port, found by binding one and letting the OS choose. Asking for a free
 * port rather than hardcoding 4000 is what lets the app run while a `npm run dev` server is
 * already up on the usual port - during development that is the normal case, and a desktop
 * build that refused to start then would be tiresome.
 *
 * There is an unavoidable race between releasing the port and the child binding it; on loopback
 * with an immediate handover it is not one that happens in practice, and a genuinely taken port
 * surfaces as a clear startup failure rather than a wrong-window mystery.
 */
function findFreePort({ host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Resolves once the server answers on `port`, rejecting if it never does. */
function waitForServer(port, { host = '127.0.0.1', timeoutMs = 120000, intervalMs = 150, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal?.aborted) return reject(new Error(signal.reason ?? 'the server exited before it was ready'));
      const req = http.get({ host, port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => {
        // Connection refused is the normal answer until the listener is up; the only real
        // failure is running out of time (or the child dying, via `signal`).
        if (Date.now() > deadline) {
          reject(new Error(`the poptart server did not start within ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        // Deliberately NOT unref'd: someone is awaiting this, so it has to hold the event loop
        // open. Unref'd, a wait whose server had already died left nothing alive between
        // attempts, and the process wound down mid-wait with the promise still pending (Node 20
        // reports exactly that; newer versions happened to mask it).
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

/**
 * Ask the server whether the audio engine came up: `{ loaded, error }` from GET /api/status.
 *
 * "The server is answering" and "poptart can make sound" are different questions, and only the
 * first one is what waitForServer proves. The engine is started before the HTTP listener opens,
 * so by the time anything answers here the result is already settled - no polling needed.
 *
 * Resolves null when the status can't be read at all, which is a reason to say nothing rather
 * than to claim a failure.
 */
function fetchEngineStatus(port, { host = '127.0.0.1', timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/status', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

/**
 * Start the poptart server as a child process.
 *
 * In a packaged app there is no `node` on the user's machine to spawn, so the Electron binary is
 * re-executed with ELECTRON_RUN_AS_NODE=1 - that runs it as a plain Node process, which is
 * exactly what server.js expects. In development `process.execPath` is already node and the same
 * call works unchanged.
 *
 * @param {object} [opts]
 * @param {number} opts.port - the port the server should listen on.
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [opts.onLog]
 * @param {(info: {code: number|null, signal: string|null}) => void} [opts.onExit]
 */
function startServer({
  port,
  entry = SERVER_ENTRY,
  execPath = process.execPath,
  env = process.env,
  onLog = () => {},
  onExit = () => {},
  spawnFn = spawn,
} = {}) {
  const child = spawnFn(execPath, [entry], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      // Never widen the bind in the desktop build: the server evals arbitrary JS by design
      // (see PACKAGING.md Stage 0), and a window on this machine is the only intended client.
      POPTART_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of ['stdout', 'stderr']) {
    child[stream]?.setEncoding('utf8');
    child[stream]?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) onLog(line, stream);
      }
    });
  }
  child.on('exit', (code, signal) => onExit({ code, signal }));
  return child;
}

/**
 * Shut the server down, giving it a chance to stop the audio engine first.
 *
 * server.js handles SIGINT by asking sclang to quit scsynth cleanly, which matters: scsynth is
 * sclang's child, not ours, so a hard kill of the server leaves it holding the audio device
 * (that is the whole subject of osc-engine/orphans.js). So: signal, wait, and only then force.
 *
 * Windows has no real signals - Node's kill() terminates the process whatever you pass - so the
 * graceful path simply does not exist there and the grace period is skipped. The engine's own
 * pidfile reaping cleans up the leftovers on the next boot, which is what it is for.
 */
function stopServer(child, { graceMs = 5000, platform = process.platform, timers = { setTimeout } } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve('already stopped');
    let settled = false;
    // Declared up here, not where it is armed: done() closes over it, and the Windows branch
    // below returns before the grace timer exists.
    let timer = null;
    const done = (how) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(how);
    };
    child.once('exit', () => done('exited'));

    if (platform === 'win32') {
      child.kill();
      return;
    }
    child.kill('SIGINT');
    timer = timers.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // it exited between the check and the signal - the exit handler resolves
      }
      done('forced');
    }, graceMs);
    timer.unref?.();
  });
}

/**
 * Turns the server's boot output into what the loading screen says. The output itself is no use
 * there: a plugin scan prints a file path per plugin, hundreds a second, which on screen is a
 * blur nobody can read. So the screen names the phase the boot is in, with a count while
 * plugins are being scanned, and the lines themselves go to the log (diagnostics.js).
 *
 * Returns a function to feed each line to. It answers `{ text, detail }` when the screen should
 * change and null when it should not - which is most lines: a phase is announced once, and the
 * scan count moves in steps, so the text holds still long enough to be read.
 */
function createBootNarrator({ countStep = 10 } = {}) {
  let phase = null;
  let scanned = 0;
  const enter = (next, text) => {
    if (phase === next) return null;
    phase = next;
    return { text, detail: '' };
  };
  return (line) => {
    if (/\.(vst3?|component|clap)\s*$/i.test(line)) {
      scanned += 1;
      const first = enter('scan', 'Scanning plugins');
      if (first) return first;
      return scanned % countStep === 0 ? { text: 'Scanning plugins', detail: `${scanned} checked` } : null;
    }
    if (/plugin scan finished|initial plugin search done/i.test(line)) return enter('scanned', 'Loading the session');
    if (/booting scsynth|Booting server/i.test(line)) return enter('scsynth', 'Starting the audio server');
    if (/compiling class library|Welcome to SuperCollider/i.test(line)) return enter('sclang', 'Starting SuperCollider');
    return null;
  };
}

module.exports = {
  SERVER_ENTRY,
  createBootNarrator,
  findFreePort,
  waitForServer,
  fetchEngineStatus,
  startServer,
  stopServer,
};
