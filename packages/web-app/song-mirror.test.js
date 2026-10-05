'use strict';

// The song pane's MIRROR of a deck (public/client.js): the object every draw reads, rebuilt from
// the desk's SSE frame by P.sync.
//
// It is assembled field by field - deliberately, because a scrubbing hand owns the position and
// must not have it overwritten - and that is the hazard: the server can send a field, the drawing
// can read it, and the mirror can quietly drop it in between. Nothing fails. The pane just draws
// from `undefined` and falls back to something close enough to look plausible.
//
// It has happened twice. `syncMult` was left out once and the ratio button read 1x over a deck the
// server had at 1/2x. And `baseRate` was left out, which is what the strip is SCALED by: the scale
// fell back to the live rate, so holding a platter button zoomed the whole waveform by 4% and let
// it back on release (reported 2026-10-05, and the thing that makes it nasty is that the fix for
// it was already written and correct - scaleRateNow reads exactly the right field).
//
// So this is the invariant rather than the two bugs: every field read off the mirror is a field
// sync() puts there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/** makeSongPane's body - the mirror and every reader of it live inside this one closure. */
function songPaneSource() {
  const at = CLIENT.indexOf('function makeSongPane(');
  assert.ok(at > 0, 'makeSongPane not found in client.js - this test needs updating');
  // To the next top-level function declaration, which is as far as the closure can reach.
  const end = CLIENT.indexOf('\nfunction ', at + 10);
  assert.ok(end > at, 'could not find the end of makeSongPane');
  return CLIENT.slice(at, end);
}

/** What P.sync writes onto the mirror, from both the rebuild and the Object.assign after it. */
function mirrorWrites(src) {
  const at = src.indexOf('P.sync = (sb) => {');
  assert.ok(at > 0, 'P.sync not found - this test needs updating');
  const body = src.slice(at, src.indexOf('\n  };', at));
  const written = new Set();
  // Every entry whose value comes off the frame (`name: sb.…`, however it is defaulted), wherever
  // it sits - the rebuild puts several on one line and the Object.assign one per line. Plus the
  // explicit assignments the scrubbing branch makes.
  for (const m of body.matchAll(/([A-Za-z][A-Za-z0-9]*):\s*[^,}]*\bsb\./g)) written.add(m[1]);
  for (const m of body.matchAll(/P\.mirror\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) written.add(m[1]);
  return written;
}

/** Every field the pane reads back off the mirror. */
function mirrorReads(src) {
  const read = new Set();
  for (const m of src.matchAll(/P\.mirror\??\.([A-Za-z][A-Za-z0-9]*)/g)) read.add(m[1]);
  for (const m of src.matchAll(/mirror\??\.([A-Za-z][A-Za-z0-9]*)/g)) read.add(m[1]);
  return read;
}

test('every field the pane reads off its mirror is one sync() puts there', () => {
  const src = songPaneSource();
  const written = mirrorWrites(src);
  const read = mirrorReads(src);
  // Not fields - the mirror is replaced wholesale and tested for existence in places.
  const notFields = new Set(['length', 'constructor']);
  const missing = [...read].filter((f) => !written.has(f) && !notFields.has(f)).sort();
  assert.deepEqual(missing, [],
    'the pane draws from these but sync() never writes them, so they read as undefined: '
    + `${missing.join(', ')}`);
});

test('baseRate in particular makes the whole round trip', () => {
  // Named on its own because all three halves were present and it still did not work: the server
  // sent it, the drawing read it, and only the mirror dropped it.
  assert.match(SERVER, /baseRate: songBaseRate\(d\)/, 'the desk frame has to carry it');
  const src = songPaneSource();
  assert.match(src, /baseRate: sb\.baseRate/, 'sync() has to keep it');
  assert.match(src, /const base = P\.mirror\?\.baseRate;/, 'and the scale has to read it');
});

test('the strip is scaled by the settled rate, never the momentary one', () => {
  // A nudge or a platter bend is a phase correction, not a tempo: it has to SLIDE the waveform
  // (the playhead moves faster) and must not rescale it.
  const src = songPaneSource();
  const at = src.indexOf('const span = zoomSec *');
  assert.ok(at > 0, 'the strip no longer computes a span - this test needs updating');
  assert.match(src.slice(at, at + 60), /scaleRateNow\(\)/,
    'the span is scaled by the live rate again - a held platter button will zoom the view');
  // ...and the server's own half of that: the nudge writes its own field, not the base rate.
  const nudge = SERVER.slice(SERVER.indexOf('function songNudge('));
  const body = nudge.slice(0, nudge.indexOf('\n}'));
  assert.match(body, /s\.nudge = /);
  assert.ok(!/manualRate\s*=/.test(body), 'a nudge that moved manualRate would rescale the strip from the server side');
});
