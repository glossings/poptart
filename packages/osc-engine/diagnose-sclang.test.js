'use strict';

// Unit tests for the boot-failure diagnosis - pure string matching over sclang's boot log, no
// engine boot. The vstInstalled flag is injected so the VSTPlugin branch is testable on any
// machine regardless of what's actually in its Extensions folder.

const { test } = require('node:test');
const assert = require('node:assert');

const { diagnoseSclangOutput, vstPluginExtensionDirs } = require('./index.js');

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

test('unrecognized output -> null (raw log tail still shown by the caller)', () => {
  assert.strictEqual(diagnoseSclangOutput('compiling class library...\nWelcome to SuperCollider\n', true), null);
});
