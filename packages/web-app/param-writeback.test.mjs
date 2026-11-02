// A control turned in a device window, where the track's code sets it with a .param() of one plain
// value: the turn is written into that .param() (client.js's writeWindowParam), spelled the way it
// was. Anything else the code says there is left alone, and the window draws the control as set by
// the code (setByCodeOnly).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as labelsMod from '../pattern-core/src/labels.mjs';
import * as unitsMod from '../pattern-core/src/units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', SRC.indexOf(')', at));
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const names = ['matchParen', 'codeOnly', 'blockOwnCode', 'splitFirstArg', 'idLiteralValue', 'labeledBlocksFor',
  'slotCalls', 'chainBefore', 'paramSlotAt', 'paramCallArgs', 'findParamCall', 'codeParamCall', 'restateTarget',
  'writeWindowParam', 'windowWritesParam', 'setByCodeOnly', 'writePluginParam'];

// One editor holding `code`, and the window's controls by id.
function editor(code, { conf = null } = {}) {
  let text = code;
  const undo = [];
  const ed = {
    getValue: () => text,
    posFromIndex: (i) => i,
    replaceRange: (s, from, to = from, origin) => { undo.push(origin); text = text.slice(0, from) + s + text.slice(to); },
  };
  const specs = new Map();
  const asked = [];
  const api = (method, route, body) => { asked.push([route, body]); return Promise.resolve({}); };
  const lib = new Function('labelsMod', 'unitsMod', 'deckTrackParts', 'blockForTrack', 'confSession', 'deviceWidgetSpecs', 'api', `
    let presetBlocksCache = { code: null, blocks: [] };
    ${names.map(grab).join('\n\n')}
    return { ${names.join(', ')} };
  `)(
    labelsMod, unitsMod,
    (trackId) => ({ ed, label: trackId }),
    (src, label) => labelsMod.splitLabeledBlocks(src).filter((b) => b.label === label).pop() ?? null,
    conf ? { trackLabel: conf } : null,
    specs,
    api,
  );
  return { lib, specs, text: () => text, undo, asked };
}

const CUTOFF = { id: 'cutoff', name: 'Cutoff', widget: 'knob', unit: 'Hz', decimals: 0, options: null, value: 317, position: 0.4 };
const TILT = { id: 'tilt', name: 'Tilt', widget: 'knob', unit: 'dB', decimals: 1, options: null, value: -6, position: 0.4 };
const MODE = { id: 'mode', name: 'Mode', widget: 'enum', options: ['lowpass', 'highpass', 'bandpass'], value: 0, position: 0 };
// What the host answers a turn with (see /api/deviceParam).
const answer = (spec, value, position, arg) => ({ id: spec.id, name: spec.name, value, position, arg: arg ?? String(position) });

test('a bare position is rewritten as a position', () => {
  const e = editor('f: s("hh*8").fx("Filter").param("Cutoff", 0.4)\n');
  e.specs.set('cutoff', CUTOFF);
  e.lib.writeWindowParam('f', 1, answer(CUTOFF, 6300, 0.9));
  assert.equal(e.text(), 'f: s("hh*8").fx("Filter").param("Cutoff", 0.9)\n');
  assert.deepEqual(e.undo, ['+param'], 'one origin, so a drag merges into one undo step');
});

test('a value in units stays in its unit, and its spelling', () => {
  const e = editor('add: n("0 3").synth("Additive").param("Tilt", "-6db").param("Stretch", 0.55)\n');
  e.specs.set('tilt', TILT);
  e.lib.writeWindowParam('add', 0, answer(TILT, -20.41, 0.2));
  assert.equal(e.text(), 'add: n("0 3").synth("Additive").param("Tilt", "-20.4db").param("Stretch", 0.55)\n');
});

test('an option stays a name, and the id spelling is found as well as the name', () => {
  const e = editor("f: s(\"hh*8\").fx(\"Filter\").param('mode', 'lowpass')\n");
  e.specs.set('mode', MODE);
  e.lib.writeWindowParam('f', 1, answer(MODE, 2, 1, '"bandpass"'));
  assert.equal(e.text(), "f: s(\"hh*8\").fx(\"Filter\").param('mode', 'bandpass')\n");
});

test('the call on the slot that was turned, when the chain has two of the same device', () => {
  const code = 'f: s("hh*8").fx("Filter").param("Cutoff", "300hz").fx("Filter").param("Cutoff", "2000hz")\n';
  const e = editor(code);
  e.specs.set('cutoff', CUTOFF);
  e.lib.writeWindowParam('f', 2, answer(CUTOFF, 5000, 0.85));
  assert.equal(e.text(), 'f: s("hh*8").fx("Filter").param("Cutoff", "300hz").fx("Filter").param("Cutoff", "5000hz")\n');
  e.lib.writeWindowParam('f', 1, answer(CUTOFF, 120, 0.3));
  assert.equal(e.text(), 'f: s("hh*8").fx("Filter").param("Cutoff", "120hz").fx("Filter").param("Cutoff", "5000hz")\n');
  const named = editor('f: s("hh*8").fx("Filter").fx("Delay").fx("Filter").param("Filter#1", "Cutoff", 0.2)\n');
  named.specs.set('cutoff', CUTOFF);
  named.lib.writeWindowParam('f', 1, answer(CUTOFF, 120, 0.3));
  assert.equal(named.text(), 'f: s("hh*8").fx("Filter").fx("Delay").fx("Filter").param("Filter#1", "Cutoff", 0.3)\n', 'a call naming its device');
});

