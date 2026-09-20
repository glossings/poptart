// Reading the plugin scan's progress out of the engine's log, which is the only place it exists:
// VSTPlugin hands back a search's results only when the whole search returns. The lines here are
// real ones - VSTPlugin prints "probing <path>... " with no newline and the result word lands
// later, often in a different read from the pipe, so the chunk boundaries below are the point.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ScanProgress } = require('./scan-progress');

function feed(progress, ...chunks) {
  for (const c of chunks) progress.feed(c);
  return progress.snapshot();
}

test('a probe is counted when its result arrives, not when it starts', () => {
  const p = new ScanProgress({ total: 3 });
  p.begin();
  feed(p, 'probing /Library/Audio/Plug-Ins/VST3/Diva.vst3... ');
  assert.equal(p.snapshot().current, '/Library/Audio/Plug-Ins/VST3/Diva.vst3');
  assert.equal(p.snapshot().probed, 0);
  feed(p, 'ok!\n');
  assert.equal(p.snapshot().probed, 1);
  assert.equal(p.snapshot().current, null);
  assert.equal(p.snapshot().failed, 0);
});

test('the name and its result arriving in one chunk is the same thing', () => {
  const p = new ScanProgress({ total: 1 });
  p.begin();
  feed(p, 'probing /a/Diva.vst3... ok!\n');
  assert.equal(p.snapshot().probed, 1);
  assert.equal(p.snapshot().current, null);
});

test('a failed probe is counted separately, and the scan carries on', () => {
  const p = new ScanProgress();
  p.begin();
  feed(p, 'probing /a/One.vst3... ', 'crashed!\n', 'probing /a/Two.vst3... ', "couldn't load! no such file\n");
  const at = feed(p, 'probing /a/Three.vst3... ', 'ok!\n');
  assert.equal(at.probed, 3);
  assert.equal(at.failed, 2);
});

test('the plugin being probed is known while it is being probed - which is when a plugin puts a window up', () => {
  // A plugin asking to be activated stopped a scan dead for fifteen minutes on a machine nobody
  // was watching. The name of what it is waiting on is the whole difference between "hung" and
  // "go and click Quit".
  const p = new ScanProgress();
  p.begin();
  feed(p, 'probing /a/MORPH.vst3... ');
  assert.equal(p.snapshot().current, '/a/MORPH.vst3');
  assert.equal(p.snapshot().scanning, true);
});

test('the journal is told about each probe, so a scan that dies names its suspect', () => {
  const started = [];
  const ended = [];
  const p = new ScanProgress({ onProbeStart: (x) => started.push(x), onProbeEnd: (x) => ended.push(x) });
  p.begin();
  feed(p, 'probing /a/One.vst3... ', 'ok!\nprobing /a/Two.vst3... ');
  assert.deepEqual(started, ['/a/One.vst3', '/a/Two.vst3']);
  assert.deepEqual(ended, ['/a/One.vst3'], 'the second is still in flight - that is the one a crash would strand');
});

test('a probe announced twice (tail, then full line) is one probe', () => {
  const p = new ScanProgress();
  p.begin();
  // The same text can be seen first as an unterminated tail and then again as a complete line.
  p.feed('probing /a/One.vst3... ');
  p.feed('ok!\n');
  assert.equal(p.snapshot().probed, 1);
});

test('folder and total lines are picked up for the display', () => {
  const p = new ScanProgress({ total: 12 });
  p.begin();
  feed(p, "VSTPlugin: searching in '/Library/Audio/Plug-Ins/VST3'...\n");
  assert.equal(p.snapshot().dir, '/Library/Audio/Plug-Ins/VST3');
  feed(p, 'Found 9 plugins.\n');
  assert.equal(p.snapshot().found, 9);
});

test('several folders add up, because the scan runs one search per folder', () => {
  const p = new ScanProgress();
  p.begin();
  feed(p, 'Found 4 plugins.\n', 'Found 5 plugins.\n');
  assert.equal(p.snapshot().found, 9);
});

