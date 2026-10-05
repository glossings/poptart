'use strict';

// The projector feed's server half: what another program receives when it subscribes.
//
// The contract is FLAT and agreed with the consumer - `{ text, ranges }`, one string and one list
// of [start, end) offsets into it, whatever is playing. Which decks exist, which are playing, and
// how to rebase the second one's offsets past the first are poptart's business and are settled
// here; `?deck=` and `?collapse=` are the only knobs. It crosses into somebody else's renderer, so
// the shape of it is a promise rather than an internal detail: a range that is a string, or one
// that points past the end of the text, is a crash over there in code that had no part in making
// it. setProjectorFrame and projectorFeedBody are the two places that decide it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { flattenProjectorFrame } = require('./public/projector-frame.js');

// server.js spawns an engine on require, so the feed's functions are read out of the source with
// state of their own - the same trick highlight-grid.test.js uses on highlightGrid.
function loadFeed() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const names = [
    'projectorFeedHead', 'projectorFeedOptions', 'projectorFeedBody',
    'serveProjectorEvents', 'setProjectorFrame',
  ];
  const parts = names.map((name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
    // Past the parameter list before counting braces: a destructured parameter has braces of its
    // own, and starting at the first `{` after the name cuts the function off at its signature.
    let depth = 0;
    let open = src.indexOf('(', at);
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) { open = i; break; }
    }
    let end = src.indexOf('{', open);
    depth = 0;
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(at, end);
  });
  // eslint-disable-next-line no-new-func
  return new Function('flattenProjectorFrame', `
    const projectorClients = new Set();
    let projectorDecks = [];
    let projectorCollapse = true;
    ${parts.join('\n')}
    return {
      ${names.join(', ')},
      held: () => ({ decks: projectorDecks, collapse: projectorCollapse }),
    };`)(flattenProjectorFrame);
}

/** A stand-in for a subscriber's response stream: records what was written to it. */
function fakeClient() {
  const lines = [];
  return {
    head: null,
    lines,
    frames: () => lines.map((l) => JSON.parse(l.replace(/^data: /, ''))),
    last: function last() { return this.frames()[this.lines.length - 1]; },
    writeHead(status, headers) { this.head = { status, headers }; },
    write(line) { lines.push(line); },
    on(event, fn) { if (event === 'close') this.close = fn; },
  };
}

const DECKS = [
  { deck: 'a', text: 'kick: s("bd*4")', spans: [[9, 13]] },
  { deck: 'b', text: 'hat: s("hh*8")', spans: [[8, 12]] },
];

/** What a range actually covers in the frame that carried it - the contract, checked as one. */
const lit = (frame) => frame.ranges.map(([s, e]) => frame.text.slice(s, e));

test('a subscriber is sent the set already playing, before anything changes', () => {
  const feed = loadFeed();
  feed.setProjectorFrame({ collapse: true, decks: DECKS.slice(0, 1) });
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  assert.equal(client.head.status, 200);
  assert.deepEqual(client.frames(), [{ text: 'kick: s("bd*4")', ranges: [[9, 13]] }]);
});

test('the frame is flat: the decks are joined and the ranges rebased onto the join', () => {
  const feed = loadFeed();
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  feed.setProjectorFrame({ collapse: true, decks: DECKS });
  const frame = client.last();
  assert.equal(frame.text, 'kick: s("bd*4")  hat: s("hh*8")');
  // Whatever the arithmetic, this is what the consumer was promised.
  assert.deepEqual(lit(frame), ['bd*4', 'hh*8']);
  assert.equal('decks' in frame, false);
  assert.equal('v' in frame, false);
  assert.equal('collapse' in frame, false);
});

test('?deck= takes one deck, and its ranges start from that deck alone', () => {
  const feed = loadFeed();
  feed.setProjectorFrame({ collapse: true, decks: DECKS });
  const client = fakeClient();
  feed.serveProjectorEvents(client, { deck: 'b' });
  assert.deepEqual(client.last(), { text: 'hat: s("hh*8")', ranges: [[8, 12]] });
});

test('a deck that is not playing is simply not in the frame', () => {
  const feed = loadFeed();
  feed.setProjectorFrame({ collapse: true, decks: DECKS.slice(0, 1) });
  const client = fakeClient();
  feed.serveProjectorEvents(client, { deck: 'b' });
  assert.deepEqual(client.last(), { text: '', ranges: [] });
});

