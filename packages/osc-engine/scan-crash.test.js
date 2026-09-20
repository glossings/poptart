// What the engine does when the audio server goes away during a plugin scan. The distinction
// being pinned is the one that costs a user a working plugin if it is got wrong: a server that
// DIED takes the plugin it was probing down with it, and that plugin gets skipped next time - but
// a server that was asked to quit (Ctrl-C, or an audio-device change, both perfectly ordinary
// things to do during a first scan) must leave nothing behind and say nothing.
//
// No sclang is spawned: the engine is driven by the text it would have read from one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OscEngine } = require('./index');
const { readJournal, claimCrashedProbe } = require('./plugin-scan');

// A port nothing else in the suite uses, and a fake sclang path so the constructor never goes
// looking for a real one.
function testEngine(journalFile) {
  const engine = new OscEngine({ nodePort: 57999, scPort: 57998, sclangPath: '/nonexistent/sclang' });
  engine._journalFile = journalFile;
  return engine;
}

function tmpJournal() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-crash-')), 'scan-journal.json');
}

// Swallows console.error/warn for the duration and hands back what was said.
function captureConsole(fn) {
  const said = [];
  const { error, warn } = console;
  console.error = (...a) => said.push(a.join(' '));
  console.warn = (...a) => said.push(a.join(' '));
  try {
    fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return said.join('\n');
}

test('a server that dies mid-scan is reported, with what was lost and who is suspected', () => {
  const file = tmpJournal();
  const engine = testEngine(file);
  engine._scan.total = 312;
  engine._scan.begin();
  engine._scan.feed('probing /Library/Audio/Plug-Ins/VST3/One.vst3... ok!\n');
  engine._scan.feed('probing /Library/Audio/Plug-Ins/VST3/Killer.vst3... ');

  const said = captureConsole(() => engine._watchServerDeath("Server 'poptart' exited with exit code 0.\n"));

  assert.match(said, /exited during the plugin scan, after 1 of 312/);
  assert.match(said, /NOT saved/, 'the cache is only written when a scan finishes - say so');
  assert.match(said, /Killer\.vst3/);
  assert.equal(engine.scanStatus().phase, 'died');
  assert.equal(engine.scanStatus().scanning, false);

  // ...and the next start skips it, because the death was witnessed and marked.
  assert.equal(readJournal({ file }).inFlight.path, '/Library/Audio/Plug-Ins/VST3/Killer.vst3');
  assert.equal(readJournal({ file }).inFlight.crashed, true);
  assert.equal(claimCrashedProbe({ file }).crashed.path, '/Library/Audio/Plug-Ins/VST3/Killer.vst3');
});

test('quitting during a scan blames nobody and leaves nothing recorded', async () => {
  const file = tmpJournal();
  const engine = testEngine(file);
  engine._scan.begin();
  engine._scan.feed('probing /Library/Audio/Plug-Ins/VST3/Innocent.vst3... ');
  assert.equal(readJournal({ file }).inFlight.path, '/Library/Audio/Plug-Ins/VST3/Innocent.vst3');

  await engine.stop();
  const said = captureConsole(() => engine._watchServerDeath("Server 'poptart' exited with exit code 0.\n"));

  assert.equal(said, '', 'nothing alarming was printed');
  assert.equal(engine.scanStatus().phase, 'stopped');
  assert.equal(readJournal({ file }).inFlight, null, 'the innocent plugin is not skipped next time');
  assert.equal(claimCrashedProbe({ file }).crashed, null);
});

test('an engine that was never started keeps its hands off the real journal', async () => {
  // Every unit test that builds an engine, and any host that stops one it never started.
  const engine = new OscEngine({ nodePort: 57999, scPort: 57998, sclangPath: '/nonexistent/sclang' });
  const wrote = [];
  const { writeFileSync } = fs;
  fs.writeFileSync = (file, ...rest) => {
    wrote.push(String(file));
    return writeFileSync(file, ...rest);
  };
  try {
    engine._scan.feed('probing /a/One.vst3... ok!\n');
    await engine.stop();
  } finally {
    fs.writeFileSync = writeFileSync;
  }
  assert.deepEqual(wrote.filter((w) => w.includes('scan-journal')), []);
});

test('a server dying when no scan is running says nothing about scans', () => {
  const engine = testEngine(tmpJournal());
  const said = captureConsole(() => engine._watchServerDeath("Server 'poptart' exited with exit code 0.\n"));
  assert.equal(said, '');
  assert.equal(engine.scanStatus().phase, 'idle');
});

test('unrelated engine output is not read as a death', () => {
  const engine = testEngine(tmpJournal());
  engine._scan.begin();
  const said = captureConsole(() => {
    engine._watchServerDeath('poptart: server booted, ready\n');
    engine._watchServerDeath('probing /a/One.vst3... ok!\n');
  });
  assert.equal(said, '');
  assert.equal(engine.scanStatus().scanning, true);
});
