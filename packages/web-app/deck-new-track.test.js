'use strict';

// A deck head's ＋ new: an empty livecode track on that deck, with whatever it held cleared off it
// the way a load clears it - and never on a deck that is playing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function grab(name) {
  const at = CLIENT.indexOf(`async function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  for (let i = CLIENT.indexOf(') {', at) + 2; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++;
    else if (CLIENT[i] === '}' && --depth === 0) return CLIENT.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

function rig({ playing = { a: false, b: false } } = {}) {
  const calls = [];
  const deckB = {
    value: 'kick: s("bd*4")', readOnly: true, focused: false,
    setOption: (k, v) => { if (k === 'readOnly') deckB.readOnly = v; },
    setValue: (v) => { deckB.value = v; },
    focus: () => { deckB.focused = true; },
  };
  const state = { deckBFileName: 'old-song' };
  const deps = {
    mixModeOn: true,
    deckPlayingNow: playing,
    api: async (method, url, body) => { calls.push(`${url} ${body?.deck}`); return {}; },
    clearPatternRegions: (d) => calls.push(`regions ${d}`),
    songPanes: { a: { clear: () => calls.push('pane a') }, b: { clear: () => calls.push('pane b') } },
    newPatternFile: async () => calls.push('new pattern'),
    deckBCM: deckB,
    forgetExpandedFolds: () => {},
    refoldAll: () => {},
    logLine: (line, bad) => calls.push(`${bad ? 'WARN ' : ''}${line}`),
    djSetActiveDeck: (d) => calls.push(`active ${d}`),
    mixRefresh: () => {},
  };
  const names = Object.keys(deps);
  // deckBFileName is written, so it is a variable of the function's scope here, read back after.
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `let deckBFileName = 'old-song';\n${grab('newDeckTrack')}\nreturn { newDeckTrack, file: () => deckBFileName };`);
  const api = make(...names.map((n) => deps[n]));
  return { ...api, calls, deckB, state };
}

test('deck B: cleared engine-side, an empty editable buffer, no file, and the deck is the one being worked', async () => {
  const r = rig();
  await r.newDeckTrack('b');
  assert.deepEqual(r.calls.slice(0, 3), ['/api/mix/clear b', 'regions b', 'pane b']);
  assert.equal(r.deckB.value, '');
  assert.equal(r.deckB.readOnly, false, 'a song card left the editor read-only');
  assert.equal(r.file(), null);
  assert.ok(r.deckB.focused);
  assert.ok(r.calls.includes('active b'));
});

test('deck A is the files tab\'s new pattern, after the deck is cleared', async () => {
  const r = rig();
  await r.newDeckTrack('a');
  assert.deepEqual(r.calls.slice(0, 4), ['/api/mix/clear a', 'regions a', 'pane a', 'new pattern']);
});

test('a playing deck is left alone, and says why', async () => {
  const r = rig({ playing: { a: false, b: true } });
  await r.newDeckTrack('b');
  assert.deepEqual(r.calls, ['WARN deck B is playing - stop it first to start a new track on it']);
  assert.equal(r.deckB.value, 'kick: s("bd*4")');
});

test('both deck heads carry the button, beside the song picker', () => {
  assert.match(HTML, /id="deckASong"[^\n]*\n\s*<button id="deckANew" class="small deck-only"[^>]*>＋ new<\/button>/);
  assert.match(HTML, /id="deckBSong"[^\n]*\n\s*<button id="deckBNew" class="small"[^>]*>＋ new<\/button>/);
  assert.match(CLIENT, /getElementById\('deckBNew'\)\.addEventListener\('click', \(\) => newDeckTrack\('b'\)\)/);
  assert.match(CLIENT, /getElementById\('deckANew'\)\.addEventListener\('click', \(\) => newDeckTrack\('a'\)\)/);
});
