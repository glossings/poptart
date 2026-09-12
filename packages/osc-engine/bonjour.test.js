'use strict';

// The Bonjour announcement of the OSC input port (bonjour.js). The real dns-sd is never run:
// `spawnFn` is injected, and what's pinned is the contract the engine relies on - the exact
// registration dns-sd is asked for, a no-op handle off macOS or when the tool is missing, and
// stop() withdrawing the announcement by ending the process it IS.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { advertiseOsc, SERVICE_TYPE } = require('./bonjour');

function quietLog() {
  const lines = { log: [], warn: [] };
  return { lines, log: (s) => lines.log.push(s), warn: (s) => lines.warn.push(s) };
}

// A fake child: records the spawn, can be killed, and emits like a ChildProcess.
function fakeSpawn() {
  const spawned = [];
  const spawnFn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.pid = 4242;
    proc.killed = [];
    proc.kill = (sig) => proc.killed.push(sig);
    spawned.push({ cmd, args, opts, proc });
    return proc;
  };
  return { spawned, spawnFn };
}

test('registers the _osc._udp service by name and port through dns-sd, and reports its pid', () => {
  const { spawned, spawnFn } = fakeSpawn();
  const log = quietLog();
  const ad = advertiseOsc(57160, { platform: 'darwin', spawnFn, log });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'dns-sd');
  assert.deepEqual(spawned[0].args, ['-R', 'poptart', SERVICE_TYPE, '.', '57160']);
  assert.equal(ad.pid, 4242, 'the pid the engine writes to its pidfile');
  assert.match(log.lines.log[0], /announced over Bonjour as "poptart"/);
});

test('stop() ends the dns-sd process, which withdraws the announcement, and is quiet about it', () => {
  const { spawned, spawnFn } = fakeSpawn();
  const log = quietLog();
  const ad = advertiseOsc(57160, { platform: 'darwin', spawnFn, log });
  ad.stop();
  ad.stop();
  assert.deepEqual(spawned[0].proc.killed, ['SIGTERM'], 'killed once, however often stop() is called');
  spawned[0].proc.emit('exit', null, 'SIGTERM');
  assert.deepEqual(log.lines.warn, [], 'an exit we asked for is not a complaint');
});

test('an announcer that dies on its own is reported', () => {
  const { spawned, spawnFn } = fakeSpawn();
  const log = quietLog();
  advertiseOsc(57160, { platform: 'darwin', spawnFn, log });
  spawned[0].proc.emit('exit', 1, null);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /Bonjour announcer exited/);
});

test('a missing dns-sd (asynchronous ENOENT) is a warning, not a crash', () => {
  const { spawned, spawnFn } = fakeSpawn();
  const log = quietLog();
  const ad = advertiseOsc(57160, { platform: 'darwin', spawnFn, log });
  spawned[0].proc.emit('error', new Error('spawn dns-sd ENOENT'));
  assert.match(log.lines.warn[0], /ENOENT/);
  ad.stop(); // still safe
});

test('off macOS it is a logged no-op with nothing to stop', () => {
  const { spawned, spawnFn } = fakeSpawn();
  const log = quietLog();
  const ad = advertiseOsc(57160, { platform: 'linux', spawnFn, log });
  assert.equal(spawned.length, 0);
  assert.equal(ad.pid, null);
  assert.match(log.lines.log[0], /not announced over Bonjour on linux/);
  ad.stop();
});

test('a spawn that throws synchronously is a warning too', () => {
  const log = quietLog();
  const ad = advertiseOsc(57160, { platform: 'darwin', spawnFn: () => { throw new Error('EACCES'); }, log });
  assert.equal(ad.pid, null);
  assert.match(log.lines.warn[0], /EACCES/);
});
