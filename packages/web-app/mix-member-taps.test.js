'use strict';

// A group MEMBER taps nothing of its own (server.js's mixTapDeck): no deck meter side, no
// headphone cue, no FX send. Its sound reaches the desk through its group's bus, and the group's
// track meters, cues and feeds the FX unit with it - while the deck-wide controls (trim, EQ,
// filter, cue) are sent to channels, never to members. A member that tapped too carried its
// signal a second time, untrimmed: a deck with its trim at zero, silent in the room, metered
// +6 dB from its drum group's members (reported 2026-10-06).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf(') {', at) + 2;
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}
function grabLine(re, what) {
  const m = SRC.match(re);
  assert.ok(m, `${what} not found in server.js - this test needs updating`);
  return m[0];
}

const make = new Function('groupMembers', 'mixState', 'engine', 'fxTracksLive', 'deckXfGain', `
  const deckOfKey = (key) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : 'a');
  const engineTrack = (key) => key;
  const FX_BUSES = { a: '#fxa', b: '#fxb' };
  const fxSendLevels = () => ({ a: 1, b: 1 });
  const DJ_NEUTRAL = { trim: 1, cue: 0, deck: 1 };
  ${grabLine(/^const mixTapDeck = .*;$/m, 'mixTapDeck')}
  ${grabFn('mixBirthFor')}
  ${grabFn('fxApplyTo')}
  ${grabFn('applyMixTo')}
  ${grabFn('neutralizeMix')}
  return { mixTapDeck, mixBirthFor, applyMixTo, neutralizeMix };
`);

function rig() {
  const groupMembers = new Map([['kick', 'drums'], ['snare', 'drums'], ['b:hats', 'b:perc']]);
  const mixState = {
    perDeck: { a: new Map([['trim', 0], ['cue', 1]]), b: new Map() },
    perTrack: new Map(),
    faders: { a: 1, b: 1 },
  };
  const sent = [];
  const engine = {
    setParam: (tid, slot, name, value) => sent.push([tid, name, value]),
    setFxSend: (tid, bus, level) => sent.push([tid, 'fxSend', level]),
  };
  const api = make(groupMembers, mixState, engine, { a: true, b: false }, () => 1);
  const last = (tid, name) => sent.filter(([t, n]) => t === tid && n === name).at(-1)?.[2];
  return { ...api, sent, last, groupMembers };
}

test('a member is born tapping nothing; a channel meters on its deck and wears the desk', () => {
  const r = rig();
  const member = r.mixBirthFor('kick');
  assert.equal(member.mdeck, -1, 'no deck meter side');
  assert.equal(member.cue, 0, "its group's cue covers it");
  const channel = r.mixBirthFor('drums');
  assert.equal(channel.mdeck, 0);
  assert.equal(channel.trim, 0, 'the deck-wide trim');
  assert.equal(channel.cue, 1);
  assert.equal(r.mixBirthFor('b:perc').mdeck, 1);
  assert.equal(r.mixBirthFor('b:hats').mdeck, -1);
});

test('every evaluation re-points the taps - including a stem that left its group', () => {
  const r = rig();
  r.applyMixTo('kick');
  assert.equal(r.last('kick', 'mdeck'), -1);
  assert.equal(r.last('kick', 'cue'), 0, 'the deck cue is not passed to a member');
  assert.equal(r.last('kick', 'fxSend'), 0, 'feeds the FX unit through its group');
  r.applyMixTo('drums');
  assert.equal(r.last('drums', 'mdeck'), 0);
  assert.equal(r.last('drums', 'cue'), 1);
  assert.equal(r.last('drums', 'fxSend'), 1);
  r.groupMembers.delete('kick'); // edited out of the group
  r.applyMixTo('kick');
  assert.equal(r.last('kick', 'mdeck'), 0, 'a channel again - it meters');
  assert.equal(r.last('kick', 'cue'), 1);
});

test('complete-mix puts promoted channels on the A meter, but never a member', () => {
  const r = rig();
  r.neutralizeMix('drums');
  r.neutralizeMix('kick');
  assert.equal(r.last('drums', 'mdeck'), 0);
  assert.equal(r.last('kick', 'mdeck'), -1);
});
