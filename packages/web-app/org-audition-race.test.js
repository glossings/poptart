'use strict';

// Organize auditions a row the moment it is picked, but a whole song takes seconds to fetch and
// decode. Loading that row onto a deck closes the window in the meantime - and the audition used
// to start anyway once the decode landed: a song playing out of the browser, past the desk's
// faders and meters, with no window left to stop it. Closing the window has to cancel it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const m = new RegExp(`\\n((?:async )?function ${name}\\()`).exec(CLIENT);
  assert.ok(m, `${name} not found in client.js - this test needs updating`);
  const at = m.index + 1;
  let depth = 0;
  for (let i = CLIENT.indexOf(') {', at) + 2; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++;
    else if (CLIENT[i] === '}' && --depth === 0) return CLIENT.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

function rig() {
  let land;
  const started = [];
  const ctx = vm.createContext({
    orgPlayer: { abs: null, name: '', buffer: null, source: null, offset: 0, playing: false, raf: null, gen: 0 },
    orgLoadBuffer: () => new Promise((r) => { land = r; }),
    orgPlayerStart: (at) => started.push(at),
    auditionBlocked: () => null,
    orgRenderTransport() {}, orgMarkPlaying() {}, orgSay() {}, orgOnKey() {}, cancelAnimationFrame() {},
    orgHeld: null, orgForDeck: 'b', orgEditing: null, orgMenu: null, orgEl: null,
    window: { removeEventListener() {} },
  });
  vm.runInContext([grab('orgPlay'), grab('orgPlayerStopSource'), grab('closeOrganize')].join('\n'), ctx);
  return { ctx, started, land: () => land({ duration: 300 }) };
}

test('a decode that lands after the window closed does not start playing', async () => {
  const r = rig();
  const playing = r.ctx.orgPlay('/music/rola.aiff', 'rola');
  r.ctx.closeOrganize(); // the row went onto a deck before its audition arrived
  r.land();
  await playing;
  assert.deepEqual(r.started, []);
});

test('with the window still open, the audition starts as soon as it lands', async () => {
  const r = rig();
  const playing = r.ctx.orgPlay('/music/rola.aiff', 'rola');
  r.land();
  await playing;
  assert.deepEqual(r.started, [0]);
});
