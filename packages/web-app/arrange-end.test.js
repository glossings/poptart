'use strict';

// The end of a deck's arrangement.
//
// A song runs from bar 0 to the end of its last clip and stops there unless a loop region holds
// it. The clock says WHEN that is (pattern-core's ArrangeClock#endCycle, pinned in its own tests);
// what is pinned here is the host's side of it - that a deck is stopped only when it is that
// deck's own playback that has run off the end, and that the stop is the ordinary per-deck one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// server.js spawns an engine on require, so these are read out of the source and given their own
// dependencies - the same trick song-end.test.js uses.
function grab(name) {
  const at = SERVER.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  for (let i = SERVER.indexOf('{', at); i < SERVER.length; i++) {
    if (SERVER[i] === '{') depth++;
    else if (SERVER[i] === '}' && --depth === 0) return SERVER.slice(at, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

async function host({ cycle = 0, paused = false, running = ['kick', 'b:hat'] } = {}) {
  const { ArrangeClock } = await import('../pattern-core/src/arrange.mjs');
  const stopped = [];
  const env = {
    arrangeClocks: { a: null, b: null },
    schedulers: new Map(running.map((key) => [key, { running: true }])),
    deckOfKey: (key) => (key.startsWith('b:') ? 'b' : 'a'),
    engine: { getTime: () => 0 },
    transport: { paused, cycleAt: () => cycle },
    stopPlayback: (deck) => stopped.push(deck),
  };
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(env),
    `${grab('deckRunning')}\n${grab('arrangeEnded')}\n${grab('arrangeEndWatch')}\nreturn { deckRunning, arrangeEnded, arrangeEndWatch };`)(...Object.values(env));
  return { ...fns, env, stopped, ArrangeClock };
}

test('a deck past the end of its arrangement is stopped, and only that deck', async () => {
  const h = await host({ cycle: 8.01 });
  h.env.arrangeClocks.a = new h.ArrangeClock({ end: 8 });
  h.env.arrangeClocks.b = new h.ArrangeClock({ end: 32 });
  assert.equal(h.arrangeEnded('a'), true);
  assert.equal(h.arrangeEnded('b'), false);
  h.arrangeEndWatch();
  assert.deepEqual(h.stopped, ['a']);
});

test('an armed loop region ahead means there is no end to reach', async () => {
  const h = await host({ cycle: 100 });
  h.env.arrangeClocks.a = new h.ArrangeClock({ end: 8, regions: [{ name: 'song', start: 0, end: 8 }] });
  assert.equal(h.arrangeEnded('a'), false);
  h.env.arrangeClocks.a.release(100);
  assert.equal(h.arrangeEnded('a'), false, 'released in bar 4: four bars still to play');
  h.env.transport.cycleAt = () => 104;
  assert.equal(h.arrangeEnded('a'), true);
});

test('nothing ends on a stopped clock, a stopped deck, or a deck with no arrangement', async () => {
  const paused = await host({ cycle: 50, paused: true });
  paused.env.arrangeClocks.a = new paused.ArrangeClock({ end: 8 });
  assert.equal(paused.arrangeEnded('a'), false);
  const idle = await host({ cycle: 50, running: ['b:hat'] });
  idle.env.arrangeClocks.a = new idle.ArrangeClock({ end: 8 });
  assert.equal(idle.arrangeEnded('a'), false, 'deck A is not playing: there is nothing to stop');
  assert.equal(idle.arrangeEnded('b'), false, 'and deck B has no arrangement');
});

test('the end is the ordinary stop, and the clock is a function of the regions alone', () => {
  assert.match(SERVER, /'POST \/api\/stop': async \(body\) => \(\{[\s\S]{0,120}stopPlayback\(/);
  assert.match(grab('arrangeEndWatch'), /stopPlayback\(deck\);/);
  assert.match(SERVER, /const clockKey = JSON\.stringify\(regions\);/, 'painting clips must never rebuild the clock');
  assert.match(SERVER, /arrangeClocks\[deck\]\.rebuilt\(\{ regions \}, nowCycle\)/, 'and changed regions rebuild it where it stands');
});
