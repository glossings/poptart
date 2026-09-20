// What the plugin scan is allowed to touch. The property that matters most is the negative one:
// a file that has a plugin extension but isn't a binary this machine could load must never reach
// VSTPlugin, because probing one segfaults scsynth before anything can catch it (see the module
// header). The rest is progress counting and the journal that survives a scan dying.
//
// Real files in a temp tree, with real magic bytes: the whole check is "what are the first four
// bytes", and a mock of that would be a mock of the only thing being tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scan = require('./plugin-scan');

const MAGIC = {
  macho: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // 64-bit Mach-O, little-endian
  machoFat: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // universal binary
  pe: Buffer.from('MZ\u0090\u0000', 'binary'), // Windows DLL/EXE
  elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  text: Buffer.from('these are my notes about the plugin\n'),
};

function tmpTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-scan-'));
}

function writeFile(file, magic) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, magic);
  return file;
}

// A macOS-style plugin bundle: a DIRECTORY whose name ends in .vst3, with the binary inside.
function writeBundle(dir, magic = MAGIC.macho) {
  const name = path.basename(dir, path.extname(dir));
  writeFile(path.join(dir, 'Contents', 'MacOS', name), magic);
  return dir;
}

test('a plain file with a plugin extension is excluded when it is not a binary this machine can load', () => {
  const root = tmpTree();
  const windowsDll = writeFile(path.join(root, 'phasereplicant.vst3'), MAGIC.pe);
  const notes = writeFile(path.join(root, 'notes.vst3'), MAGIC.text);
  writeBundle(path.join(root, 'Diva.vst3'));

  const { plugins, foreign } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });

  assert.equal(plugins.length, 3, 'all three are candidates as far as VSTPlugin is concerned');
  assert.deepEqual(
    foreign.map((f) => f.path).sort(),
    [notes, windowsDll].sort(),
    'the PE file and the text file are the ones that would take scsynth down',
  );
  assert.equal(foreign.find((f) => f.path === windowsDll).format, 'pe');
  assert.equal(foreign.find((f) => f.path === notes).format, 'unknown');
});

test('a bundle is never opened up, and a real native plugin is never excluded', () => {
  const root = tmpTree();
  const bundle = writeBundle(path.join(root, 'Diva.vst3'));
  // A bundle's own binary has no plugin extension, so it must not be counted as a plugin - and
  // the walk must not descend into the bundle to find it in the first place.
  const { plugins, foreign } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });
  assert.deepEqual(plugins, [bundle]);
  assert.deepEqual(foreign, []);
});

test('the same file is normal on the platform it belongs to', () => {
  const root = tmpTree();
  writeFile(path.join(root, 'Serum.dll'), MAGIC.pe);
  writeFile(path.join(root, 'Serum.vst3'), MAGIC.pe);
  // On Windows a plugin IS a plain PE file - excluding one would be excluding everything.
  const win = scan.walkPluginDirs({ dirs: [root], platform: 'win32' });
  assert.deepEqual(win.foreign, []);
  assert.equal(win.plugins.length, 2);
  // ...and on macOS both of those are foreign (.dll isn't even a plugin extension there).
  const mac = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });
  assert.deepEqual(mac.foreign.map((f) => f.path), [path.join(root, 'Serum.vst3')]);
});

test('a universal binary counts as native on macOS', () => {
  const root = tmpTree();
  writeFile(path.join(root, 'Old.vst'), MAGIC.machoFat);
  assert.deepEqual(scan.walkPluginDirs({ dirs: [root], platform: 'darwin' }).foreign, []);
});

test('an ELF object is native on Linux - and so is a PE file, which a Wine-enabled VSTPlugin hosts', () => {
  const root = tmpTree();
  const so = writeFile(path.join(root, 'plug.so'), MAGIC.elf);
  const winVst3 = writeFile(path.join(root, 'Serum.vst3'), MAGIC.pe);
  const mac = writeFile(path.join(root, 'Mac.vst3'), MAGIC.macho);
  const walk = scan.walkPluginDirs({ dirs: [root], platform: 'linux' });
  assert.deepEqual(walk.plugins.sort(), [mac, winVst3, so].sort());
  assert.deepEqual(walk.foreign.map((f) => f.path), [mac], 'excluding a loadable plugin is the worse mistake');
});

test('hidden files are checked too, because VSTPlugin probes them too', () => {
  // macOS leaves an AppleDouble "._Name.vst3" beside anything unzipped or copied from a non-Mac
  // volume: a small plain file with a plugin extension and no binary in it - precisely the shape
  // that crashes the scan. VSTPlugin's walk does not skip dotfiles, so neither may this one.
  const root = tmpTree();
  writeBundle(path.join(root, 'Serum.vst3'));
  const appleDouble = writeFile(path.join(root, '._Serum.vst3'), Buffer.from([0x00, 0x05, 0x16, 0x07, 0, 2, 0, 0]));
  const { foreign } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });
  assert.deepEqual(foreign.map((f) => f.path), [appleDouble]);
});

