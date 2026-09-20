'use strict';

// link.js - the Node side of the Ableton Link peer. The peer itself is a helper process, so what
// is tested here is the conversation with it: commands go out as one JSON line each, state lines
// come back parsed (including when they arrive split across reads, which a pipe is free to do),
// junk on the channel is survivable, and stop() closes the helper down.
//
// A fake helper stands in for the real binary throughout, so no test here joins a Link session or
// touches the network. The committed binary gets its own read-only smoke test at the bottom.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { joinLink, helperAvailable, HELPER } = require('./link');

/** A stand-in for the spawned helper: records what was written, lets a test push lines back. */
function fakeHelper() {
  const proc = new EventEmitter();
  proc.written = [];
  proc.stdin = { writable: true, write: (s) => proc.written.push(s), end: () => { proc.stdin.writable = false; } };
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.killed = null;
  proc.kill = (sig) => { proc.killed = sig; };
  return proc;
}

function joinFake(opts = {}) {
  const proc = fakeHelper();
  const link = joinLink({ spawnFn: () => proc, ...opts });
  const states = [];
  link.onState = (s) => states.push(s);
  return { link, proc, states };
}

test('joining sends the quantum, and commands go out one JSON line each', () => {
  const { link, proc } = joinFake();
  assert.deepEqual(JSON.parse(proc.written[0]), { quantum: 4 });

  link.setTempo(137.5);
  link.setPlaying(true);
  link.setPlaying(true, 0); // a start that asks to land on a bar line
  link.setPlaying(false);
  const sent = proc.written.slice(1);
  assert.ok(sent.every((line) => line.endsWith('\n')), 'every command must be one line');
  assert.deepEqual(sent.map((l) => JSON.parse(l)), [
    { tempo: 137.5 },
    { playing: true },
    { playing: true, beat: 0 },
    { playing: false },
  ]);
});

test('state lines are parsed, whole or split across reads', () => {
  const { proc, states } = joinFake();
  proc.stdout.emit('data', '{"bpm":128,"beats":41.5,"peers":2,"playing":true,"at":1757000000.5}\n');
  assert.deepEqual(states, [{ bpm: 128, beats: 41.5, atSec: 1757000000.5, peers: 2, playing: true }]);

  // A pipe may hand over half a line, then the rest with the next one attached.
  states.length = 0;
  proc.stdout.emit('data', '{"bpm":90,"beats":1,"peers":0,');
  assert.deepEqual(states, [], 'half a line is not a state');
  proc.stdout.emit('data', '"playing":false,"at":2}\n{"bpm":91,"beats":2,"peers":1,"playing":false,"at":3}\n');
  assert.deepEqual(states.map((s) => s.bpm), [90, 91]);
});

test('junk on the channel is skipped, not fatal', () => {
  const { proc, states } = joinFake();
  proc.stdout.emit('data', 'a warning from some future SDK\n');
  proc.stdout.emit('data', '{"not":"a state"}\n');
  proc.stdout.emit('data', '\n');
  proc.stdout.emit('data', '{"bpm":120,"beats":0,"peers":0,"playing":false,"at":1}\n');
  assert.deepEqual(states.map((s) => s.bpm), [120]);
});

test('stop() closes the helper down and silences later commands', () => {
  const { link, proc } = joinFake();
  const before = proc.written.length;
  link.stop();
  assert.equal(proc.killed, 'SIGTERM');
  link.setTempo(150);
  assert.equal(proc.written.length, before, 'nothing may be written after stop()');
  link.stop(); // idempotent
});

test('an exit is reported once, but not the one stop() asked for', () => {
  const errors = [];
  const { link, proc } = joinFake({ onError: (e) => errors.push(e.message) });
  proc.emit('exit', 1, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exited/);

  const clean = joinFake({ onError: (e) => errors.push(e.message) });
  clean.link.stop();
  clean.proc.emit('exit', null, 'SIGTERM');
  assert.equal(errors.length, 1, 'a helper we killed ourselves is not an error');
  link.stop();
});

test('a helper that will not spawn leaves a handle that does nothing', () => {
  const errors = [];
  const link = joinLink({
    spawnFn: () => { throw new Error('ENOENT'); },
    onError: (e) => errors.push(e.message),
  });
  assert.deepEqual(errors, ['ENOENT']);
  link.setTempo(120); // no throw
  link.setPlaying(true);
  link.stop();
});

test('helperAvailable is false off macOS whatever is on disk', () => {
  // The helper is committed, so the macOS binary exists in a Windows or Linux checkout too -
  // the file being there says nothing about whether it can run here.
  assert.equal(helperAvailable(), process.platform === 'darwin' && fs.existsSync(HELPER));
});

test('helperAvailable answers for a path that is not there', () => {
  assert.equal(helperAvailable(path.join(__dirname, 'native', 'link', 'bin', 'no-such-helper')), false);
});

// The committed binary itself: does it start and speak the protocol? Read-only on purpose - this
// runs on whatever network the machine is on, and a test that pushed a tempo could retune a DAW
// somebody has open. Skipped where the helper isn't built (a platform build.sh has never run on).
test('the committed helper starts and reports the session', { timeout: 15000 }, async (t) => {
  if (!helperAvailable()) {
    t.skip(`no helper built at ${HELPER}`);
    return;
  }
  const link = joinLink();
  try {
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no state line within 5s')), 5000);
      link.onState = (s) => { clearTimeout(timer); resolve(s); };
    });
    assert.ok(state.bpm > 0, `a tempo: ${state.bpm}`);
    assert.ok(Number.isFinite(state.beats), 'a beat count');
    assert.ok(Math.abs(state.atSec - Date.now() / 1000) < 5, 'stamped on the same clock the host reads');
    assert.equal(typeof state.playing, 'boolean');
    assert.ok(state.peers >= 0);
  } finally {
    link.stop();
  }
});
