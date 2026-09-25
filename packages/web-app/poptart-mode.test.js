'use strict';

// The editor's indentation (public/poptart-mode.js): from the brackets, not from a JavaScript
// parse that the pre-transpile syntax of a group body derails.

const test = require('node:test');
const assert = require('node:assert/strict');

const CodeMirror = require('codemirror/addon/runmode/runmode.node');
// The node shim has no Pass sentinel; the browser's is an object the indenter returns by identity.
CodeMirror.Pass = CodeMirror.Pass || { toString: () => 'CodeMirror.Pass' };
require('./public/poptart-mode.js');

const mode = CodeMirror.getMode({ indentUnit: 2, tabSize: 2 }, 'poptart');

/**
 * Runs the mode over `code` and returns, per line, what the editor would indent that line to
 * given everything above it: a column, or null where the mode passes (the editor then copies the
 * previous line's indent).
 */
function indents(code) {
  const out = [];
  let state = CodeMirror.startState(mode);
  for (const line of code.split('\n')) {
    const at = mode.indent(CodeMirror.copyState(mode, state), line.replace(/^\s+/, ''));
    out.push(at === CodeMirror.Pass ? null : at);
    const stream = new CodeMirror.StringStream(line, 2, null);
    while (!stream.eol()) {
      mode.token(stream, state);
      stream.start = stream.pos;
    }
  }
  return out;
}

const actual = (code) => code.split('\n').map((l) => /^\s*/.exec(l)[0].length);

/** A buffer written the way it should be indents to itself. */
function assertSelfIndenting(code) {
  assert.deepEqual(indents(code), actual(code));
}

test('a group body: tracks one level in, chains one more, the closer back out', () => {
  assertSelfIndenting(`low: group({
  kick: pianoroll("kick").s("fatkick")
    .width(0).fx("Pro-Q 3").preset("kick")
  rumble: group({
    lowest: pianoroll("rumble").synth("PunchBox").preset("kick")
      .fx("ValhallaVintageVerb").preset("lowest")
      .fx("Pro-C 2").preset("lowest2")
      .fx("Pro-Q 3").preset("lowest")
      .fx("Kickstart 2").preset("lowest")
      .postgain(0.53)
      .width(0)
    rhythm: pianoroll("rhythm").s("mbd")
      .fx("Thermal").preset("rhythm")
      .fx("Pro-Q 3").preset("rhythm")
      .bassmono(250).postgain(0.92)
  }).co(5)
})`);
});

test('a chain under a top-level track, and a bare next track back at the margin', () => {
  assertSelfIndenting(`kick: pianoroll("kick").s("fatkick")
  .fx("Pro-Q 3").preset("kick")
  .width(0)
hat: pianoroll("hat").s("hh")`);
});

test('several openers on one line are one level; closers on one line pop back to it', () => {
  assertSelfIndenting(`bass: note("c3 e3").s("saw").fx("Pro-Q 3", {
  freq: 200,
  q: [1, 2, 3].map((x) => x * 2),
}).preset("bass")`);
});

test('brackets inside strings and mini-notation are not brackets', () => {
  assertSelfIndenting(`kick: note("<[c3 c3] (e3, g3) {a3}>").s("bd")
  .fx("(Pro-Q 3)")
hat: s("hh")`);
});

test('inside a template string the mode passes, so a roll body keeps its own layout', () => {
  const code = `_roll("kick", \`<
  [c3 ~ c3 ~]
  [~ c3]
>*4\`)
hat: s("hh")`;
  assert.deepEqual(indents(code), [0, null, null, null, 0]);
});

test('a template interpolation closes the brace it opened', () => {
  assertSelfIndenting(`kick: s(\`bd\${n}\`).fx("Pro-Q 3", {
  freq: 200,
})
hat: s("hh")`);
});

test('a fresh line under a track, with nothing on it yet, lands where the track is', () => {
  // What Enter hands the indenter is an empty string - which must not read as a closer.
  const buffer = `low: group({
  rumble: group({
    bass2: s("mbd")
`;
  assert.equal(indents(buffer).at(-1), 4);
  assert.equal(indents('low: group({\n').at(-1), 2);
  // After a chain line the fresh line is back at the track's level: it is the dot, once typed,
  // that pulls the line in (see the electric test below).
  assert.equal(indents('kick: s("bd")\n  .fx("Pro-Q 3")\n').at(-1), 0);
});

test('a closer typed first on a line sits a level out even before the rest is written', () => {
  const [, , closer] = indents('low: group({\n  kick: s("bd")\n}');
  assert.equal(closer, 0);
  assert.ok(mode.electricInput.test('  }'), 'a lone closer re-indents its line');
  assert.ok(mode.electricInput.test('  )'));
  assert.ok(!mode.electricInput.test('  }).co(5)'), 'only when it is the first thing typed');
  assert.ok(mode.electricInput.test('  .'), 'a chain line re-indents on its dot');
  assert.ok(!mode.electricInput.test('  kick.'), 'a dot mid-line is left alone');
});

test('a comment line inside a group sits with the tracks', () => {
  assertSelfIndenting(`low: group({
  // the low end
  kick: s("bd")
})`);
});

test('the tokens are still JavaScript\'s', () => {
  const state = CodeMirror.startState(mode);
  const stream = new CodeMirror.StringStream('kick: s("bd")', 2, null);
  const styles = [];
  while (!stream.eol()) {
    styles.push(mode.token(stream, state));
    stream.start = stream.pos;
  }
  assert.ok(styles.includes('string'), `expected a string token in ${JSON.stringify(styles)}`);
});

test('a track named with a keyword is a label, and a switch keeps its keywords', () => {
  const styleOf = (code, word) => {
    let found = null;
    CodeMirror.runMode(code, 'poptart', (text, style) => { if (text === word && found == null) found = style; });
    return found;
  };
  assert.equal(styleOf('break: s("amen")', 'break'), 'variable', 'the same as kick: gets');
  assert.equal(styleOf('default: s("bd")', 'default'), 'variable');
  assert.equal(styleOf('switch (x) {\n  default: return 2\n}', 'default'), 'keyword');
  assert.equal(styleOf('if (x) break', 'break'), 'keyword');
});
