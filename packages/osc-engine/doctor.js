#!/usr/bin/env node
'use strict';

// One-shot diagnostics for how poptart is finding and configuring SuperCollider.
//
//   node packages/osc-engine/doctor.js [--out report.txt] [--no-sclang]
//
// The point is a single round trip. Working out why an engine won't boot on a machine that
// isn't in front of you otherwise costs a dozen "and what does X say?" messages; this prints
// every path poptart resolved, the class-library config it generated, what is actually in the
// Extensions folders, and - unless --no-sclang - what sclang itself reports once booted with
// that config. Paste one file, get an answer.
//
// It never touches audio: the sclang probe compiles the class library, posts what it sees and
// exits, so it is safe to run while poptart is playing and needs no audio device (which is what
// makes it useful on a CI runner, where the packaging can be verified but sound cannot).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  resolveSclangPath,
  knownSclangLocations,
  onPath,
  usingPrivateSc,
  activeExtensionsDir,
  vstPluginExtensionDirs,
  vstPluginExtensionInstalled,
} = require('./index');
const {
  SC_RELEASE,
  scAsset,
  privateScRoot,
  privateScInstalled,
  privateSclangPath,
  privateClassLibraryDir,
  privateUgenDir,
  privateExtensionsDir,
  privateUgenPluginsPath,
  sclangConfPath,
  writeSclangConf,
} = require('./private-sc');
const { sclangStatus, findSclangSymlinkOnPath, runningEngineProcesses } = require('./setup');
const { resolveSearchDirs, walkPluginDirs, readJournal, describeFormat, splitPathList } = require('./plugin-scan');
const { engineLogPath, tailEngineLog } = require('./engine-log');

// A port of its own: the sclang test harnesses run in parallel and sclang only tries ten ports
// up from its default before giving up on networking entirely.
const PROBE_PORT = '57296';
const PROBE_TIMEOUT_MS = 90000;

const out = [];
const say = (line = '') => out.push(line);
const heading = (title) => {
  say('');
  say(`--- ${title} ${'-'.repeat(Math.max(0, 74 - title.length))}`);
};

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function describePath(label, p) {
  if (!p) return say(`${label}: (not applicable on this platform)`);
  say(`${label}: ${p}`);
  say(`${' '.repeat(label.length)}  ${exists(p) ? 'exists' : 'MISSING'}`);
}

// Shallow tree of a directory, enough to spot "VSTPlugin is there but empty" without dumping a
// class library's worth of filenames.
function listTree(dir, depth = 2, prefix = '  ') {
  if (!exists(dir)) return say(`${prefix}(missing)`);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return say(`${prefix}(unreadable: ${err.message})`);
  }
  if (!entries.length) return say(`${prefix}(empty)`);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      say(`${prefix}${entry.name}/`);
      if (depth > 1) listTree(path.join(dir, entry.name), depth - 1, `${prefix}  `);
    } else {
      let size = '';
      try {
        size = ` (${fs.statSync(path.join(dir, entry.name)).size} bytes)`;
      } catch {
        // a broken symlink, most likely - the name alone is the finding
      }
      say(`${prefix}${entry.name}${size}`);
    }
  }
}

// What sclang thinks, once booted with exactly the config poptart would give it. `\X.asClass`
// rather than a bare class name so a missing extension posts `nil` instead of failing to
// compile the probe.
const PROBE_SCD = `
"DOCTOR sclang started".postln;
"DOCTOR version: %".format(Main.version).postln;
"DOCTOR config file: %".format(LanguageConfig.currentPath).postln;
"DOCTOR excludeDefaultPaths: %".format(LanguageConfig.excludeDefaultPaths).postln;
"DOCTOR includePaths: %".format(LanguageConfig.includePaths).postln;
"DOCTOR excludePaths: %".format(LanguageConfig.excludePaths).postln;
"DOCTOR classLibraryDir: %".format(Platform.classLibraryDir).postln;
"DOCTOR userExtensionDir: %".format(Platform.userExtensionDir).postln;
"DOCTOR systemExtensionDir: %".format(Platform.systemExtensionDir).postln;
"DOCTOR userConfigDir: %".format(Platform.userConfigDir).postln;
"DOCTOR startup.scd present: %".format(File.exists(Platform.userConfigDir +/+ "startup.scd")).postln;
"DOCTOR VSTPlugin class: %".format(\\VSTPlugin.asClass).postln;
"DOCTOR PoptartPitchShift class: %".format(\\PoptartPitchShift.asClass).postln;
"DOCTOR classes compiled: %".format(Object.allSubclasses.size).postln;
0.exit;
`;

