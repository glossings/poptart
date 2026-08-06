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

test('silence right after the Welcome banner -> blames a hanging user startup.scd', () => {
  // The real-world log this was built from: compile succeeds, banner prints, then nothing -
  // sclang runs the user's startup.scd before our script, so ours never even started.
  const d = diagnoseSclangOutput('compile done\nWelcome to SuperCollider 3.14.1.\nFor help type cmd-d.\n', true);
  assert.match(d, /never ran poptart's engine script/);
  assert.match(d, /startup\.scd/);
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
