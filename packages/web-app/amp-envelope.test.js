'use strict';

// `@amp.<stage>` - .decay() and the rest on a synth - reaches the instrument's own amp-envelope
// control on the desktop, converted from seconds to the control's position; a plugin is told once.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MappedEngine } = require('./param-mapping.js');
const { nativeDevice } = require('@poptart/osc-engine/native-devices');

function wrapped(plugin) {
  const calls = [];
  const engine = { setParam: (...a) => calls.push(['setParam', ...a]), holdParam: (...a) => calls.push(['holdParam', ...a]) };
  const mapped = new MappedEngine(engine);
  const warned = [];
  mapped.warn = (line) => warned.push(line);
  mapped.setChain('t', [plugin]);
  return { mapped, calls, warned };
}

test('a Wavetable decay is its Amp Decay, at the position those seconds sit at', () => {
  const { mapped, calls } = wrapped('Wavetable');
  const param = nativeDevice('Wavetable').params.find((p) => p.amp === 'decay');
  assert.equal(param.name, 'Amp Decay');
  mapped.setParam('t', 0, '@amp.decay', param.max, 1);
  assert.deepEqual(calls.pop(), ['setParam', 't', 0, 'Amp Decay', 1, 1]);
  mapped.setParam('t', 0, '@amp.decay', param.min);
  assert.equal(calls.pop()[4], 0);
  mapped.holdParam('t', 0, '@amp.decay');
  assert.deepEqual(calls.pop(), ['holdParam', 't', 0, 'Amp Decay']);
});

test('the Granular synth has the same stages under its own names', () => {
  const { mapped, calls } = wrapped('Granular');
  mapped.setParam('t', 0, '@amp.release', 0);
  assert.equal(calls.pop()[3], 'Release');
});

test('a plugin is warned about once and sent nothing', () => {
  const { mapped, calls, warned } = wrapped('Serum 2');
  mapped.setParam('t', 0, '@amp.decay', 0.3);
  mapped.setParam('t', 0, '@amp.decay', 0.4);
  assert.equal(calls.length, 0);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /\.decay\(\) does nothing/);
});
