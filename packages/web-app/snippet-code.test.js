'use strict';

// Injecting a snippet into a buffer that has names of its own (public/snippet-code.js). The whole
// job is collisions: a snippet carrying `_roll("bass")` must not clobber the buffer's `bass`, must
// not quietly play it, and must not grow a bass2 every time the same snippet goes in again.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planInjection, placeSnippet, defBody, withDefId, freshName, renameNote } = require('./public/snippet-code.js');

// The id-string spans client.js reads off its registries, worked out here from the body so a test
// reads as the code it is about rather than as a list of offsets.
function callsFor(body, spec) {
  const out = [];
  for (const [kind, useCall, scope] of spec) {
    const re = new RegExp(`${useCall}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
    for (const m of body.matchAll(re)) {
      const from = m.index + m[0].length - 1 - m[2].length;
      out.push({ kind, from, to: from + m[2].length, scope: scope ?? '' });
    }
  }
  return out;
}

const rollCalls = (body) => callsFor(body, [['roll', 'pianoroll']]);

test('defBody compares two definitions on what they define, not what they are called', () => {
  assert.equal(defBody('_roll("bass", "36,0,4")'), '"36,0,4"');
  assert.equal(defBody('_roll("lead", "36,0,4")'), '"36,0,4"');
  // A comma inside the arguments is not the one that ends the id.
  assert.equal(defBody('_roll("a", "36,0,4", { grid: 16 })'), '"36,0,4", { grid: 16 }');
  // ...nor is one inside a string.
  assert.equal(defBody('_pack("kit", ["a,b.wav", "c.wav"])'), '["a,b.wav", "c.wav"]');
});

test('withDefId renames a definition and leaves the rest of it alone', () => {
  assert.equal(withDefId('_roll("bass", "36,0,4")', 'bass2'), '_roll("bass2", "36,0,4")');
  assert.equal(
    withDefId('_preset("growl", "Serum 2", "@abc")', 'growl3'),
    '_preset("growl3", "Serum 2", "@abc")',
  );
  // A numeric id (an unnamed roll) comes back quoted, which is what every definition the editor
  // writes looks like anyway.
  assert.equal(withDefId('_roll(0, "36,0,4")', 'bass'), '_roll("bass", "36,0,4")');
});

test('freshName appends only enough to break the tie', () => {
  assert.equal(freshName('bass', () => false), 'bass');
  assert.equal(freshName('bass', (n) => n === 'bass'), 'bass2');
  assert.equal(freshName('bass', (n) => ['bass', 'bass2', 'bass3'].includes(n)), 'bass4');
});

test('a snippet whose names are free goes in untouched', () => {
  const body = 'bass: pianoroll("bass").synth("Serum 2")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' }],
    bufferDefs: [],
    labels: ['drums'],
  });
  assert.equal(plan.body, body);
  assert.deepEqual(plan.defs, [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' }]);
  assert.deepEqual(plan.renames, []);
});

test('the same definition already in the buffer is reused, not duplicated', () => {
  // This is what makes injecting one snippet twice idempotent.
  const body = 'lead: pianoroll("bass")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' }],
    bufferDefs: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass",  "36,0,4")' }],
  });
  assert.deepEqual(plan.defs, []);
  assert.deepEqual(plan.renames, []);
  assert.equal(plan.body, body);
});

test('a different definition of the same name is renamed, and the body follows it', () => {
  const body = 'bass: pianoroll("bass").synth("Serum 2")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' }],
    bufferDefs: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "48,0,2")' }],
    labels: [],
  });
  assert.equal(plan.body, 'bass: pianoroll("bass2").synth("Serum 2")');
  assert.deepEqual(plan.defs, [{ kind: 'roll', id: 'bass2', scope: '', code: '_roll("bass2", "36,0,4")' }]);
  assert.deepEqual(plan.renames, [{ kind: 'roll', from: 'bass', to: 'bass2', scope: '' }]);
  assert.match(renameNote(plan.renames[0]), /renamed roll "bass" to "bass2"/);
});

test('a call naming several rolls follows only the ones that moved', () => {
  const body = 'lead: pianoroll("<bass lead>*2")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [
      { kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' },
      { kind: 'roll', id: 'lead', scope: '', code: '_roll("lead", "60,0,4")' },
    ],
    bufferDefs: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "48,0,2")' }],
  });
  assert.equal(plan.body, 'lead: pianoroll("<bass2 lead>*2")');
  assert.deepEqual(plan.defs.map((d) => d.id), ['bass2', 'lead']);
});

test('a name a library holds is stepped over too', () => {
  const body = 'x: pianoroll("bass")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' }],
    bufferDefs: [],
    taken: (kind, id) => kind === 'roll' && id === 'bass', // a ★ / prebake roll of that name
  });
  assert.equal(plan.body, 'x: pianoroll("bass2")');
  assert.deepEqual(plan.renames.map((r) => r.to), ['bass2']);
});

test('two carried definitions cannot be given the same fresh name', () => {
  const body = 'a: pianoroll("bass")\nb: pianoroll("bass")';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [
      { kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "36,0,4")' },
      { kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "40,0,4")' },
    ],
    bufferDefs: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "48,0,2")' }],
  });
  assert.deepEqual(plan.defs.map((d) => d.id), ['bass2', 'bass3']);
});

test('presets of the same name under different plugins do not collide', () => {
  const body = 'x: synth("Serum 2").preset("disco")';
  const calls = callsFor(body, [['preset', '\\.preset', 'Serum 2']]);
  const plan = planInjection({
    body,
    idCalls: calls,
    carried: [{ kind: 'preset', id: 'disco', scope: 'Serum 2', code: '_preset("disco", "Serum 2", "@aaa")' }],
    // Same word, different plugin - a program is meaningless to any other plugin, so this is not
    // the same preset and must not push the carried one off its name.
    bufferDefs: [{ kind: 'preset', id: 'disco', scope: 'ValhallaDelay', code: '_preset("disco", "ValhallaDelay", "@bbb")' }],
  });
  assert.equal(plan.body, body);
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.defs.map((d) => d.id), ['disco']);
});

test('a preset that DOES collide under its own plugin is renamed', () => {
  const body = 'x: synth("Serum 2").preset("disco")';
  const plan = planInjection({
    body,
    idCalls: callsFor(body, [['preset', '\\.preset', 'Serum 2']]),
    carried: [{ kind: 'preset', id: 'disco', scope: 'Serum 2', code: '_preset("disco", "Serum 2", "@aaa")' }],
    bufferDefs: [{ kind: 'preset', id: 'disco', scope: 'Serum 2', code: '_preset("disco", "Serum 2", "@bbb")' }],
  });
  assert.equal(plan.body, 'x: synth("Serum 2").preset("disco2")');
  assert.deepEqual(plan.defs.map((d) => d.code), ['_preset("disco2", "Serum 2", "@aaa")']);
});

test('a rename of one kind leaves an identical name of another kind alone', () => {
  const body = 'x: pianoroll("swell").lfo("swell")';
  const plan = planInjection({
    body,
    idCalls: [...rollCalls(body), ...callsFor(body, [['shape', '\\.lfo']])],
    carried: [
      { kind: 'roll', id: 'swell', scope: '', code: '_roll("swell", "36,0,4")' },
      { kind: 'shape', id: 'swell', scope: '', code: '_shape("swell", "0,0 1,1")' },
    ],
    bufferDefs: [{ kind: 'roll', id: 'swell', scope: '', code: '_roll("swell", "1,0,1")' }],
  });
  assert.equal(plan.body, 'x: pianoroll("swell2").lfo("swell")');
});

test('a block label the buffer already uses is renamed', () => {
  const body = 'bass: pianoroll("b")\nbass.hush()';
  const plan = planInjection({
    body,
    idCalls: rollCalls(body),
    carried: [],
    bufferDefs: [],
    labels: ['bass', 'drums'],
  });
  assert.equal(plan.body.split('\n')[0], 'bass2: pianoroll("b")');
  // Only the label itself - a `bass` further into the code is somebody's variable, not the block.
  assert.equal(plan.body.split('\n')[1], 'bass.hush()');
  assert.deepEqual(plan.renames, [{ kind: 'label', from: 'bass', to: 'bass2', scope: '' }]);
  assert.match(renameNote(plan.renames[0]), /renamed the block "bass" to "bass2"/);
});

test('a $: setup block is not a name, so it never collides', () => {
  const plan = planInjection({ body: '$: setcps(0.5)', carried: [], bufferDefs: [], labels: ['$'] });
  assert.equal(plan.body, '$: setcps(0.5)');
  assert.deepEqual(plan.renames, []);
});

test('a fragment that is not a whole block goes in as plain text', () => {
  // Selecting `.lpf(...).room(...)` off the end of a chain is a perfectly good snippet.
  const body = '.lpf(sine.range(200, 2000)).room(0.3)';
  const plan = planInjection({ body, carried: [], bufferDefs: [], labels: ['bass'] });
  assert.equal(plan.body, body);
  assert.deepEqual(plan.defs, []);
});

test('placeSnippet gives a block its own lines without stacking blank ones up', () => {
  const [at, text] = placeSnippet('a: s("bd")\n', 'b: s("sd")', 11);
  assert.equal(at, 11);
  assert.equal(text, '\nb: s("sd")\n');
  // Mid-line: the body must not be spliced into somebody's chain.
  assert.equal(placeSnippet('a: s("bd")', 'b: s("sd")', 5)[1], '\n\nb: s("sd")\n\n');
  // A buffer that already ends in a blank line doesn't gain another.
  assert.equal(placeSnippet('a: s("bd")\n\n', 'b: s("sd")', 12)[1], 'b: s("sd")\n');
  assert.equal(placeSnippet('', 'b: s("sd")', 0)[1], 'b: s("sd")\n');
});

test('placeSnippet drops a chain fragment in exactly where the caret is', () => {
  const code = 'a: s("bd*4")';
  const [at, text] = placeSnippet(code, '.room(0.3)', code.length);
  assert.equal(at, code.length);
  assert.equal(text, '.room(0.3)'); // no newlines - it continues the line it landed on
});

test('placeSnippet keeps a chain fragment inline however many lines it wraps over', () => {
  const code = 'a: s("vox")';
  // A .fx() chain broken over indented lines is still one expression continuing the caret's line -
  // padding it off with a blank line above would sever it from the track it attaches to.
  const body = '.speed(1).gain(2)\n  .fx("Pro-C 2").preset("voxreal")';
  assert.deepEqual(placeSnippet(code, body, code.length), [code.length, body]);
});

test('placeSnippet never writes into the definitions block', () => {
  //                0123456789...
  const code = 'a: pianoroll("x")\n\n_roll("x", "60,0,4")\n';
  const floor = code.indexOf('_roll');
  // A caret parked below the block still writes above it.
  const [at] = placeSnippet(code, 'b: s("sd")', code.length, floor);
  assert.equal(at, floor);
  // ...and one above it is left where it is.
  assert.equal(placeSnippet(code, 'b: s("sd")', 5, floor)[0], 5);
});