test('vendor folders are walked, and the count is what the progress display divides by', () => {
  const root = tmpTree();
  writeBundle(path.join(root, 'u-he', 'Diva.vst3'));
  writeBundle(path.join(root, 'u-he', 'Zebra.vst3'));
  writeBundle(path.join(root, 'Xfer', 'Serum.vst3'));
  fs.mkdirSync(path.join(root, 'empty-vendor'));
  fs.writeFileSync(path.join(root, 'u-he', 'readme.txt'), 'hello');

  const { plugins } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });
  assert.equal(plugins.length, 3);
});

test('symlinks are followed (the curated ~/.poptart/plugins folder is nothing else) without looping', () => {
  const root = tmpTree();
  const real = writeBundle(path.join(root, 'real', 'Diva.vst3'));
  const curated = path.join(root, 'curated');
  fs.mkdirSync(curated);
  fs.symlinkSync(real, path.join(curated, 'Diva.vst3'));
  fs.symlinkSync(curated, path.join(curated, 'loop')); // a folder that contains itself

  const { plugins } = scan.walkPluginDirs({ dirs: [curated], platform: 'darwin' });
  assert.deepEqual(plugins, [path.join(curated, 'Diva.vst3')]);
});

test('an already-excluded path is not walked or re-reported', () => {
  const root = tmpTree();
  const bad = writeFile(path.join(root, 'phasereplicant.vst3'), MAGIC.pe);
  const { foreign } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin', exclude: [bad] });
  assert.deepEqual(foreign, []);
});

test('a broken symlink is left for VSTPlugin to shrug at rather than excluded', () => {
  const root = tmpTree();
  fs.symlinkSync(path.join(root, 'gone.vst3'), path.join(root, 'Ghost.vst3'));
  const { plugins, foreign } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin' });
  assert.deepEqual(foreign, []);
  assert.deepEqual(plugins, []);
});

test('the walk stops at its entry limit instead of chewing through a wrong directory', () => {
  const root = tmpTree();
  for (let i = 0; i < 20; i += 1) writeFile(path.join(root, `p${i}.vst3`), MAGIC.macho);
  const { plugins, truncated } = scan.walkPluginDirs({ dirs: [root], platform: 'darwin', maxEntries: 5 });
  assert.ok(truncated);
  assert.ok(plugins.length <= 5);
});

// --- path lists ---

test("path lists split on the platform's own delimiter, so Windows drive letters survive", () => {
  assert.deepEqual(scan.splitPathList('C:\\Program Files\\VST3;D:\\Plugins', 'win32'), [
    'C:\\Program Files\\VST3',
    'D:\\Plugins',
  ]);
  assert.deepEqual(scan.splitPathList('/a/b:/c/d', 'darwin'), ['/a/b', '/c/d']);
  assert.deepEqual(scan.splitPathList('', 'darwin'), []);
  assert.deepEqual(scan.splitPathList(undefined, 'darwin'), []);
});

test('search directories: explicit first, then the curated folder, then the standard locations', () => {
  const home = tmpTree();
  const explicit = path.join(home, 'my-plugins');
  fs.mkdirSync(explicit);
  assert.deepEqual(
    scan.resolveSearchDirs({ env: { POPTART_VST_DIRS: explicit }, home, platform: 'darwin' }),
    [explicit],
    'an explicit list wins, existing or not - it is a deliberate instruction',
  );

  const curated = path.join(home, '.poptart', 'plugins');
  fs.mkdirSync(curated, { recursive: true });
  assert.deepEqual(scan.resolveSearchDirs({ env: {}, home, platform: 'darwin' }), [curated]);

  fs.rmSync(curated, { recursive: true });
  const standard = scan.resolveSearchDirs({ env: {}, home, platform: 'darwin' });
  // With no curated folder it falls back to the standard locations, filtered to the ones that
  // are really there - an empty result is the honest answer on a machine with no plugins, and
  // what tells the engine to leave VSTPlugin's own defaults alone.
  assert.ok(standard.every((d) => fs.existsSync(d)));
  assert.ok(!standard.some((d) => d.startsWith(home)), 'this fake home has none of them');
});

