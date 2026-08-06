'use strict';

// Unit tests for the prefer-VST3 plugin list filter (plugin-filter.js) - pure data in/out.

const { test } = require('node:test');
const assert = require('node:assert');

const { isVst3, preferVst3 } = require('./plugin-filter.js');

const p = (id, name, format) => ({ id, name, format });

test('isVst3 recognizes either the id extension or the sdk string', () => {
  assert.ok(isVst3(p('Mangle.vst3', 'Mangle', 'VST 3.6.6')));
  assert.ok(isVst3(p('Mangle.vst3', 'Mangle', undefined)), 'id extension alone is enough');
  assert.ok(isVst3(p('Mangle', 'Mangle', 'VST 3')), 'sdk string alone is enough');
  assert.ok(!isVst3(p('Mangle', 'Mangle', 'VST 2.4')));
  assert.ok(!isVst3(p('Mangle', 'Mangle', undefined)), 'no signal means not VST3');
});

test('a VST2 entry is dropped when a VST3 with the same name exists', () => {
  const list = [
    p('Mangle', 'Mangle', 'VST 2.4'),
    p('Mangle.vst3', 'Mangle', 'VST 3.6.6'),
    p('PunchBox', 'PunchBox', 'VST 2.4'), // VST2-only - must survive
    p('Diva.vst3', 'Diva', 'VST 3.6.6'), // VST3-only - must survive
  ];
  assert.deepStrictEqual(
    preferVst3(list).map((x) => x.id),
    ['Mangle.vst3', 'PunchBox', 'Diva.vst3'],
  );
});

test('order is preserved and VST3 entries are never dropped, whichever comes first', () => {
  const list = [
    p('EchoBoy.vst3', 'EchoBoy', 'VST 3.6.6'),
    p('EchoBoy', 'EchoBoy', 'VST 2.4'),
  ];
  assert.deepStrictEqual(preferVst3(list).map((x) => x.id), ['EchoBoy.vst3']);
});

test('names must match exactly - near-misses are not shadowed', () => {
  const list = [
    p('FilterFreak1.vst3', 'FilterFreak1', 'VST 3.6.6'),
    p('FilterFreak2', 'FilterFreak2', 'VST 2.4'),
  ];
  assert.strictEqual(preferVst3(list).length, 2);
});

test('an empty list stays empty', () => {
  assert.deepStrictEqual(preferVst3([]), []);
});
