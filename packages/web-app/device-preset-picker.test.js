'use strict';

// The preset picker on a device window writes the slot's `.preset(...)` into the code
// (public/client.js's devicePresetEdit) and reads which preset is in force (devicePresetNow).
// What has to hold: the right slot's call, the last one of them (the last call wins), a call
// chained on when there is none, "none" taking the call out with its line, and a pattern of
// presets read as driven and never rewritten.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let labelsMod;
let groupsMod;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  labelsMod = await import(require('node:url').pathToFileURL(path.join(dir, 'labels.mjs')).href);
  groupsMod = await import(require('node:url').pathToFileURL(path.join(dir, 'groups.mjs')).href);
});

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// Lifts `function name(...) { ... }` out of client.js, brace-matched (see autopin-target.test.js).
function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const bodies = ['matchParen', 'codeOnly', 'blockOwnCode', 'firstStringLiteral', 'slotCalls', 'findChainCall', 'blockForTrack',
  'slotPresetCalls', 'devicePresetNow', 'devicePresetEdit'].map(grab).join('\n\n');
let fns;
const load = () => {
  // eslint-disable-next-line no-new-func
  fns ??= new Function('labelsMod', 'groupsMod', 'cm', 'deckBCM', 'monitorPickerOf', `${bodies}\nreturn { devicePresetNow, devicePresetEdit };`)(
    labelsMod, null, null, null, () => ({ prefer: new Map() }),
  );
  return fns;
};

const apply = (code, edit) => (edit ? code.slice(0, edit[0]) + edit[2] + code.slice(edit[1]) : code);

test('a pick chains a .preset() right after the device when there is none', () => {
  const { devicePresetEdit, devicePresetNow } = load();
  const code = 'kit: note("c3*4").synth("Drum").fx("Delay")\n';
  const out = apply(code, devicePresetEdit(code, 'kit', 0, 'buzz'));
  assert.equal(out, 'kit: note("c3*4").synth("Drum").preset("buzz").fx("Delay")\n');
  assert.deepEqual(devicePresetNow(out, 'kit', 0), { name: 'buzz', driven: null });
  assert.deepEqual(devicePresetNow(out, 'kit', 1), { name: null, driven: null }, 'the Delay has none');
});

test('a pick renames the slot\'s own call, the last of them, and leaves another slot\'s alone', () => {
  const { devicePresetEdit } = load();
  const code = 'kit: note("c3").synth("Drum").preset("snare").param("Level", 0.5).preset("rim")\n  .fx("Delay").preset("long")\n';
  const out = apply(code, devicePresetEdit(code, 'kit', 0, 'clap'));
  assert.equal(out, 'kit: note("c3").synth("Drum").preset("snare").param("Level", 0.5).preset("clap")\n  .fx("Delay").preset("long")\n');
  const fx = apply(code, devicePresetEdit(code, 'kit', 1, 'short'));
  assert.match(fx, /\.fx\("Delay"\)\.preset\("short"\)/);
  assert.match(fx, /\.preset\("rim"\)/);
});

test('picking what is already there writes nothing', () => {
  const { devicePresetEdit } = load();
  assert.equal(devicePresetEdit('kit: note("c3").synth("Drum").preset("buzz")\n', 'kit', 0, 'buzz'), null);
});

test('"none" takes the call out, with the line it had to itself', () => {
  const { devicePresetEdit } = load();
  const inline = 'kit: note("c3").synth("Drum").preset("buzz").fx("Delay")\n';
  assert.equal(apply(inline, devicePresetEdit(inline, 'kit', 0, null)), 'kit: note("c3").synth("Drum").fx("Delay")\n');
  const own = 'kit: note("c3").synth("Drum")\n  .preset("buzz")\n  .fx("Delay")\n';
  assert.equal(apply(own, devicePresetEdit(own, 'kit', 0, null)), 'kit: note("c3").synth("Drum")\n  .fx("Delay")\n');
  assert.equal(devicePresetEdit('kit: note("c3").synth("Drum")\n', 'kit', 0, null), null, 'nothing to take out');
});

test('a pattern of presets is driven: read as written', () => {
  const { devicePresetNow } = load();
  assert.deepEqual(devicePresetNow('kit: note("c3").synth("Drum").preset("<snare clap>")\n', 'kit', 0), { name: null, driven: '<snare clap>' });
});

test('the track is found by its label, the last block of that name, and a commented-out call is no call', () => {
  const { devicePresetEdit, devicePresetNow } = load();
  const code = 'kit: note("c3").synth("Drum").preset("old")\n\nkit: note("c3").synth("Drum") // .preset("x")\n\nhat: note("c3").synth("Drum").preset("rim")\n';
  assert.deepEqual(devicePresetNow(code, 'kit', 0), { name: null, driven: null });
  const out = apply(code, devicePresetEdit(code, 'kit', 0, 'zap'));
  assert.match(out, /^kit: note\("c3"\)\.synth\("Drum"\)\.preset\("old"\)\n\nkit: note\("c3"\)\.synth\("Drum"\)\.preset\("zap"\) \/\/ \.preset\("x"\)/);
  assert.match(out, /hat: note\("c3"\)\.synth\("Drum"\)\.preset\("rim"\)/);
});
