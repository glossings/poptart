'use strict';

// Tests for the desktop shell's process supervision (server-process.js).
//
// These drive a stand-in HTTP server rather than poptart's real one: what is being tested is
// the supervision - find a port, wait for it to answer, shut it down without orphaning the
// audio engine - and none of that is about what the server serves. It also means the suite
// never boots sclang or opens an audio device.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const {
  createBootNarrator,
  findFreePort,
  waitForServer,
  fetchEngineStatus,
  startServer,
  stopServer,
  SERVER_ENTRY,
} = require('./server-process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-desktop-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// A stand-in for server.js: reads PORT from the environment exactly as the real one does, and
// reports the shutdown handling we depend on - the IPC message, the channel dropping, SIGINT.
function fakeServer({ ignoreShutdown = false, exitImmediately = false, delayMs = 0 } = {}) {
  const file = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(
    file,
    `
const http = require('node:http');
if (${exitImmediately}) { console.error('fake server refusing to start'); process.exit(3); }
const server = http.createServer((req, res) => { res.end('ok'); });
setTimeout(() => {
  server.listen(Number(process.env.PORT), process.env.POPTART_HOST || '127.0.0.1', () => {
    console.log('[poptart] listening on http://localhost:' + process.env.PORT);
  });
}, ${delayMs});
const stop = (how) => {
  if (${ignoreShutdown}) { console.log('ignoring ' + how); return; }
  console.log('stopping the engine (' + how + ')');
  process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('message', (msg) => { if (msg && msg.type === 'shutdown') stop('shutdown message'); });
process.on('disconnect', () => stop('disconnect'));
`,
  );
  return file;
}

test('the real server entry point exists where the shell expects it', () => {
  // A rename of server.js would otherwise only show up as a failed launch in a packaged app.
  assert.ok(fs.existsSync(SERVER_ENTRY), `${SERVER_ENTRY} is missing`);
});

test('findFreePort returns a port that can then be bound', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 1024, `not a usable port: ${port}`);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('findFreePort does not hand out the same port twice in a row', async () => {
  const [a, b] = await Promise.all([findFreePort(), findFreePort()]);
  assert.notStrictEqual(a, b);
});

test('the server is started on the given port and waited for', async () => {
  const port = await findFreePort();
  const logs = [];
  const child = startServer({ port, entry: fakeServer({ delayMs: 200 }), onLog: (l) => logs.push(l) });
  try {
    await waitForServer(port, { timeoutMs: 15000 });
    assert.ok(
      logs.some((l) => l.includes(`listening on http://localhost:${port}`)),
      `the child should have been told which port to use: ${logs.join(' | ')}`,
    );
  } finally {
    await stopServer(child);
  }
});

test('the server is bound to loopback, never a public interface', async () => {
  // The server evals arbitrary JS by design, so the desktop build must not be the thing that
  // widens its bind (PACKAGING.md, Stage 0).
  const port = await findFreePort();
  let captured = null;
  const child = startServer({
    port,
    entry: fakeServer(),
    env: { ...process.env, POPTART_HOST: '0.0.0.0' },
    spawnFn: (execPath, args, opts) => {
      captured = opts.env;
      return require('node:child_process').spawn(execPath, args, opts);
    },
  });
  try {
    assert.strictEqual(captured.POPTART_HOST, '127.0.0.1', 'the shell must force loopback');
    assert.strictEqual(captured.PORT, String(port));
    // Without this a packaged app would try to run main.js as an Electron window, not as Node.
    assert.strictEqual(captured.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    await stopServer(child);
  }
});

test('waiting gives up promptly when the server dies instead of sitting out the timeout', async () => {
  const port = await findFreePort();
  const died = new AbortController();
  const child = startServer({
    port,
    entry: fakeServer({ exitImmediately: true }),
    onExit: ({ code }) => died.abort(`exited with ${code}`),
  });
  const started = Date.now();
  await assert.rejects(
    () => waitForServer(port, { timeoutMs: 60000, signal: died.signal }),
    /exited with 3|did not start/,
  );
  assert.ok(Date.now() - started < 20000, 'should not have waited out the full timeout');
  await stopServer(child);
});

test('waiting fails with a clear message when nothing ever listens', async () => {
  const port = await findFreePort();
  await assert.rejects(() => waitForServer(port, { timeoutMs: 600, intervalMs: 50 }), /did not start within/);
});

test('shutdown asks over the channel first, so the engine can stop scsynth cleanly', async () => {
  // No platform skip: the ask is a message, not a signal, and it must work on Windows too.
  const port = await findFreePort();
  const logs = [];
  const child = startServer({ port, entry: fakeServer(), onLog: (l) => logs.push(l) });
  await waitForServer(port, { timeoutMs: 15000 });
  const how = await stopServer(child, { graceMs: 5000 });
  assert.strictEqual(how, 'exited');
  assert.ok(
    logs.some((l) => l.includes('stopping the engine (shutdown message)')),
    `the child should have been asked, not signalled: ${logs.join(' | ')}`,
  );
});

test('a server whose shell vanished shuts itself down', async () => {
  // The shell crashing or being killed drops the channel; the server must treat that as the
  // quit it never got, or scsynth plays on with nobody driving it.
  const port = await findFreePort();
  const logs = [];
  const child = startServer({ port, entry: fakeServer(), onLog: (l) => logs.push(l) });
  await waitForServer(port, { timeoutMs: 15000 });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.disconnect();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('the child outlived its channel')), 8000))]);
  assert.ok(logs.some((l) => l.includes('stopping the engine (disconnect)')), logs.join(' | '));
});