test('?collapse=0 overrides poptart\'s own setting, for that subscriber only', () => {
  const feed = loadFeed();
  const plain = fakeClient();
  const raw = fakeClient();
  feed.serveProjectorEvents(plain, {});
  feed.serveProjectorEvents(raw, { collapse: '0' });
  feed.setProjectorFrame({ collapse: true, decks: [{ deck: 'a', text: 'kick:\n  s("bd")', spans: [[11, 13]] }] });
  assert.equal(plain.last().text, 'kick: s("bd")');
  assert.equal(raw.last().text, 'kick:\n  s("bd")');
  // Both still point at the same atom, which is the only thing a consumer can rely on.
  assert.deepEqual(lit(plain.last()), ['bd']);
  assert.deepEqual(lit(raw.last()), ['bd']);
});

test('an unknown ?deck or a junk ?collapse falls back rather than serving nothing', () => {
  const feed = loadFeed();
  assert.deepEqual(feed.projectorFeedOptions({ deck: 'z' }), { deck: null, collapse: null });
  assert.deepEqual(feed.projectorFeedOptions({}), { deck: null, collapse: null });
  assert.equal(feed.projectorFeedOptions({ collapse: '0' }).collapse, false);
  assert.equal(feed.projectorFeedOptions({ collapse: '1' }).collapse, true);
});

test('every frame after the first reaches every subscriber, as one SSE event each', () => {
  const feed = loadFeed();
  const one = fakeClient();
  const two = fakeClient();
  feed.serveProjectorEvents(one, {});
  feed.serveProjectorEvents(two, {});
  assert.equal(feed.setProjectorFrame({ decks: [{ deck: 'a', text: 'x' }] }), 2);
  for (const client of [one, two]) {
    assert.equal(client.lines.length, 2); // the state on connect, then the new frame
    assert.ok(client.lines[1].startsWith('data: ') && client.lines[1].endsWith('\n\n'));
    assert.equal(client.last().text, 'x');
  }
});

test('a subscriber that has gone is not written to again', () => {
  const feed = loadFeed();
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  client.close();
  assert.equal(feed.setProjectorFrame({ decks: [{ deck: 'a', text: 'y' }] }), 0);
  assert.equal(client.lines.length, 1);
});

test('the feed is readable from another origin, which is the whole point of it', () => {
  // A visuals environment is a different document and so a different origin; without this header
  // its EventSource connects and is never allowed to read a byte.
  assert.equal(loadFeed().projectorFeedHead()['Access-Control-Allow-Origin'], '*');
  assert.equal(loadFeed().projectorFeedHead()['Content-Type'], 'text/event-stream');
});

test('a malformed frame is made safe rather than passed on to somebody else\'s renderer', () => {
  const feed = loadFeed();
  feed.setProjectorFrame({
    decks: [
      { deck: 'a', text: 'ok', spans: [[0, 2], 'nonsense', [NaN, 3], [1]] },
      { text: null },
      'not a deck',
    ],
  });
  assert.deepEqual(feed.held().decks, [
    { deck: 'a', text: 'ok', spans: [[0, 2]] },
    { deck: '', text: '', spans: [] },
    { deck: '', text: '', spans: [] },
  ]);
});

test('a range is never served pointing past the end of the text it came with', () => {
  const feed = loadFeed();
  feed.setProjectorFrame({ decks: [{ deck: 'a', text: 'short', spans: [[2, 400]] }] });
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  const frame = client.last();
  assert.deepEqual(frame.ranges, [[2, 5]]);
  assert.deepEqual(lit(frame), ['ort']);
});

test('a frame that is nothing at all still leaves a well-formed one to serve', () => {
  const feed = loadFeed();
  feed.setProjectorFrame(undefined);
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  assert.deepEqual(client.frames(), [{ text: '', ranges: [] }]);
});

test('nothing playing is an empty string - the consumer\'s cue to draw nothing', () => {
  const feed = loadFeed();
  const client = fakeClient();
  feed.serveProjectorEvents(client, {});
  feed.setProjectorFrame({ collapse: true, decks: DECKS });
  feed.setProjectorFrame({ collapse: true, decks: [] });
  assert.deepEqual(client.last(), { text: '', ranges: [] });
});
