'use strict';

// The index axis's file-name labels (public/client.js, prShortNames).
//
// A gutter is narrow and a pack's file names are long in the same way: everything up to a number is
// shared. What this pins is where the shared part is CUT - at a separator, never inside a word - and
// that the audio extension comes off however many times the file was given one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const prShortNames = new Function(`${grab('prShortNames')}; return prShortNames;`)();

test('the shared start comes off at a separator, and a doubled extension comes off whole', () => {
  assert.deepEqual(
    prShortNames([
      'Drum Kit - TR-909 - 01 909BD01.wav.wav',
      'Drum Kit - TR-909 - 02 909BD02.wav.wav',
      'Drum Kit - TR-909 - 03 909SD01.wav.wav',
    ]),
    ['01 909BD01', '02 909BD02', '03 909SD01'],
  );
});

test('a shared start that ends inside a word is left on', () => {
  // "909BD0" is common to both, but it is not a prefix anyone would read as one.
  assert.deepEqual(prShortNames(['909BD01.wav', '909BD02.wav']), ['909BD01', '909BD02']);
  assert.deepEqual(prShortNames(['kick_hard.aif', 'kick_soft.aiff']), ['hard', 'soft']);
});

test('a lone file, and names with nothing in common, keep their names', () => {
  assert.deepEqual(prShortNames(['Drum Kit - 01 kick.flac']), ['Drum Kit - 01 kick']);
  assert.deepEqual(prShortNames(['bd.wav', 'snare.WAV', 'hat.mp3']), ['bd', 'snare', 'hat']);
});

test('a name that IS the shared start keeps itself rather than going blank', () => {
  assert.deepEqual(prShortNames(['loop .wav', 'loop a.wav']), ['loop ', 'a']);
});