test('plugins already in the cache count as progress, or a warm rescan reads 0/407 throughout', () => {
  // VSTPlugin doesn't probe what it already knows: it prints the bare path and moves on.
  const p = new ScanProgress({ total: 3 });
  p.begin();
  feed(p, '/Library/Audio/Plug-Ins/VST3/Diva.vst3\n', 'C:/Program Files/Common Files/VST3/Serum.vst3\n');
  feed(p, 'probing /Library/Audio/Plug-Ins/VST3/New.vst3... ok!\n');
  assert.equal(p.snapshot().probed, 3);
  assert.equal(p.snapshot().current, null, 'a cached plugin is never "being probed"');
  // ...but a path inside some other sentence is not a plugin line,
  feed(p, "VSTPlugin: searching in '/Library/Audio/Plug-Ins/VST3'...\n", 'loaded /a/thing.vst3 fine\n');
  assert.equal(p.snapshot().probed, 3);
});

test('a path line outside a scan is not counted', () => {
  const p = new ScanProgress();
  feed(p, '/Library/Audio/Plug-Ins/VST3/Diva.vst3\n');
  assert.equal(p.snapshot().probed, 0);
  assert.equal(p.snapshot().scanning, false);
});

test('finished folders are counted, which is the cue to refetch the plugin list', () => {
  const p = new ScanProgress();
  p.folderDone(1);
  assert.equal(p.snapshot().foldersDone, 0, 'not during a scan, not counted');
  p.begin();
  p.folderDone(1);
  p.folderDone(2);
  assert.equal(p.snapshot().foldersDone, 2);
  p.end();
  p.begin();
  assert.equal(p.snapshot().foldersDone, 0, 'a new scan starts from none');
});

test('a scan is not running until it starts, and is over when it ends', () => {
  const p = new ScanProgress({ total: 2 });
  assert.equal(p.snapshot().scanning, false);
  assert.equal(p.snapshot().phase, 'idle');
  p.begin();
  assert.equal(p.snapshot().scanning, true);
  p.end({ found: 2 });
  assert.equal(p.snapshot().phase, 'done');
  assert.equal(p.snapshot().found, 2);
  assert.equal(p.snapshot().current, null);
});

test('a probing line with no scan started implies one, because the log is the more reliable witness', () => {
  const p = new ScanProgress();
  feed(p, 'probing /a/One.vst3... ');
  assert.equal(p.snapshot().scanning, true);
});

test('a scan the server died in keeps its counts and its suspect', () => {
  const p = new ScanProgress({ total: 40 });
  p.begin();
  feed(p, 'probing /a/One.vst3... ', 'ok!\n', 'probing /a/Two.vst3... ');
  const died = p.abort('the audio server exited during the scan');
  assert.equal(died.phase, 'died');
  assert.equal(died.probed, 1);
  assert.equal(died.current, '/a/Two.vst3', 'still named, because that name is the whole point');
  assert.equal(p.snapshot().scanning, false);
  assert.equal(p.abort(), null, 'a second death is not a death');
});

test('a scan poptart itself stopped is not reported as a death', () => {
  // Quitting during the first scan, or changing the audio device, both land here - the work is
  // lost either way, but nobody did anything wrong and no plugin is to blame.
  const p = new ScanProgress({ total: 40 });
  p.begin();
  feed(p, 'probing /a/One.vst3... ', 'ok!\n', 'probing /a/Two.vst3... ');
  const stopped = p.cancel();
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.current, null, 'nothing is left under suspicion');
  assert.equal(p.cancel(), null);
});

test('changes are announced, which is what drives the editor', () => {
  const seen = [];
  const p = new ScanProgress({ total: 2, onChange: (s) => seen.push(s.probed) });
  p.begin();
  feed(p, 'probing /a/One.vst3... ok!\n');
  assert.ok(seen.includes(1));
});

test('a line that is not about probing changes nothing', () => {
  const p = new ScanProgress();
  p.begin();
  feed(p, 'poptart: booting scsynth\n', 'JackDriver: max output latency 21.3 ms\n');
  assert.equal(p.snapshot().probed, 0);
  assert.equal(p.snapshot().current, null);
});

test('a plugin printing megabytes of its own cannot grow the buffer without bound', () => {
  const p = new ScanProgress();
  p.begin();
  p.feed('x'.repeat(200000));
  assert.ok(p._buf.length < 64 * 1024);
});