test('shutdown forces the issue when the request is ignored', async () => {
  const port = await findFreePort();
  const child = startServer({ port, entry: fakeServer({ ignoreShutdown: true }) });
  await waitForServer(port, { timeoutMs: 15000 });
  const started = Date.now();
  // A server that won't quit must not hang the app's own quit forever.
  const how = await stopServer(child, { graceMs: 300 });
  assert.ok(['forced', 'exited'].includes(how), `unexpected outcome: ${how}`);
  assert.ok(Date.now() - started < 10000);
  assert.ok(child.killed || child.exitCode !== null || child.signalCode !== null);
});

// A stand-in serving /api/status the way the real server does, so the shell can be tested
// against both "the engine is up" and "the engine failed" without booting an audio engine.
function fakeStatusServer(body) {
  const file = path.join(tmp, `status-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(
    file,
    `
const http = require('node:http');
http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('content-type', 'application/json');
    res.end(${JSON.stringify(JSON.stringify(body))});
    return;
  }
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  return file;
}

test('a healthy engine reports loaded, so the shell can say Ready', async () => {
  const port = await findFreePort();
  const child = startServer({ port, entry: fakeStatusServer({ loaded: true, error: null }) });
  try {
    await waitForServer(port, { timeoutMs: 15000 });
    const status = await fetchEngineStatus(port);
    assert.strictEqual(status.loaded, true);
  } finally {
    await stopServer(child);
  }
});

test('a failed engine is detected even though the server answers fine', async () => {
  // The bug this exists to prevent: the window said "Ready" while the engine was down after an
  // EADDRINUSE, so poptart looked healthy and silently made no sound.
  const port = await findFreePort();
  const child = startServer({
    port,
    entry: fakeStatusServer({ loaded: false, error: 'bind EADDRINUSE 127.0.0.1:57140' }),
  });
  try {
    await waitForServer(port, { timeoutMs: 15000 });
    const status = await fetchEngineStatus(port);
    assert.strictEqual(status.loaded, false);
    assert.match(status.error, /EADDRINUSE/, 'the reason has to survive to the dialog');
  } finally {
    await stopServer(child);
  }
});

test('an unreadable status is null, not a false alarm', async () => {
  // Nothing listening, and a server that answers with something that isn't JSON. Neither is
  // evidence that the engine failed, so neither may be reported as a failure.
  const port = await findFreePort();
  assert.strictEqual(await fetchEngineStatus(port, { timeoutMs: 1000 }), null);

  const other = await findFreePort();
  const child = startServer({ port: other, entry: fakeServer() });
  try {
    await waitForServer(other, { timeoutMs: 15000 });
    assert.strictEqual(await fetchEngineStatus(other), null, 'a non-JSON body is not a failure');
  } finally {
    await stopServer(child);
  }
});

test('the Windows shutdown path asks too, and forces when ignored', async () => {
  // Windows cannot be sent SIGINT, and the first desktop build hard-killed there - which left
  // sclang and scsynth running and audible after the app closed. `platform` is injected so the
  // branch runs on any machine - it is the one CI's macOS half never touches.
  const port = await findFreePort();
  const logs = [];
  const child = startServer({ port, entry: fakeServer(), onLog: (l) => logs.push(l) });
  await waitForServer(port, { timeoutMs: 15000 });
  const how = await Promise.race([
    stopServer(child, { platform: 'win32' }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 8000)),
  ]);
  assert.strictEqual(how, 'exited');
  assert.ok(logs.some((l) => l.includes('stopping the engine (shutdown message)')), logs.join(' | '));

  const deaf = startServer({ port: await findFreePort(), entry: fakeServer({ ignoreShutdown: true }) });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const forced = await stopServer(deaf, { platform: 'win32', graceMs: 300 });
  assert.ok(['forced', 'exited'].includes(forced), `unexpected outcome: ${forced}`);
  assert.ok(deaf.killed || deaf.exitCode !== null || deaf.signalCode !== null);
});

test('stopping something already stopped is not an error', async () => {
  const port = await findFreePort();
  const child = startServer({ port, entry: fakeServer({ exitImmediately: true }) });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.strictEqual(await stopServer(child), 'already stopped');
  assert.strictEqual(await stopServer(null), 'already stopped');
});

test('the loading screen is told the phase, not the output', () => {
  const narrate = createBootNarrator();
  const said = [];
  const feed = (line) => {
    const update = narrate(line);
    if (update) said.push(update.detail ? `${update.text} - ${update.detail}` : update.text);
  };
  feed('[sclang] compiling class library...');
  feed('[sclang] \tFound 872 primitives.');
  feed('[sclang] *** Welcome to SuperCollider 3.14.1. *** For help type cmd-d.');
  feed('[sclang] poptart: booting scsynth');
  feed('[sclang] Booting server \'poptart\' on address 127.0.0.1:57151.');
  for (let i = 1; i <= 25; i += 1) feed(`[sclang] /Library/Audio/Plug-Ins/VST3/Plugin ${i}.vst3`);
  feed('/Library/Audio/Plug-Ins/VST/Unprefixed Old One.vst');
  feed('[sclang] \t[1/2] A shell plugin\'s sub-plugin');
  feed('[sclang] WARNING: VSTPlugin: no plugin loaded!');
  feed('[sclang] poptart: initial plugin search done (392 plugins)');
  feed('[poptart] plugin scan finished: 392 plugin(s) known, 396 probed in 5s');
  feed('[sclang] poptart: loaded instrument Serum 2');
  feed('[poptart] the audio engine did not come up in time - trying once more');
  assert.deepStrictEqual(said, [
    'Starting SuperCollider',
    'Starting the audio server',
    'Scanning plugins',
    'Scanning plugins - 10 checked',
    'Scanning plugins - 20 checked',
    'Loading the session',
    'Starting the audio engine again',
  ]);
});
