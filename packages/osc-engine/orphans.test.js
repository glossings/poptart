// Reaping engine processes left over from a run that didn't shut down cleanly. What's pinned here
// is the safety property the whole module hangs on: it only ever kills a pid that is STILL one of
// ours. Everything else - a recycled pid, a dead pid, a corrupt pidfile - has to be a silent no-op,
// because the alternative to a port conflict is SIGKILLing a stranger's process.
//
// The real process table is never touched: `comm` and `kill` are injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orphans = require('./orphans');

// A fake process table: pid -> command name (absent = not running).
function table(entries) {
  return (pid) => entries[pid] ?? null;
}

// Collects the pids a run tried to kill.
function recorder() {
  const killed = [];
  return { killed, kill: (pid) => killed.push(pid) };
}

function tmpPidfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-orphans-')), 'engine.pid');
}

test('isOurProcess() accepts only live sclang/scsynth pids', () => {
  const comm = table({ 100: 'sclang', 101: '/usr/local/bin/scsynth', 102: 'supernova', 103: 'Google Chrome' });
  assert.equal(orphans.isOurProcess(100, { comm }), true);
  assert.equal(orphans.isOurProcess(101, { comm }), true, 'ps reports a full path; the basename is what matches');
  assert.equal(orphans.isOurProcess(102, { comm }), true);
  assert.equal(orphans.isOurProcess(103, { comm }), false, 'a recycled pid belonging to something else');
  assert.equal(orphans.isOurProcess(999, { comm }), false, 'not running at all');
});

test('isOurProcess() rejects pids that could never be one of ours', () => {
  const comm = () => 'sclang'; // even if the table would say yes
  for (const pid of [0, 1, -5, null, undefined, 1.5, '100']) {
    assert.equal(orphans.isOurProcess(pid, { comm }), false, `${pid} must never be killable`);
  }
});

test('killIfOurs() kills a live engine process and reports it', () => {
  const { killed, kill } = recorder();
  const comm = table({ 100: 'scsynth' });
  assert.equal(orphans.killIfOurs(100, { comm, kill }), true);
  assert.deepEqual(killed, [100]);
});

test('killIfOurs() leaves a recycled pid alone', () => {
  const { killed, kill } = recorder();
  const comm = table({ 100: 'ssh' });
  assert.equal(orphans.killIfOurs(100, { comm, kill }), false);
  assert.deepEqual(killed, [], 'nothing that is not ours may be signalled');
});

test('killIfOurs() survives the process exiting between the check and the kill', () => {
  const comm = table({ 100: 'sclang' });
  const kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.equal(orphans.killIfOurs(100, { comm, kill }), false);
});

test('recorded pids round-trip through the pidfile', () => {
  const file = tmpPidfile();
  orphans.recordEnginePids({ sclang: 100, scsynth: 101 }, { file });
  assert.deepEqual(orphans.readEnginePids({ file }), { sclang: 100, scsynth: 101 });
  orphans.clearEnginePids({ file });
  assert.deepEqual(orphans.readEnginePids({ file }), {}, 'a cleared pidfile leaves nothing to reap');
});

test('readEnginePids() treats a missing or corrupt pidfile as nothing to do', () => {
  const file = tmpPidfile();
  assert.deepEqual(orphans.readEnginePids({ file }), {});
  fs.writeFileSync(file, 'not json at all', 'utf8');
  assert.deepEqual(orphans.readEnginePids({ file }), {});
});

test('reapOrphanedEngine() kills scsynth before sclang', () => {
  // Order matters: scsynth is the one holding the audio device and the UDP port, and killing
  // sclang first would leave it orphaned for the length of the call.
  const file = tmpPidfile();
  orphans.recordEnginePids({ sclang: 100, scsynth: 101 }, { file });
  const { killed, kill } = recorder();
  const comm = table({ 100: 'sclang', 101: 'scsynth' });
  const reaped = orphans.reapOrphanedEngine({ file, comm, kill });
  assert.deepEqual(killed, [101, 100]);
  assert.deepEqual(reaped, ['scsynth (pid 101)', 'sclang (pid 100)']);
});

test('reapOrphanedEngine() kills only what is actually left behind', () => {
  // The ordinary case after a clean shutdown that raced: sclang exited, scsynth didn't.
  const file = tmpPidfile();
  orphans.recordEnginePids({ sclang: 100, scsynth: 101 }, { file });
  const { killed, kill } = recorder();
  const reaped = orphans.reapOrphanedEngine({ file, comm: table({ 101: 'scsynth' }), kill });
  assert.deepEqual(killed, [101]);
  assert.deepEqual(reaped, ['scsynth (pid 101)']);
});

test('reapOrphanedEngine() forgets the pids even when it killed nothing', () => {
  // Otherwise a pidfile naming pids that have since been recycled would be re-examined - and
  // re-risked - on every single engine start for the life of the machine.
  const file = tmpPidfile();
  orphans.recordEnginePids({ sclang: 100, scsynth: 101 }, { file });
  const { killed, kill } = recorder();
  assert.deepEqual(orphans.reapOrphanedEngine({ file, comm: table({}), kill }), []);
  assert.deepEqual(killed, []);
  assert.deepEqual(orphans.readEnginePids({ file }), {});
});

test('reapOrphanedEngine() is a no-op on a first-ever run', () => {
  const { killed, kill } = recorder();
  const reaped = orphans.reapOrphanedEngine({ file: tmpPidfile(), comm: table({}), kill });
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
});

test('pidfilePath() is per stack, so two poptarts never reap each other', () => {
  // A test run beside a live session, or a second session on other ports, must not have its
  // startup reap SIGKILL the other one's healthy engine.
  assert.notEqual(orphans.pidfilePath(57140), orphans.pidfilePath(57240));
  assert.match(orphans.pidfilePath(57140), /engine-57140\.pid$/);
});

test('commandName() reports this process and nothing for a dead pid', () => {
  // The one test that touches the real process table - it reads, it never kills.
  assert.match(orphans.commandName(process.pid), /node/i);
  assert.equal(orphans.commandName(2147483646), null, 'an unused pid is not running');
});
