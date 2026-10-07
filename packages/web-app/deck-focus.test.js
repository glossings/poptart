'use strict';

// After a load, the focus moves to the OTHER deck only once the loaded deck is playing for real
// (public/client.js, djFocusOnPlay): a DJ who changes their mind loads again onto the same deck,
// and a cue audition - a song held on its cue, a code deck restarted by its cue - is not a start.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf(') {', at) + 2;
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

function rig() {
  let now = 10000;
  const focus = [];
  const songPanes = { a: { mirror: null }, b: { mirror: null } };
  const djCueHeld = { a: null, b: null };
  const api = new Function('mixModeOn', 'djSetActiveDeck', 'songPanes', 'djCueHeld', 'performance', `
    const djFocusArmed = { a: false, b: false };
    const djCueReleasedAt = { a: 0, b: 0 };
    ${grab('djFocusAfterLoad')}
    ${grab('djDeckAuditioning')}
    ${grab('djFocusOnPlay')}
    return { djFocusAfterLoad, djFocusOnPlay, djCueReleasedAt };
  `)(true, (d) => focus.push(d), songPanes, djCueHeld, { now: () => now });
  return { ...api, focus, songPanes, djCueHeld, tick: (ms) => { now += ms; } };
}

test('a load alone moves nothing; the loaded deck starting moves the focus across', () => {
  const r = rig();
  r.djFocusAfterLoad('a');
  r.djFocusOnPlay('a', false);
  assert.deepEqual(r.focus, [], 'loaded, not playing - a change of mind still lands on deck A');
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, ['b']);
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, ['b'], 'once per load - the next frame of it playing moves nothing');
});

test('a deck nobody loaded starting moves nothing', () => {
  const r = rig();
  r.djFocusOnPlay('b', true);
  assert.deepEqual(r.focus, []);
});

test('a song held on its cue is an audition, and so is the moment after a code deck\'s cue lets go', () => {
  const r = rig();
  r.djFocusAfterLoad('a');
  r.songPanes.a.mirror = { cueHeld: true };
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, []);
  r.songPanes.a.mirror = { cueHeld: false };
  r.djCueHeld.a = { cued: false };
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, [], 'a code deck playing because its cue is held');
  r.djCueHeld.a = null;
  r.djCueReleasedAt.a = 10000; // released just now: its stop has not landed yet
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, []);
  r.tick(1500); // still playing well after the release - cue into play
  r.djFocusOnPlay('a', true);
  assert.deepEqual(r.focus, ['b']);
});