test('the default locations are the ones VSTPlugin compiles in', () => {
  const mac = scan.defaultPluginDirs({ platform: 'darwin', home: '/Users/x', env: {} });
  assert.ok(mac.includes('/Library/Audio/Plug-Ins/VST3'));
  assert.ok(mac.includes('/Users/x/Library/Audio/Plug-Ins/VST'));

  const win = scan.defaultPluginDirs({
    platform: 'win32',
    home: 'C:\\Users\\x',
    env: { ProgramW6432: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
  });
  assert.ok(win.some((d) => d.endsWith('Common Files\\VST3')));
  assert.ok(win.some((d) => d.startsWith('C:\\Program Files (x86)')), 'the bridge hosts 32-bit plugins too');

  const linux = scan.defaultPluginDirs({ platform: 'linux', home: '/home/x', env: {} });
  assert.ok(linux.includes('/home/x/.vst3'));
});

// --- the journal ---

function tmpJournal() {
  return path.join(tmpTree(), 'scan-journal.json');
}

test('a probe the engine watched the server die on is skipped from the next start onwards', () => {
  const file = tmpJournal();
  scan.noteProbe('/plugins/Killer.vst3', { file });
  scan.markProbeCrashed({ file });

  const { crashed, skip } = scan.claimCrashedProbe({ file });
  assert.equal(crashed.path, '/plugins/Killer.vst3');
  assert.deepEqual(skip.map((s) => s.path), ['/plugins/Killer.vst3']);

  // ...and it stays skipped on every later start, without being reported as a fresh crash.
  const second = scan.claimCrashedProbe({ file });
  assert.equal(second.crashed, null);
  assert.deepEqual(second.skip.map((s) => s.path), ['/plugins/Killer.vst3']);
});

test('a probe left in flight with no witnessed death convicts nobody', () => {
  // poptart itself went away mid-probe: the terminal was closed, the dev server restarted, the
  // power went. None of that is the plugin's fault, and skipping a working plugin on that
  // evidence would be worse than the problem the journal exists for.
  const file = tmpJournal();
  scan.noteProbe('/plugins/Innocent.vst3', { file });
  const { crashed, skip } = scan.claimCrashedProbe({ file });
  assert.equal(crashed, null);
  assert.deepEqual(skip, []);
  assert.equal(scan.readJournal({ file }).inFlight, null, 'and the leftover is cleared');
});

test('clearing a journal that was never written does not create one', () => {
  const file = tmpJournal();
  scan.noteProbe(null, { file });
  assert.equal(fs.existsSync(file), false);
});

test('a probe that finished leaves nothing behind', () => {
  const file = tmpJournal();
  scan.noteProbe('/plugins/Fine.vst3', { file });
  scan.noteProbeDone('/plugins/Fine.vst3', { file });
  assert.equal(scan.claimCrashedProbe({ file }).crashed, null);
  assert.equal(scan.readJournal({ file }).lastDone, '/plugins/Fine.vst3');
});

test('the skip list can be emptied to try the offenders again', () => {
  const file = tmpJournal();
  scan.noteProbe('/plugins/A.vst3', { file });
  scan.markProbeCrashed({ file });
  scan.claimCrashedProbe({ file });
  assert.equal(scan.forgetSkips({ file }), 1);
  assert.deepEqual(scan.readJournal({ file }).skip, []);
});

test('a missing or corrupt journal reads as an empty one rather than throwing', () => {
  assert.deepEqual(scan.readJournal({ file: '/nope/nowhere.json' }), { inFlight: null, skip: [], lastDone: null });
  const file = tmpJournal();
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(scan.readJournal({ file }).skip, []);
});

// --- everything together ---

test('preparePluginScan hands the engine one list of folders and one list of exclusions', () => {
  const home = tmpTree();
  const dir = path.join(home, '.poptart', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const bad = writeFile(path.join(dir, 'phasereplicant.vst3'), MAGIC.pe);
  writeBundle(path.join(dir, 'Diva.vst3'));
  const journalFile = path.join(home, '.poptart', 'scan-journal.json');
  scan.noteProbe('/plugins/Killer.vst3', { file: journalFile });
  scan.markProbeCrashed({ file: journalFile });

  const prepared = scan.preparePluginScan({ platform: 'darwin', env: { POPTART_VST_EXCLUDE: '/mine/Skip.vst3' }, home });

  assert.deepEqual(prepared.dirs, [dir]);
  assert.ok(prepared.exclude.includes(bad), 'the crasher');
  assert.ok(prepared.exclude.includes('/plugins/Killer.vst3'), "the last scan's killer");
  assert.ok(prepared.exclude.includes('/mine/Skip.vst3'), "the user's own");
  assert.equal(prepared.plugins.length, 2, 'both are still counted - VSTPlugin would have probed both');
  assert.equal(prepared.crashed.path, '/plugins/Killer.vst3');

  const warnings = scan.scanWarnings(prepared).join('\n');
  assert.match(warnings, /phasereplicant\.vst3/);
  assert.match(warnings, /a Windows binary/);
  assert.match(warnings, /Killer\.vst3/);
});
