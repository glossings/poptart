'use strict';

// Deciding what the plugin scan is allowed to touch, and remembering what it did last time.
//
// The scan itself belongs to VSTPlugin: poptart calls VSTPlugin.search and it walks the plugin
// folders, probing everything it finds out-of-process. Two things about that walk have to be
// settled on this side of the fence before it starts.
//
// 1. Some files kill the server. A probe normally can't - it happens in a subprocess, and a
//    crash there is caught and remembered. But the decision of HOW to probe is made in-process,
//    by loading the file's headers, and VSTPlugin reads a file it doesn't recognize as a module
//    with no architectures and then reads the first element of that empty list (vst/CpuArch.cpp,
//    vst/PluginFactory.cpp). That is a segfault, in scsynth, before the probe subprocess is even
//    spawned - so nothing catches it and nothing is logged naming the file. Found the hard way
//    on 2026-09-20: a Windows `phasereplicant.vst3` (a PE DLL, a plain file rather than a macOS
//    bundle) sitting in /Library/Audio/Plug-Ins/VST3 ended every scan for a whole afternoon.
//    Worse than losing one plugin: VSTPlugin writes its cache only when a whole search finishes,
//    so a machine with such a file never completes a scan - no cache, no plugins, same death
//    every launch.
//    The cure here is to look at the candidates first and hand VSTPlugin the bad ones as
//    exclusions. "Bad" is decided by the first four bytes: a plugin that this machine could load
//    is a Mach-O on macOS, a PE image on Windows, an ELF object on Linux. Anything else with a
//    plugin extension is a file that cannot be a plugin here, whatever it is elsewhere.
//
// 2. Nobody knows how many plugins there are. VSTPlugin reports results only when a whole search
//    returns, so "scanning..." has no denominator and the first run of a fresh machine looks
//    hung for minutes. Walking the folders ourselves costs one stat per entry and produces the
//    number - which is the only reason the UI can say "47 of 312" instead of a spinner.
//
// Both want the same walk, so it happens once and both read it. The traversal mirrors
// VSTPlugin's own (vst/Search.cpp): recurse into directories, treat anything with a plugin
// extension as a plugin and never descend into it, ignore everything else.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- where plugins live ---

// VSTPlugin's platformExtensions (vst/Search.cpp). An entry with one of these is a plugin as far
// as the scan is concerned, whether it is a file or a bundle directory.
function pluginExtensions(platform = process.platform) {
  if (platform === 'win32') return ['.dll', '.vst3'];
  if (platform === 'darwin') return ['.vst', '.vst3'];
  return ['.so', '.vst3'];
}

function hasPluginExtension(name, platform = process.platform) {
  const ext = path.extname(name).toLowerCase();
  return pluginExtensions(platform).includes(ext);
}

// VSTPlugin's defaultSearchPaths (vst/Search.cpp), which is what it walks when `dir` is empty.
// Duplicated rather than asked for because there is no way to ask: the list is compiled into the
// C++ and the SC class exposes no accessor. It changes about once a decade.
function defaultPluginDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library/Audio/Plug-Ins/VST'),
      '/Library/Audio/Plug-Ins/VST',
      path.join(home, 'Library/Audio/Plug-Ins/VST3'),
      '/Library/Audio/Plug-Ins/VST3',
    ];
  }
  if (platform === 'win32') {
    // Both program-files roots, 64-bit first: VSTPlugin is built with the bridge, so it looks in
    // the 32-bit tree too (it can host those plugins out-of-process).
    const roots = [env.ProgramW6432, env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean);
    const seen = new Set();
    const dirs = [];
    for (const root of roots) {
      if (seen.has(root)) continue;
      seen.add(root);
      for (const sub of [
        'VSTPlugins',
        'Steinberg\\VSTPlugins',
        'Common Files\\VST2',
        'Common Files\\Steinberg\\VST2',
        'Common Files\\VST3',
      ]) {
        dirs.push(path.join(root, sub));
      }
    }
    return dirs;
  }
  return [
    path.join(home, '.vst'),
    '/usr/local/lib/vst',
    '/usr/lib/vst',
    path.join(home, '.vst3'),
    '/usr/local/lib/vst3',
    '/usr/lib/vst3',
  ];
}

