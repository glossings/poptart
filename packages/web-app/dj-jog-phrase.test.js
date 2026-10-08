'use strict';

// Two small pieces of the desk that are pure arithmetic: the ladder a deck's jog size walks
// (server.js's deckJogApply - one button and one pad step along it, so it has to come round at
// both ends) and the phrase . bar . beat counter each deck shows (client.js's deckPhraseLabel).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `could not find ${what}`);
  return m[0];
}
const grabFn = (src, name) => grab(src, new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'), `function ${name}`);
const grabConst = (src, name) => grab(src, new RegExp(`^const ${name} = .*;$`, 'm'), `const ${name}`);

function jogRig() {
  const mixState = { deckJog: { a: { beats: 1 }, b: { beats: 1 } } };
  let notified = 0;
  // eslint-disable-next-line no-new-func
  const deckJogApply = new Function('mixState', 'mixNotify', `
    ${grabConst(SERVER, 'DECK_JOG_BEATS')}
    ${grabFn(SERVER, 'deckJogApply')}
    return deckJogApply;
  `)(mixState, () => { notified++; });
  return { deckJogApply, mixState, notified: () => notified };
}

test('the jog size steps up a ladder of musical lengths and comes round at both ends', () => {
  const r = jogRig();
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(r.deckJogApply('a', { step: 1 }).beats);
  assert.deepEqual(seen, [2, 4, 8, 16, 32, 1]);
  assert.equal(r.deckJogApply('a', { step: -1 }).beats, 32, 'back from the first rung is the last');
  assert.equal(r.mixState.deckJog.b.beats, 1, 'the other deck keeps its own');
  assert.ok(r.notified() >= 7, 'every change is told to the desk');
});

test('a jog size can be named outright, and only a rung of the ladder is one', () => {
  const r = jogRig();
  assert.equal(r.deckJogApply('b', { beats: 16 }).beats, 16);
  assert.throws(() => r.deckJogApply('b', { beats: 3 }), /beats must be one of/);
  assert.equal(r.mixState.deckJog.b.beats, 16, 'a refused size changes nothing');
});

// eslint-disable-next-line no-new-func
const deckPhraseLabel = new Function(`
  ${grabConst(CLIENT, 'PHRASE_BARS')}
  ${grabFn(CLIENT, 'deckPhraseLabel')}
  return deckPhraseLabel;
`)();

test('a deck counts phrase . bar . beat from its first downbeat, each from one', () => {
  assert.equal(deckPhraseLabel(0), '1.1.1');
  assert.equal(deckPhraseLabel(3.9), '1.1.4');
  assert.equal(deckPhraseLabel(4), '1.2.1');
  assert.equal(deckPhraseLabel(31.5), '1.8.4', 'the last beat of the first phrase');
  assert.equal(deckPhraseLabel(32), '2.1.1', 'eight bars on, the bar count comes back to one');
  assert.equal(deckPhraseLabel(32 * 3 + 4 * 2 + 1), '4.3.2');
});

test('the counter holds through the beat it is on, and counts down into the downbeat before it', () => {
  assert.equal(deckPhraseLabel(3.9999999), '1.2.1', 'a hair under a beat is that beat - clocks arrive as floats');
  assert.equal(deckPhraseLabel(-1), '0.8.4', 'the beat before the first downbeat');
  assert.equal(deckPhraseLabel(NaN), '');
});