test('of two calls for one control, the last - the one that plays', () => {
  const e = editor('f: s("hh*8").fx("Filter").param("Cutoff", 0.2).param("cutoff", 0.4)\n');
  e.specs.set('cutoff', CUTOFF);
  e.lib.writeWindowParam('f', 1, answer(CUTOFF, 6300, 0.9));
  assert.equal(e.text(), 'f: s("hh*8").fx("Filter").param("Cutoff", 0.2).param("cutoff", 0.9)\n');
});

test('a pattern, a signal or a variable is left alone, and drawn as set by the code', () => {
  for (const arg of ['"<0.2 0.5>"', 'sine.range(0.2, 0.8)', 'cut', '"3x"']) {
    const code = `f: s("hh*8").fx("Filter").param("Cutoff", ${arg})\n`;
    const e = editor(code);
    e.specs.set('cutoff', CUTOFF);
    e.lib.writeWindowParam('f', 1, answer(CUTOFF, 6300, 0.9));
    assert.equal(e.text(), code, arg);
    assert.equal(e.lib.setByCodeOnly('f', 1, CUTOFF), true, arg);
    assert.equal(e.lib.windowWritesParam('f', 1, 'cutoff'), false, arg);
  }
  const plain = editor('f: s("hh*8").fx("Filter").param("Cutoff", 0.4)\n');
  plain.specs.set('cutoff', CUTOFF);
  assert.equal(plain.lib.setByCodeOnly('f', 1, CUTOFF), false);
  assert.equal(plain.lib.windowWritesParam('f', 1, 'cutoff'), true, 'its gesture is not a capture of the device');
});

test('a control the code does not name is not written, and still a capture', () => {
  const code = 'f: s("hh*8").fx("Filter").param("Resonance", 0.4)\n';
  const e = editor(code);
  e.specs.set('cutoff', CUTOFF);
  e.lib.writeWindowParam('f', 1, answer(CUTOFF, 6300, 0.9));
  assert.equal(e.text(), code);
  assert.equal(e.lib.setByCodeOnly('f', 1, CUTOFF), false);
  assert.equal(e.lib.windowWritesParam('f', 1, 'cutoff'), false);
});

test('with conf armed on the track, conf writes the call, as before', () => {
  const code = 'f: s("hh*8").fx("Filter").param("Cutoff", cut)\n';
  const e = editor(code, { conf: 'f' });
  e.specs.set('cutoff', CUTOFF);
  e.lib.writeWindowParam('f', 1, answer(CUTOFF, 6300, 0.9));
  assert.equal(e.text(), code);
  assert.equal(e.lib.setByCodeOnly('f', 1, CUTOFF), false, 'conf may overwrite what the code says, so the control is not drawn as driven');
  assert.equal(e.lib.windowWritesParam('f', 1, 'cutoff'), false, 'and the release still goes to conf');
});

test('a plugin parameter moved in its own window rewrites the number in its .param()', () => {
  const e = editor('lead: n("0 3").synth("Some Synth").param("Cutoff", 0.4).fx("Some Delay").param("Cutoff", 0.7)\n');
  e.lib.writePluginParam({ trackId: 'lead', slot: 0, name: 'Cutoff', value: 0.8123 });
  assert.equal(e.text(), 'lead: n("0 3").synth("Some Synth").param("Cutoff", 0.8123).fx("Some Delay").param("Cutoff", 0.7)\n');
  // A parameter a mapping file gives units is sent in them, and written as sent.
  e.lib.writePluginParam({ trackId: 'lead', slot: 1, name: 'Cutoff', value: 1250 });
  assert.equal(e.text(), 'lead: n("0 3").synth("Some Synth").param("Cutoff", 0.8123).fx("Some Delay").param("Cutoff", 1250)\n');
  assert.deepEqual(e.asked, [], 'nothing handed back');
});

test('a plugin parameter the code sets with a variable is handed back; one it does not name is left alone', () => {
  const code = 'lead: n("0 3").synth("Some Synth").param("Cutoff", cut)\n';
  const e = editor(code);
  e.lib.writePluginParam({ trackId: 'lead', slot: 0, name: 'Cutoff', value: 0.8 });
  assert.equal(e.text(), code);
  assert.deepEqual(e.asked, [['/api/paramHandBack', { trackId: 'lead', slot: 0, name: 'Cutoff' }]]);
  const other = editor(code);
  other.lib.writePluginParam({ trackId: 'lead', slot: 0, name: 'Resonance', value: 0.8 });
  assert.equal(other.text(), code);
  assert.deepEqual(other.asked, []);
});