function runSclangProbe(sclangPath, confArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-doctor-'));
  const scd = path.join(dir, 'probe.scd');
  fs.writeFileSync(scd, PROBE_SCD);
  try {
    return execFileSync(sclangPath, [...confArgs, '-u', PROBE_PORT, scd], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit still produces the interesting output - a class library that failed to
    // compile is the single most useful thing this script can capture.
    const captured = `${err.stdout || ''}${err.stderr || ''}`;
    return `${captured}\n(sclang exited abnormally: ${err.message})`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const withSclang = !args.includes('--no-sclang');

  say(`poptart doctor - ${new Date().toISOString()}`);

  heading('machine');
  say(`platform: ${process.platform}-${process.arch}`);
  say(`os: ${os.type()} ${os.release()}`);
  say(`node: ${process.version}`);
  say(`home: ${os.homedir()}`);

  heading('environment overrides');
  const interesting = Object.keys(process.env)
    .filter((k) => k.startsWith('POPTART_'))
    .sort();
  if (!interesting.length) say('(none set)');
  // Values are paths and flags, not secrets, and the whole point is to see them.
  for (const key of interesting) say(`${key}=${process.env[key]}`);

  heading('sclang resolution');
  const status = sclangStatus();
  say(`resolved: ${resolveSclangPath()}`);
  say(`matched by: ${status.source ?? 'nothing - SuperCollider was not found'}`);
  say(`using the private copy: ${usingPrivateSc() ? 'yes' : 'no'}`);
  say(`bare 'sclang' on PATH: ${onPath('sclang') ? 'yes' : 'no'}`);
  const symlink = findSclangSymlinkOnPath();
  say(`symlinked sclang on PATH: ${symlink ?? 'none'}`);
  say('standard install locations:');
  for (const loc of knownSclangLocations()) say(`  ${exists(loc) ? '[present]' : '[absent] '} ${loc}`);

  heading('private SuperCollider');
  const asset = scAsset();
  say(`pinned release: ${SC_RELEASE.version} (${SC_RELEASE.tag})`);
  say(`asset for this platform: ${asset ? asset.file : 'none - use a package manager'}`);
  say(`root: ${privateScRoot()}`);
  say(`installed: ${privateScInstalled() ? 'yes' : 'no'}`);
  describePath('sclang', privateSclangPath());
  describePath('class library', privateClassLibraryDir());
  describePath('bundled UGen plugins', privateUgenDir());
  describePath('private Extensions', privateExtensionsDir());
  say(`ugenPluginsPath (scsynth -U): ${privateUgenPluginsPath().join(path.delimiter)}`);

  heading('generated class-library config');
  let confArgs = [];
  if (usingPrivateSc()) {
    try {
      const confPath = writeSclangConf();
      confArgs = ['-l', confPath];
      say(`path: ${confPath}`);
      say('');
      say(fs.readFileSync(confPath, 'utf8').trimEnd());
    } catch (err) {
      say(`could not write it: ${err.message}`);
    }
  } else {
    say('not applicable - poptart is using a system SuperCollider, which reads its own config.');
    say(`(the private copy would write ${sclangConfPath()})`);
  }

  heading('extensions');
  say(`poptart installs into: ${activeExtensionsDir()}`);
  say(`VSTPlugin looked for in: ${vstPluginExtensionDirs().join(', ')}`);
  say(`VSTPlugin present: ${vstPluginExtensionInstalled() ? 'yes' : 'no'}`);
  say('');
  say(`contents of ${activeExtensionsDir()}:`);
  listTree(activeExtensionsDir(), 3);

  heading('plugin scan');
  // Resolved without touching the journal: doctor must never decide that something gets skipped
  // on the next boot (preparePluginScan does, which is why it isn't used here).
  const scanDirs = resolveSearchDirs();
  const userExclude = splitPathList(process.env.POPTART_VST_EXCLUDE);
  const journal = readJournal();
  say(`folders: ${scanDirs.length ? scanDirs.join(', ') : 'none found - VSTPlugin will use its own defaults'}`);
  const walk = walkPluginDirs({ dirs: scanDirs, exclude: userExclude });
  say(`plugins to probe: ${walk.plugins.length}${walk.truncated ? ' (walk hit its entry limit)' : ''}`);
  if (walk.foreign.length) {
    say(`excluded as unloadable here (probing one crashes the audio server):`);
    for (const f of walk.foreign) say(`  ${f.path} - ${describeFormat(f.format)}`);
  } else {
    say('excluded as unloadable here: none');
  }
  say(`skipped after killing an earlier scan: ${journal.skip.length ? journal.skip.map((s) => s.path).join(', ') : 'none'}`);
  if (journal.inFlight) say(`a probe of ${journal.inFlight.path} is recorded as unfinished (the scan died on it)`);
  if (userExclude.length) say(`excluded by POPTART_VST_EXCLUDE: ${userExclude.join(', ')}`);

  heading('running processes');
  const running = runningEngineProcesses();
  say(running.length ? `already running: ${running.join(', ')}` : 'no sclang/scsynth running');

  heading('engine log');
  // The tail of the last run's output, which is where a scan crash or a boot failure actually
  // explains itself. Two files: the current run and the one before it, and after a crash the
  // interesting one is usually .1.
  for (const file of [engineLogPath(), `${engineLogPath()}.1`]) {
    const tail = tailEngineLog({ file, lines: 60 });
    say('');
    say(`${file}: ${exists(file) ? `last ${tail.split('\n').length} line(s)` : 'not written yet'}`);
    if (tail) say(tail.trimEnd());
  }

  if (withSclang) {
    heading('sclang probe');
    const sclangPath = resolveSclangPath();
    say(`command: ${sclangPath} ${[...confArgs, '-u', PROBE_PORT, '<probe.scd>'].join(' ')}`);
    say('');
    say(runSclangProbe(sclangPath, confArgs).trimEnd());
  }

  say('');
  const report = out.join('\n');
  if (outFile) {
    fs.writeFileSync(outFile, report);
    process.stdout.write(`poptart doctor: wrote ${outFile}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }
}

if (require.main === module) main();

module.exports = { PROBE_SCD };
