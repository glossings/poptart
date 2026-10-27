// The env() editor (public/client.js): `env` is a handle like `lfo`, a double-click opens the
// envelope editor against the deck it was in, and the editor's gestures land in that call's own
// object. The reads and edits themselves are pattern-core's envctl.mjs and tested there; what is
// tested here is the glue - the wiring is pinned by its shape, and the path from a gesture to the
// code is run over a fake editor with the real envctl and the real figure builder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as envctl from '../pattern-core/src/envctl.mjs';
import { buildFigures } from '../web-engine/src/figures.mjs';
import { denormalize } from '../web-engine/src/descriptor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.search(new RegExp(`(^|\\n)(async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name} not found in client.js - this test needs updating`);
  const start = SRC.indexOf('function', at);
  let depth = 0;
  let end = SRC.indexOf('{', SRC.indexOf(')', start));
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(SRC.lastIndexOf('\n', start) + 1, end);
}

function grabStatement(name) {
  const at = SRC.indexOf(`const ${name} = `);
  assert.ok(at >= 0, `${name} not found in client.js`);
  const end = SRC.indexOf('];\n', at);
  return SRC.slice(at, end + 2);
}

test('env is a handle: underlined on hover, and a double-click opens its editor', () => {
  const words = /const CALL_HANDLE_WORDS = new Set\(\[([^\]]*)\]\)/.exec(SRC);
  assert.ok(words && /'env'/.test(words[1]), 'env is one of the names the hover asks about');
  assert.match(grab('isWidgetHandleAt'), /envctlMod\?\.findEnvCallAt\(code, idx\)\?\.onName/);
  const open = grab('openWidgetAt');
  assert.match(open, /const envCall = envctlMod\?\.findEnvCallAt\(code, idx\);/);
  assert.match(open, /openEnvModEditor\(envCall, ed\)/, 'opened against the deck it was double-clicked in');
  // The sampler's envelope panel keeps its own words: env is not one of them.
  assert.ok(!/ENV_HANDLE_WORDS = new Set\(\[[^\]]*'env'/.test(SRC));
});

test('the editor follows its own deck, and goes with it', () => {
  assert.match(grab('closePanelsOn'), /if \(envModState && envModCM === ed\) closeEnvModEditor\(\);/);
  const opener = grab('openEnvModEditor');
  assert.match(opener, /envModCM = ed;/);
  for (const name of ['openEnvModEditor', 'envModCall', 'envModCommit', 'envModSyncFromCode']) {
    assert.ok(!/(^|[^\w$.])cm\.(getValue|replaceRange|setBookmark)/m.test(grab(name)), `${name} never reaches for deck A's buffer`);
  }
  assert.match(SRC, /import\('\/pattern-core\/envctl\.mjs'\)/);
});

/** A CodeMirror stand-in over a plain string, offsets as positions. */
function fakeCm(text) {
  const ed = {
    text,
    getValue: () => ed.text,
    posFromIndex: (i) => i,
    indexFromPos: (i) => i,
    operation: (fn) => fn(),
    setBookmark: (pos) => ({ find: () => pos, clear() {} }),
    replaceRange(str, from, to = from) {
      ed.text = ed.text.slice(0, from) + str + ed.text.slice(to);
    },
  };
  return ed;
}

/** The panel's glue, lifted out and pointed at `ed` - deck A or deck B, it should not matter. */
function panelOn(ed, code) {
  const evals = [];
  const names = ['envModDescriptor', 'envModCall', 'envModRead', 'envModValues', 'envModFixedText', 'envModFigureData',
    'envModSend', 'envModPreview', 'envModRepaint', 'envModCommit'];
  const api = new Function('envctlMod', 'deckEvalSoon', 'closeEnvModEditor', 'ed', 'mods', `
    let envModCM = ed;
    let envModWriting = false;
    const envModEvalSoon = { timer: null, ed: null };
    const ENV_MOD_EVAL_DEBOUNCE_MS = 0;
    ${grabStatement('ENV_MOD_FIELDS')}
    ${names.map(grab).join('\n')}
    let envModState = null;
    return {
      open(start) {
        envModState = { at: ed.setBookmark(start), mods, read: null, draft: null, entry: null, setters: {} };
        envModRead();
        return envModState;
      },
      send: envModSend,
      figure: envModFigureData,
      values: envModValues,
      state: () => envModState,
    };
  `)(envctl, (slot, which) => evals.push(which), () => {}, ed, { buildFigures, denormalize });
  return { ...api, evals, start: code.indexOf('env(') };
}

for (const deck of ['a', 'b']) {
  test(`a drag on deck ${deck.toUpperCase()}'s picture writes into that deck's env({ ... })`, () => {
    const code = 'lead: note("c3").gain(env({ attack: 0.01, retrigger: true }))';
    const ed = fakeCm(code);
    const other = fakeCm(code);
    const panel = panelOn(ed, code);
    panel.open(panel.start);
    // A frame of the drag is drawn but not written...
    panel.send({ id: 'release', value: 0.75 }, false);
    assert.equal(ed.text, code);
    assert.equal(panel.values().release, 0.75);
    // ...and the end of it is.
    panel.send({ id: 'release', value: 0.75 }, true);
    assert.equal(ed.text, 'lead: note("c3").gain(env({ attack: 0.01, retrigger: true, release: 0.75 }))');
    assert.deepEqual(panel.evals, [ed], 'the deck the call is in is the one re-evaluated');
    assert.equal(other.text, code, 'and nothing else is touched');
    assert.equal(panel.state().draft, null);
  });
}

test('the wheel over a stage bends the one curve env() has, through the figure\'s own position', () => {
  const code = 'gain(env())';
  const ed = fakeCm(code);
  const panel = panelOn(ed, code);
  panel.open(panel.start);
  const f = panel.figure();
  assert.equal(f.kind, 'adsr');
  assert.deepEqual(f.stages.map((s) => s.moves), ['curve', 'curve', 'curve'], 'every stage is the same curve');
  const stage = f.stages[0];
  panel.send({ id: stage.moves, position: stage.position + 0.05 }, true);
  assert.equal(ed.text, 'gain(env({ curve: -3.2 }))');
});

test('a setting written as code is drawn fixed and never written over', () => {
  const code = 'gain(env({ attack: "<0.01 0.2>", sustain: 0.5 }))';
  const ed = fakeCm(code);
  const panel = panelOn(ed, code);
  panel.open(panel.start);
  const f = panel.figure();
  assert.deepEqual(f.driven, { attack: '"<0.01 0.2>"' }, 'the picture says what sets it');
  panel.send({ id: 'attack', value: 0.3 }, true);
  assert.equal(ed.text, code);
  assert.deepEqual(panel.evals, [], 'nothing written, nothing re-evaluated');
  panel.send({ id: 'sustain', value: 0.25 }, true);
  assert.equal(ed.text, 'gain(env({ attack: "<0.01 0.2>", sustain: 0.25 }))');
});