// The same three-way choice poptart.scd used to make on its own: an explicit list, else the
// curated folder if it exists, else the standard locations. Resolved here now, and handed down
// in POPTART_VST_DIRS, because the walk above has to look at exactly what the scan will look at -
// two copies of this rule would eventually disagree, and the disagreement would be a crash the
// pre-check didn't prevent.
function resolveSearchDirs({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fsImpl = fs,
} = {}) {
  const explicit = splitPathList(env.POPTART_VST_DIRS, platform);
  if (explicit.length) return explicit;
  const curated = path.join(home, '.poptart', 'plugins');
  if (existsDir(curated, fsImpl)) return [curated];
  return defaultPluginDirs({ platform, env, home }).filter((d) => existsDir(d, fsImpl));
}

// POPTART_VST_DIRS and POPTART_VST_EXCLUDE hold several paths in one variable, and ':' cannot be
// the separator on Windows - `C:\Program Files\...` is full of them. The platform's own delimiter
// (';' there, ':' everywhere else) is what POPTART_UGEN_PLUGINS already uses.
function splitPathList(value, platform = process.platform) {
  if (!value) return [];
  const delim = platform === 'win32' ? ';' : ':';
  return String(value)
    .split(delim)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinPathList(list, platform = process.platform) {
  return list.join(platform === 'win32' ? ';' : ':');
}

function existsDir(dir, fsImpl = fs) {
  try {
    return fsImpl.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// --- what a loadable module looks like ---

// First four bytes, which is all it takes to tell a plugin this machine could load from a file
// that merely has the extension. Mirrors what VSTPlugin's own CpuArch reader does, minus the
// part where it gets it wrong.
const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const MACHO_FAT = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function fileFormat(file, { fsImpl = fs } = {}) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
  } catch {
    return null; // unreadable - not ours to judge, and VSTPlugin handles a missing file cleanly
  }
  try {
    const buf = Buffer.alloc(4);
    const read = fsImpl.readSync(fd, buf, 0, 4, 0);
    if (read < 4) return 'unknown';
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe'; // "MZ"
    const magic = buf.readUInt32BE(0);
    if (magic === 0x7f454c46) return 'elf'; // "\x7fELF"
    if (MACHO.has(magic)) return 'macho';
    if (MACHO_FAT.has(magic)) return 'macho'; // universal binary (also Java's magic; harmless here)
    return 'unknown';
  } catch {
    return null;
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
}

// A list, because of Linux: a VSTPlugin built with Wine support hosts Windows plugins there, so a
// PE file is not proof of a mistake. Excluding a loadable plugin is the worse error - the crash
// this guards against was found on macOS, where no such ambiguity exists.
function nativeFormats(platform = process.platform) {
  if (platform === 'darwin') return ['macho'];
  if (platform === 'win32') return ['pe'];
  return ['elf', 'pe'];
}

// For the warning line. Naming what the file actually is turns "poptart skipped this" into
// something the user can act on - usually "that is the Windows build, I meant to delete it".
function describeFormat(format) {
  switch (format) {
    case 'pe':
      return 'a Windows binary';
    case 'elf':
      return 'a Linux binary';
    case 'macho':
      return 'a macOS binary';
    default:
      return 'not a plugin binary at all';
  }
}

// --- the walk ---

// Everything the scan will look at, in one pass: `plugins` is every candidate it will probe (the
// denominator for progress), `foreign` is the subset that would crash it and must be excluded.
//
// Deliberately not descending into a bundle: VSTPlugin treats any directory with a plugin
// extension as one plugin and stops there, and the bundle branch of its architecture check
// throws properly rather than crashing - bundles are not the problem and their innards are none
// of our business.
function walkPluginDirs({
  dirs,
  platform = process.platform,
  fsImpl = fs,
  exclude = [],
  maxEntries = 50000,
  maxDepth = 12,
} = {}) {
  const excluded = new Set(exclude.map((p) => path.resolve(p)));
  const plugins = [];
  const foreign = [];
  const seenDirs = new Set();
  let entries = 0;
  let truncated = false;

  const visit = (dir, depth) => {
    if (truncated || depth > maxDepth) return;
    let real;
    try {
      real = fsImpl.realpathSync(dir);
    } catch {
      return; // gone, unreadable, or a broken symlink
    }
    if (seenDirs.has(real)) return; // symlink loop, or two names for one folder
    seenDirs.add(real);
    let listing;
    try {
      listing = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (entries >= maxEntries) {
        truncated = true;
        return;
      }
      entries += 1;
      const name = entry.name;
      // Hidden entries are NOT skipped, because VSTPlugin doesn't skip them: its walk takes
      // anything with a plugin extension, leading dot or not. That matters - macOS leaves
      // AppleDouble files ("._Serum.vst3", a few KB of resource fork) beside anything copied
      // from a zip or a non-Mac volume, and one of those is exactly the kind of plain non-binary
      // file that crashes the scan.
      const full = path.join(dir, name);
      if (excluded.has(path.resolve(full))) continue;
      // A symlink's target decides: the curated ~/.poptart/plugins folder is nothing but
      // symlinks, and VSTPlugin follows them.
      let isDir;
      try {
        isDir = entry.isSymbolicLink() ? fsImpl.statSync(full).isDirectory() : entry.isDirectory();
      } catch {
        continue; // broken symlink - VSTPlugin reports it as unloadable and moves on
      }
      if (hasPluginExtension(name, platform)) {
        plugins.push(full);
        if (!isDir) {
          const format = fileFormat(full, { fsImpl });
          if (format && !nativeFormats(platform).includes(format)) foreign.push({ path: full, format });
        }
        continue; // a plugin, bundle or file - never descended into
      }
      if (isDir) visit(full, depth + 1);
    }
  };

  for (const dir of dirs) visit(dir, 0);
  return { plugins, foreign, truncated };
}

// --- the journal ---
//
// A scan that takes the server with it loses everything: VSTPlugin's cache is written at the end
// of a search and there is no end. The next launch then repeats it exactly. So the plugin being
// probed is written down before it is probed and cleared after, and when the engine SEES the
// audio server die mid-probe it marks that entry as the crash. A marked entry found at the next
// launch is excluded, with a line saying so and how to undo it.
//
// The mark is the point. An unmarked leftover only says that poptart itself went away mid-probe -
// the terminal was closed, the dev server was restarted, the machine lost power - and none of
// those is the plugin's fault. Skipping a working plugin on that evidence would be a worse bug
// than the one this exists to soften, so an unmarked entry is simply dropped.
//
// Beside settings.json and the pid file, for the same reason those are there: user-owned state
// that has to outlive the process.
function journalPath({ dir = path.join(os.homedir(), '.poptart') } = {}) {
  return path.join(dir, 'scan-journal.json');
}

function readJournal({ file = journalPath(), fsImpl = fs } = {}) {
  try {
    const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return {
      inFlight: data.inFlight && typeof data.inFlight.path === 'string' ? data.inFlight : null,
      skip: Array.isArray(data.skip) ? data.skip.filter((s) => s && typeof s.path === 'string') : [],
      lastDone: typeof data.lastDone === 'string' ? data.lastDone : null,
    };
  } catch {
    return { inFlight: null, skip: [], lastDone: null };
  }
}

function writeJournal(state, { file = journalPath(), fsImpl = fs } = {}) {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
    return true;
  } catch {
    return false; // a read-only home is not a reason to refuse to scan
  }
}

// Called at the start of a run, before the engine boots. An in-flight probe marked as a crash
// moves to the skip list and is returned for the warning; an unmarked one is forgotten.
function claimCrashedProbe({ file = journalPath(), fsImpl = fs } = {}) {
  const journal = readJournal({ file, fsImpl });
  if (!journal.inFlight) return { crashed: null, skip: journal.skip };
  if (!journal.inFlight.crashed) {
    writeJournal({ inFlight: null, skip: journal.skip, lastDone: journal.lastDone }, { file, fsImpl });
    return { crashed: null, skip: journal.skip };
  }
  const crashed = journal.inFlight;
  const skip = journal.skip.filter((s) => s.path !== crashed.path);
  skip.push({ path: crashed.path, at: Date.now(), reason: 'ended the plugin scan' });
  writeJournal({ inFlight: null, skip, lastDone: journal.lastDone }, { file, fsImpl });
  return { crashed, skip };
}

function noteProbe(pluginPath, { file = journalPath(), fsImpl = fs } = {}) {
  const journal = readJournal({ file, fsImpl });
  if (!pluginPath && !journal.inFlight) return true; // nothing to clear; don't create a file to say so
  return writeJournal(
    { inFlight: pluginPath ? { path: pluginPath, at: Date.now() } : null, skip: journal.skip, lastDone: journal.lastDone },
    { file, fsImpl },
  );
}

function noteProbeDone(pluginPath, { file = journalPath(), fsImpl = fs } = {}) {
  const journal = readJournal({ file, fsImpl });
  if (!journal.inFlight) return false;
  return writeJournal({ inFlight: null, skip: journal.skip, lastDone: pluginPath ?? journal.inFlight.path }, { file, fsImpl });
}

// The engine watched the audio server die while this probe was in flight (see index.js's
// _watchServerDeath). The only thing that makes the next start skip a plugin.
function markProbeCrashed({ file = journalPath(), fsImpl = fs } = {}) {
  const journal = readJournal({ file, fsImpl });
  if (!journal.inFlight) return false;
  return writeJournal(
    { inFlight: { ...journal.inFlight, crashed: true }, skip: journal.skip, lastDone: journal.lastDone },
    { file, fsImpl },
  );
}

function forgetSkips({ file = journalPath(), fsImpl = fs } = {}) {
  const journal = readJournal({ file, fsImpl });
  const count = journal.skip.length;
  writeJournal({ inFlight: null, skip: [], lastDone: journal.lastDone }, { file, fsImpl });
  return count;
}

// --- putting it together ---

// Everything the engine needs to hand sclang, worked out before anything is spawned: the
// directories to search, the exclusions (the user's, plus the files that would crash the scan,
// plus whatever killed the last one), and how many plugins are out there.
function preparePluginScan({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fsImpl = fs,
  journalFile = journalPath({ dir: path.join(home, '.poptart') }),
} = {}) {
  const dirs = resolveSearchDirs({ platform, env, home, fsImpl });
  const userExclude = splitPathList(env.POPTART_VST_EXCLUDE, platform);
  const { crashed, skip } = claimCrashedProbe({ file: journalFile, fsImpl });
  const skipped = skip.map((s) => s.path);
  const { plugins, foreign, truncated } = walkPluginDirs({
    dirs,
    platform,
    fsImpl,
    exclude: [...userExclude, ...skipped],
  });
  const exclude = [...new Set([...userExclude, ...skipped, ...foreign.map((f) => f.path)])];
  return { dirs, exclude, plugins, foreign, skipped: skip, crashed, truncated, journalFile };
}

// The lines the user reads at startup when any of this had an effect. Silent when nothing did,
// which is the normal case.
function scanWarnings({ foreign, crashed, skipped, truncated }, { platform = process.platform } = {}) {
  const lines = [];
  for (const f of foreign) {
    lines.push(
      `skipping ${f.path} - it has a plugin extension but is ${describeFormat(f.format)}, ` +
        'so it cannot load here and probing it would crash the audio server.',
    );
  }
  if (crashed) {
    lines.push(
      `skipping ${crashed.path} - the last plugin scan ended while probing it. ` +
        'Delete it from the skip list in ~/.poptart/scan-journal.json to try it again.',
    );
  }
  const stale = skipped.filter((s) => !crashed || s.path !== crashed.path);
  if (stale.length) {
    lines.push(
      `${stale.length} plugin(s) skipped from earlier failed scans: ${stale.map((s) => s.path).join(', ')} ` +
        '(clear the skip list in ~/.poptart/scan-journal.json to retry them).',
    );
  }
  if (truncated) {
    lines.push(
      'the plugin folders hold more entries than poptart will walk; the scan still runs, but its ' +
        'progress count and its crash pre-check cover only part of them - narrow the scan with ' +
        `POPTART_VST_DIRS (${platform === 'win32' ? 'semicolon' : 'colon'}-separated) if plugins go missing.`,
    );
  }
  return lines;
}

module.exports = {
  pluginExtensions,
  hasPluginExtension,
  defaultPluginDirs,
  resolveSearchDirs,
  splitPathList,
  joinPathList,
  fileFormat,
  nativeFormats,
  describeFormat,
  walkPluginDirs,
  journalPath,
  readJournal,
  writeJournal,
  claimCrashedProbe,
  noteProbe,
  noteProbeDone,
  markProbeCrashed,
  forgetSkips,
  preparePluginScan,
  scanWarnings,
};
