'use strict';

// Muting clips in the arrangement painter (the `0` key - public/client.js). A muted clip keeps its
// bars, its row and its handles and simply stops sounding, which is the difference between "let me
// hear the song without this" and a delete you would have to paint back.
//
// The rule worth pinning is that it is ONE toggle for the whole set, decided by whether any of the
// clips is still sounding. Flipping each clip on its own is the obvious implementation and it is
// wrong: press it twice on a mixed selection and you get the inverse of what you started with,
// which is never what anybody meant by pressing a key twice.
//
// (What a muted clip MEANS at playback time - no span, so the part is silent there - lives in
// pattern-core's arrange.test.mjs, next to the parser that carries the flag.)

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

/** A painter holding `clips`, with the gestures wired to counters instead of the buffer. */
function painter(clips) {
  const arState = { clips, sel: new Set() };
  const log = [];
  const wrote = { n: 0 };
  // eslint-disable-next-line no-new-func
  const fn = new Function('arState', 'logLine', 'writeArrangeCall', 'drawArrange', `
    ${grab('arToggleMute')}
    return arToggleMute;`);
  return {
    arState,
    log,
    wrote,
    toggle: fn(arState, (msg, kind) => log.push(`${kind ?? 'ok'}: ${msg}`), () => { wrote.n++; }, () => {}),
  };
}

const clip = (label, start, len, mute) => (mute ? { label, start, len, mute: true } : { label, start, len });

test('a mixed selection mutes, and pressing again brings all of it back', () => {
  const clips = [clip('kick', 0, 4), clip('hats', 0, 4, true), clip('bass', 0, 4)];
  const p = painter(clips);
  p.toggle(clips);
  assert.deepEqual(clips.map((c) => !!c.mute), [true, true, true], 'anything still sounding: mute the lot');
  p.toggle(clips);
  assert.deepEqual(clips.map((c) => !!c.mute), [false, false, false], 'all muted: unmute the lot');
  assert.equal(p.wrote.n, 2, 'each press is one write of the call');
});

test('an unmuted clip is spelled as it always was - the flag is gone, not false', () => {
  // serializeArrangement writes `,m` on a truthy `mute`, and every saved arrangement in the world
  // has three fields per clip. A `mute: false` left lying about would round-trip fine and read as
  // noise in every diff.
  const clips = [clip('kick', 0, 4, true)];
  painter(clips).toggle(clips);
  assert.deepEqual(clips[0], { label: 'kick', start: 0, len: 4 });
});

test('clips that have since left the arrangement are not muted back into it', () => {
  // A selection can outlive the clips in it (an undo, a re-eval that dropped a row). Muting a clip
  // the painter no longer holds would write nothing and log a lie.
  const clips = [clip('kick', 0, 4)];
  const p = painter(clips);
  p.toggle([clips[0], clip('ghost', 0, 4)]);
  assert.equal(clips[0].mute, true);
  assert.match(p.log.join('\n'), /muted 1 clip$/m, 'and it says one, not two');
});

test('nothing to mute says so and writes nothing', () => {
  const p = painter([]);
  p.toggle([]);
  assert.equal(p.wrote.n, 0);
  assert.match(p.log[0], /^warn: nothing to mute/);
});
