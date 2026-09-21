'use strict';

// Unit tests for the boot-failure diagnosis - pure string matching over sclang's boot log, no
// engine boot. The vstInstalled flag is injected so the VSTPlugin branch is testable on any
// machine regardless of what's actually in its Extensions folder.

const { test } = require('node:test');
const assert = require('node:assert');

const { diagnoseSclangOutput, clarifySclangLine, vstPluginExtensionDirs } = require('./index.js');

test('broken class library -> points at the SuperCollider user directory and the symlink trap', () => {
  const d = diagnoseSclangOutput('ERROR: duplicate Class found: \'Foo\'\nLibrary has not been compiled successfully.\n', true);
  assert.match(d, /class library failed to compile/);
  assert.match(d, /Extensions/);
  assert.match(d, /symlink/);
});

test('port already bound -> points at orphaned sclang/scsynth', () => {
  const d = diagnoseSclangOutput('Exception in World_OpenUDP: unable to bind udp socket: address in use\n', true);
  assert.match(d, /orphaned sclang or scsynth/);
  assert.match(d, /pkill/);
});

test('audio device failure -> points at the output device', () => {
  const d = diagnoseSclangOutput('could not initialize audio.\n', true);
  assert.match(d, /audio device/);
});

test('Class not defined without VSTPlugin installed -> install instructions with the real dirs', () => {
  const d = diagnoseSclangOutput('ERROR: Class not defined.\n  in interpreted text\n', false);
  assert.match(d, /VSTPlugin/);
  assert.match(d, /git\.iem\.at/);
  assert.ok(d.includes(vstPluginExtensionDirs()[0]), 'names the standard Extensions dir');
});

test('Class not defined with VSTPlugin installed -> generic stale-extension hint', () => {
  const d = diagnoseSclangOutput('ERROR: Class not defined.\n', true);
  assert.match(d, /failed to load/);
  assert.doesNotMatch(d, /git\.iem\.at/);
});

test('scsynth boot failure -> generic server hint', () => {
  const d = diagnoseSclangOutput('server failed to start\n', true);
  assert.match(d, /failed to boot/);
});

test('compile failure wins over a later Class not defined (root cause first)', () => {
  const d = diagnoseSclangOutput('Library has not been compiled successfully.\nERROR: Class not defined.\n', false);
  assert.match(d, /class library failed to compile/);
});

// --- silent-stall localization via the .scd's boot-progress checkpoints ---

