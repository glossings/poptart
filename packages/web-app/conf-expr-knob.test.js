'use strict';

// Turning a knob whose .param() value has audio in it, or ends in its own `.add(number)`, moves
// that number - the knob - and leaves what is patched onto it alone (client.js's upsertParam).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found - this test needs updating`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

// A one-buffer editor and the one .param() call in it: enough of the surroundings for the write.
function turn(code, value) {
  let text = code;
  const ed = {
    getValue: () => text,
    posFromIndex: (i) => i,
    replaceRange: (s, from, to = from) => { text = text.slice(0, from) + s + text.slice(to); },
  };
  const findParamCall = (src) => {
    const m = /\.param\("P",/.exec(src);
    if (!m) return null;
    let depth = 0;
    for (let i = m.index + 6; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return { valueStart: m.index + m[0].length, valueEnd: i };
    }
    return null;
  };
  // eslint-disable-next-line no-new-func
  const upsertParam = new Function('labelsMod', 'deckTrackParts', 'blockForTrack', 'findParamCall', 'findChainCall', 'logLine',
    `${grab(CLIENT, 'upsertParam')}; return upsertParam;`)(
    {}, () => ({ ed, label: 'x' }), () => ({ start: 0, end: text.length }), findParamCall, () => null, () => {},
  );
  upsertParam('x', 0, 'P', value);
  return text;
}

test('a plain value is replaced, as it always was', () => {
  assert.equal(turn('x: synth("W").param("P", 0.2)', 0.7), 'x: synth("W").param("P", 0.7)');
});

test('the number a patched value is added to is the knob', () => {
  assert.equal(
    turn('x: synth("W").param("P", audio("lfo").mul(0.2).add(0.4))', 0.65),
    'x: synth("W").param("P", audio("lfo").mul(0.2).add(0.65))',
  );
});

test('a patched value with no number of its own gets one', () => {
  assert.equal(
    turn('x: synth("W").param("P", audio("lfo").mul(0.2) )', 0.5),
    'x: synth("W").param("P", audio("lfo").mul(0.2).add(0.5) )',
  );
});

test('any value that ends in .add(number) keeps the rest, modulators included', () => {
  assert.equal(
    turn('x: synth("W").param("P", sine().mul(lfo()).add(.3))', 0.25),
    'x: synth("W").param("P", sine().mul(lfo()).add(0.25))',
  );
});
