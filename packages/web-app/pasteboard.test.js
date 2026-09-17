'use strict';

// Unit tests for pasteboard.js - the clipboard's file URLs as paths, read through an injected
// script runner: the parse of the script's output, and the empty answer off macOS.

const { test } = require('node:test');
const assert = require('node:assert');

const { readPasteboardFiles, parsePasteboardOutput } = require('./pasteboard.js');

test('the script output parses to types and file paths', () => {
  const out = parsePasteboardOutput('{"types":["public.file-url","public.utf8-plain-text"],"files":["/Users/x/Splice/sounds/kick.wav"]}\n');
  assert.deepStrictEqual(out, { types: ['public.file-url', 'public.utf8-plain-text'], files: ['/Users/x/Splice/sounds/kick.wav'] });
});

test('AppKit chatter before the JSON line, or no JSON at all, is tolerated', () => {
  const chatter = '2026-09-16 19:00:50.954 osascript[1:2] Error received in message reply handler\n{"types":["public.html"],"files":[]}\n';
  assert.deepStrictEqual(parsePasteboardOutput(chatter), { types: ['public.html'], files: [] });
  assert.deepStrictEqual(parsePasteboardOutput(''), { types: [], files: [] });
  assert.deepStrictEqual(parsePasteboardOutput('not json'), { types: [], files: [] });
  assert.deepStrictEqual(parsePasteboardOutput('{"files":["relative.wav", "/abs.wav"]}'), { types: [], files: ['/abs.wav'] });
});

test('readPasteboardFiles runs the script on macOS and answers empty elsewhere', async () => {
  let ran = 0;
  const run = async () => { ran++; return '{"types":["public.file-url"],"files":["/a/b.wav"]}'; };
  assert.deepStrictEqual(await readPasteboardFiles({ run, platform: 'darwin' }), { types: ['public.file-url'], files: ['/a/b.wav'] });
  assert.strictEqual(ran, 1);
  assert.deepStrictEqual(await readPasteboardFiles({ run, platform: 'linux' }), { types: [], files: [] });
  assert.strictEqual(ran, 1);
});
