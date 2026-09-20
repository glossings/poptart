// The engine's file log. Its reason for existing is the last few lines before a crash, so what
// is pinned here is that those lines are on disk the moment they are written, that the previous
// run is still readable after a new one starts, and that nothing about logging can stop an
// engine from booting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openEngineLog, tailEngineLog, engineLogPath } = require('./engine-log');

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-log-')), 'engine.log');
}

test('output is on disk before anything is closed - a crash keeps what it had written', () => {
  const file = tmpLog();
  const log = openEngineLog({ file });
  log.write('probing /a/Killer.vst3... ');
  assert.equal(fs.readFileSync(file, 'utf8'), 'probing /a/Killer.vst3... ');
  log.close();
});

test('poptart notes are timestamped and interleave with the engine output', () => {
  const file = tmpLog();
  const log = openEngineLog({ file });
  log.note('engine starting');
  log.write('poptart: booting scsynth\n');
  log.note('plugin scan started');
  log.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\[\d{4}-\d\d-\d\dT[^\]]+\] engine starting\n/);
  assert.match(text, /booting scsynth\n\[[^\]]+\] plugin scan started\n/);
});

test('the previous run is kept, because the interesting run is usually the one that died', () => {
  const file = tmpLog();
  const first = openEngineLog({ file });
  first.write('the run that crashed\n');
  first.close();

  const second = openEngineLog({ file });
  second.write('the run after it\n');
  second.close();

  assert.equal(fs.readFileSync(file, 'utf8'), 'the run after it\n');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'the run that crashed\n');
});

test('a log that cannot be opened is silent, not fatal', () => {
  // A file where the log's parent directory should be, so even creating it fails. The engine
  // still boots; a log that couldn't be opened just writes nowhere.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-log-'));
  fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory');
  const file = path.join(dir, 'blocked', 'engine.log');
  const log = openEngineLog({ file });
  assert.equal(log.path, null);
  assert.doesNotThrow(() => {
    log.write('anything');
    log.note('anything');
    log.close();
  });
});

test('a runaway log stops growing instead of filling the disk', () => {
  const file = tmpLog();
  const log = openEngineLog({ file, maxBytes: 64 });
  log.write('x'.repeat(50));
  log.write('y'.repeat(50));
  log.write('z'.repeat(50));
  log.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /log size limit reached/);
  assert.ok(!text.includes('z'.repeat(50)));
});

test('the tail is what doctor attaches, and a missing log tails to nothing', () => {
  const file = tmpLog();
  const log = openEngineLog({ file });
  for (let i = 0; i < 500; i += 1) log.write(`line ${i}\n`);
  log.close();
  const tail = tailEngineLog({ file, lines: 10 });
  assert.match(tail, /line 499/);
  assert.ok(!tail.includes('line 100\n'));
  assert.equal(tailEngineLog({ file: '/nowhere/engine.log' }), '');
});

test('the default lives in ~/.poptart, beside the rest of the engine state', () => {
  assert.equal(engineLogPath(), path.join(os.homedir(), '.poptart', 'engine.log'));
});