test('an unreadable engine script is an installation fault, not the user\'s startup.scd', () => {
  // Verbatim from a packaged build whose script path pointed inside an asar archive.
  const d = diagnoseSclangOutput(
    'Class tree inited in 0.04 seconds\n\n\n*** Welcome to SuperCollider 3.14.1. *** For help type cmd-d.\n' +
      'file "/Applications/poptart.app/Contents/Resources/app.asar/node_modules/@poptart/osc-engine/sc/poptart.scd" does not exist.\n',
    true,
  );
  assert.match(d, /could not read poptart's engine script/);
  assert.doesNotMatch(d, /startup\.scd/);
});

// The real-world log both of these were built from: compile succeeds, banner prints, then
// nothing - sclang never got as far as poptart's script.
const WENT_QUIET = 'compile done\nWelcome to SuperCollider 3.14.1.\nFor help type cmd-d.\n';

test('silence after the banner with no VSTPlugin -> names VSTPlugin, not the startup file', () => {
  // The first Windows install, exactly: VSTPlugin's download dropped, setup carried on, and
  // sclang stopped on the missing class without printing a word. The old answer blamed a
  // startup.scd at a macOS path on a Windows machine that had no such file.
  const d = diagnoseSclangOutput(WENT_QUIET, false, { startupFile: 'C:\\Users\\x\\…\\startup.scd', startupExists: false });
  assert.match(d, /VSTPlugin SuperCollider extension is missing/);
  assert.match(d, /starting poptart again retries it/);
  assert.doesNotMatch(d, /startup file/);
});

test('silence right after the Welcome banner -> blames the startup file, when there is one', () => {
  const d = diagnoseSclangOutput(WENT_QUIET, true, { startupFile: '/Users/x/…/SuperCollider/startup.scd', startupExists: true });
  assert.match(d, /never ran poptart's engine script/);
  assert.match(d, /you have one: \/Users\/x\/…\/SuperCollider\/startup\.scd/);
});

test('...and does not blame a startup file that does not exist', () => {
  // What the first Windows install reported: a 60s boot timeout, no startup.scd, and a second
  // launch that worked - so the advice is to try again, not to go looking for a file.
  const win = 'C:\\Users\\x\\AppData\\Local\\SuperCollider\\startup.scd';
  const d = diagnoseSclangOutput(WENT_QUIET, true, { startupFile: win, startupExists: false });
  assert.match(d, /went quiet/);
  assert.match(d, /starting poptart again/);
  assert.doesNotMatch(d, /you have one/);
  assert.match(d, /looked for C:\\Users/, 'names the path it checked, so a report can say it was wrong');
});

test('script ran, scsynth never spoke -> Gatekeeper / permissions guidance', () => {
  const d = diagnoseSclangOutput(
    'Welcome to SuperCollider 3.14.1.\npoptart: engine script running\n' +
      'poptart: booting scsynth (device: system default, sr: 48000, block: 256, out: 2ch, in: 0ch)\n',
    true,
  );
  assert.match(d, /scsynth never produced any output/);
  assert.match(d, /Gatekeeper/);
  assert.match(d, /Microphone/);
});

test('scsynth spoke but never finished opening the device -> device guidance + IDE replay', () => {
  const d = diagnoseSclangOutput(
    'poptart: engine script running\npoptart: booting scsynth (device: Scarlett 2i2, sr: 48000, block: 256, out: 2ch, in: 2ch)\n' +
      "Booting server 'poptart' on address 127.0.0.1:57110.\nNumber of Devices: 3\n",
    true,
  );
  assert.match(d, /never finished/);
  assert.match(d, /different output device/);
  assert.match(d, /SuperCollider IDE/);
});

test('an explicit error beats silence localization (root cause first)', () => {
  const d = diagnoseSclangOutput(
    'poptart: engine script running\npoptart: booting scsynth (device: system default, sr: 48000, block: 256, out: 2ch, in: 0ch)\n' +
      'could not initialize audio.\n',
    true,
  );
  assert.match(d, /audio device/);
  assert.doesNotMatch(d, /Gatekeeper/);
});

test('unrecognized output -> null (raw log tail still shown by the caller)', () => {
  // No Welcome banner and no checkpoints: not enough signal to localize anything.
  assert.strictEqual(diagnoseSclangOutput('compiling class library...\n', true), null);
});

// --- forwarded sclang output ---

test("VSTPlugin's skip notice is rewritten into what actually happened", () => {
  const out = clarifySclangLine("'/Library/Audio/Plug-Ins/VST3/Auto-Tune Pro.vst3' is black-listed.\n");
  assert.match(out, /Auto-Tune Pro\.vst3' skipped - a previous probe of it crashed/);
  assert.doesNotMatch(out, /black-?listed/i);
});

test('the other upstream phrasing is rewritten too, and a Buffer chunk is accepted', () => {
  const out = clarifySclangLine(Buffer.from('Black-listed plugin /path/Foo.vst3\n'));
  assert.match(out, /^Skipped plugin \(a previous probe crashed\) \/path\/Foo\.vst3/);
  assert.doesNotMatch(out, /black-?listed/i);
});

test('every occurrence in a multi-line chunk is rewritten', () => {
  const out = clarifySclangLine("'/a/One.vst3' is blacklisted.\nprobing /a/Two.vst3... ok!\n'/a/Three.vst3' is black-listed.\n");
  assert.doesNotMatch(out, /black-?listed/i);
  assert.match(out, /probing \/a\/Two\.vst3\.\.\. ok!/); // unrelated lines pass through untouched
});

test('ordinary scan output is left exactly as it came', () => {
  const line = 'probing /Library/Audio/Plug-Ins/VST3/Diva.vst3... ok!\n';
  assert.strictEqual(clarifySclangLine(line), line);
});
