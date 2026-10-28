// The color picker's side of the code: where a `.color()` is, and the one edit a pick makes to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './src/index.mjs';

const { findColorCalls, findColorCallAt, colorCallEdit, setPatternWarn } = core;

const apply = (code, e) => code.slice(0, e.from) + e.text + code.slice(e.to);
const pick = (code, hex, n = 0) => apply(code, colorCallEdit(findColorCalls(code)[n], hex));

test('finds dotted .color() calls only, outside strings and comments', () => {
  const code = [
    'a: s("bd").color()',
    'b: s("hh") .color( "pink" )',
    '// c: s("x").color("red")',
    'd: s(".color()").colors(1)',
    'color("blue")',
    'e: s("sd")',
    '  .color(\'#ff7a9c\')',
  ].join('\n');
  const found = findColorCalls(code);
  assert.equal(found.length, 3);
  assert.equal(found[0].arg, null);
  assert.equal(found[1].lit.text, 'pink');
  assert.equal(found[2].lit.text, '#ff7a9c');
  for (const c of found) assert.equal(code.slice(c.at, c.at + 5), 'color');
});

test('a pick writes a bare call as a double-quoted hex', () => {
  assert.equal(pick('a: s("bd").color().gain(0.5)', '#12abef'), 'a: s("bd").color("#12abef").gain(0.5)');
  assert.equal(pick('a: s("bd").color(   )', '#12abef'), 'a: s("bd").color("#12abef")');
});

test('a pick replaces a written name or hex, keeping its quotes and spacing', () => {
  assert.equal(pick('a: s("bd").color( "pink" )', '#00ff00'), 'a: s("bd").color( "#00ff00" )');
  assert.equal(pick("a: s('bd').color('#abc')", '#00ff00'), "a: s('bd').color('#00ff00')");
  assert.equal(pick('a: s("bd").color(`tomato`)', '#00ff00'), 'a: s("bd").color(`#00ff00`)');
});

test('a pick keeps the call\'s other arguments, and replaces a first argument that is not a literal', () => {
  assert.equal(pick('a: s("bd").color("red", /* why */ 2)', '#0000ff'), 'a: s("bd").color("#0000ff", /* why */ 2)');
  assert.equal(pick('a: s("bd").color(mine, 2)', '#0000ff'), 'a: s("bd").color("#0000ff", 2)');
  assert.equal(pick('a: s("bd").color(`x${y}`)', '#0000ff'), 'a: s("bd").color("#0000ff")');
});

test('only the call that was picked changes', () => {
  const code = 'a: s("bd").color("red")\nb: s("hh").color()';
  assert.equal(pick(code, '#111111', 1), 'a: s("bd").color("red")\nb: s("hh").color("#111111")');
});

test('the call under an index, and whether the index is on its name', () => {
  const code = 'a: s("bd").color("red").gain(1)';
  const at = code.indexOf('color');
  assert.equal(findColorCallAt(code, at).onName, true);
  assert.equal(findColorCallAt(code, at + 3).onName, true);
  assert.equal(findColorCallAt(code, at + 8).onName, false);
  assert.equal(findColorCallAt(code, code.indexOf('gain')), null);
});

test('a bare .color() is the automatic color, and says nothing', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    assert.equal(core.s('bd').color().trackColor, null);
    assert.equal(core.s('bd').color('red').color().trackColor, null);
    assert.equal(warned.length, 0);
  } finally {
    setPatternWarn(null);
  }
});
