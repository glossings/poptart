'use strict';

// One deck full-screen in DJ mode (its ⤢): the deck alone, looking like a session outside DJ mode
// - no other deck, no stacked waveforms, no mixer, no seams or rails - and closing it brings the
// desk back exactly as it was. Asked for 2026-10-22.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');

function grab(name) {
  const at = CLIENT.indexOf(`\nfunction ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  for (let i = CLIENT.indexOf(') {', at) + 2; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++;
    else if (CLIENT[i] === '}' && --depth === 0) return CLIENT.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

test('a zoomed deck hides the mixer, the stacked waveforms, and every seam and rail', () => {
  const rule = /body\.mix-on\.dj-zoomed #mixStrip,\s*body\.mix-on\.dj-zoomed #songStack,\s*body\.mix-on\.dj-zoomed \.dj-rail,\s*body\.mix-on\.dj-zoomed \.dj-resize \{\s*display: none;/;
  assert.match(CSS, rule);
  assert.match(grab('djSetZoom'), /document\.body\.classList\.toggle\('dj-zoomed', !!djZoomedDeck\);/);
});

test('the stack steps out while zoomed, so a file deck has its waveform in its own pane', () => {
  assert.match(grab('applyMixStack'), /const on = mixStacked && mixModeOn && !djZoomedDeck;/);
  assert.match(grab('djSetZoom'), /applyMixStack\(\);/);
});

test('the zoom gives the decks the page without touching the stored sizes or folds', () => {
  const sizes = grab('djApplyRegionSizes');
  const branch = sizes.slice(sizes.indexOf('if (djZoomedDeck) {'), sizes.indexOf('const stacked = djStacked();'));
  assert.match(branch, /'--dj-row-decks', 'minmax\(0, 1fr\)'/);
  assert.match(branch, /'--dj-row-strip', 'auto'/);
  assert.ok(!/localStorage|djRegions\.\w+ =/.test(branch), 'zooming must not save or rewrite the region layout');
  assert.match(grab('djSetZoom'), /djApplyRegionSizes\(false\);/);
});

test('djZoomedDeck is declared before the page-load calls that read it', () => {
  // applyMixStack and djApplyRegionSizes both run as the page loads; a `let` declared after that
  // call is a ReferenceError that takes the whole client down.
  const declared = CLIENT.indexOf('\nlet djZoomedDeck = null;');
  const firstLoadCall = CLIENT.indexOf('\napplyMixStack();');
  assert.ok(declared > 0 && firstLoadCall > 0);
  assert.ok(declared < firstLoadCall, 'djZoomedDeck must be declared ahead of the top-level applyMixStack() call');
});
