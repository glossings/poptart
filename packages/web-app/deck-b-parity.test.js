'use strict';

// Deck B is a livecode deck exactly as deck A is (public/client.js). DJ mode's second pane used to
// be a plain editor with plugin windows bolted on: no folds, no panels, and every definition
// registry, every debounced evaluation and the fold machinery hard-wired to the main buffer. Now
// each of those takes the editor it acts on, and everything opened from deck B reads, writes and
// evaluates deck B.
//
// Two kinds of test, as elsewhere in this package: the logic that can be lifted out and run over a
// fake editor is run (the fold memory, the debounced evaluation, the registries, the track ids),
// and the wiring - which panel is opened against which editor - is pinned by its shape, because
// the failure it guards against (an edit made on deck B written into deck A's code mid-set) is one
// nobody would notice until it happened on stage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.search(new RegExp(`(^|\\n)(async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name} not found in client.js - this test needs updating`);
  const start = SRC.indexOf('function', at);
  let depth = 0;
  let end = SRC.indexOf(') {', start) + 2;
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(SRC.lastIndexOf('\n', start) + 1, end);
}

/** Source with its line comments dropped - prose that mentions `cm.getValue()` is not a call. */
const codeOf = (src) => src.split('\n').map((l) => l.replace(/^\s*\/\/.*$|\s\/\/\s.*$/, '')).join('\n');

function grabConst(name) {
  const m = new RegExp(`^const ${name} = [^\\n]*;$`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return m[0];
}

/** A CodeMirror stand-in over a plain string, offsets as positions. */
function fakeCm(text = '') {
  const ed = {
    text,
    getValue: () => ed.text,
    posFromIndex: (i) => i,
    indexFromPos: (i) => i,
    operation: (fn) => fn(),
    replaceRange(str, from, to = from) {
      ed.text = ed.text.slice(0, from) + str + ed.text.slice(to);
    },
  };
  return ed;
}

// ---------------------------------------------------------------------------------------------
// The refusals are gone
// ---------------------------------------------------------------------------------------------

test('no panel refuses deck B any more', () => {
  assert.ok(!/can only edit deck A's buffer/.test(SRC), 'the "move the pattern there" line is gone');
  assert.ok(!/openDeckBWidgetAt/.test(SRC), 'and so is the deck-B-only handle router');
  assert.ok(!/deck A to draw/.test(SRC), 'a clip roll on deck B is not refused either');
  // Both decks' double-clicks go through the one router, which is handed the editor it came from.
  assert.match(grab('attachWidgetHandles'), /const took = openWidgetAt\(editor\.getValue\(\), idx, editor\);/);
  // ...and the underline offers every handle on either deck, not only the plugin names.
  assert.ok(!/if \(editor !== cm\) return !!findChainHandleAt/.test(grab('isWidgetHandleAt')));
});

test('every panel is opened against the deck its handle was double-clicked in', () => {
  const open = grab('openWidgetAt');
  assert.match(open, /function openWidgetAt\(code, idx, ed = cm\)/);
  assert.ok(!/(^|[^\w$.])cm\./m.test(open), 'nothing in the router reaches for the main buffer');
  for (const call of [
    /openArrangePainter\(deckOfCM\(ed\)\)/,
    /openAutoFromIdCall\(autoCall, code, ed\)/,
    /openShapeFromIdCall\(lfo, code, ed\)/,
    /openLfoEditor\(lfo, ed\)/,
    /openRollFromIdCall\(roll, code, ed\)/,
    /openPianorollEditor\(roll, null, ed\)/,
    /openGrooveFromIdCall\(swingCall, code, ed\)/,
    /grooveMakeDrawable\(swingCall, read, ed\)/,
    /openGrooveEditor\(swingCall, ed\)/,
    /openPresetFromCall\(preset, code, ed\)/,
    /openPackFromCall\(packCall, code, ed\)/,
    /openSliceEditorFromCall\(sliceCall, code, idx, ed\)/,
    /openEnvelopeAt\(code, idx, ed\)/,
    /openRecordPanel\(rec, ed\)/,
    /showPluginEditor\(blockTrackId\(ed, chain\), chain\.slot\)/,
  ]) assert.match(open, call);
  // An empty call is given its name in the deck it is in, and the handle reopened there.
  assert.equal((open.match(/Defs\.materialize\(ed\)/g) ?? []).length, 5);
  assert.equal((open.match(/return openWidgetAt\(ed\.getValue\(\), ed\.indexFromPos\(back\), ed\);/g) ?? []).length, 5);
});

test('each panel remembers the deck it is on, and moves across rather than writing the wrong one', () => {
  // [opener, its editor binding, its close] - opened on the other deck, the panel puts away what
  // it was showing before it binds to the new one.
  for (const [fn, bound, close] of [
    ['openPianorollEditor', 'prCM', 'closePianorollEditor'],
    ['openLfoEditor', 'lfoCM', 'closeLfoEditor'],
    ['openGrooveEditor', 'grooveCM', 'closeGroovePanel'],
    ['showPresetPanel', 'presetCM', 'closePresetPanel'],
    ['openPackById', 'packCM', 'closePackPanel'],
    ['openSliceSetById', 'sliceCM', 'closeSlicePanel'],
  ]) {
    const src = grab(fn);
    assert.match(src, new RegExp(`ed = \\w+ \\? ${bound} : cm\\)`), `${fn}: defaults to the deck it is already on`);
    assert.match(src, new RegExp(`if \\(\\w+ && ed !== ${bound}\\) ${close}\\(\\);\\n\\s+${bound} = ed;`), `${fn}: moves across`);
    assert.match(SRC, new RegExp(`^let ${bound} = cm;`, 'm'), `${bound} is declared, on the main buffer to begin with`);
  }
  assert.match(grab('openEnvelopeAt'), /envCM = ed;/);
  assert.match(grab('showRecordPanel'), /recCM = ed;/);
});

test('no panel function reaches for the main buffer directly', () => {
  // The functions that read or write a panel's buffer, every one of them through its own deck.
  const panelFns = [
    'writePianorollCall', 'syncPianorollFromCode', 'prUseInCall', 'prSyncRollHead', 'prFollowPlayingRoll',
    'prChainAt', 'prSamplerChain', 'prReadChain', 'prWriteSliceEntry', 'prMakeSliceSet', 'prPlayingLabel',
    'prSongPos', 'lfoCallParts', 'writeLfoSourceCall', 'writeLfoCall', 'syncLfoFromCode', 'lfoGateRegion',
    'forkShapePreset', 'openShapeFromIdCall', 'presetTarget', 'presetUseInCall', 'presetSyncHead',
    'syncPresetFromCode', 'openPresetFromCall', 'saveGrooveAs', 'grooveMakeDrawable', 'writeGrooveCall',
    'writeGrooveDef', 'openGrooveEditor', 'grooveUseInCall', 'grooveSyncHead', 'grooveSourceInner',
    'bufferSetgroove', 'writeSetgroove', 'syncGrooveFromCode', 'forkGroovePreset', 'openGrooveFromIdCall',
    'packUseInCall', 'openPackFromCall', 'packWrite', 'packSyncFromCode', 'sliceAtNow', 'sliceSyncHead',
    'sliceUseInCall', 'openSliceFromIdCall', 'sliceMaterializeAt', 'sliceLoadSample', 'sliceCommit',
    'sliceSyncFromCode', 'sliceRegionAt', 'envRead', 'envSyncFromCode', 'envWrite', 'openRecordPanel',
    'writeRecordCall', 'syncRecordFromCode', 'arOpenClipRoll', 'arTrackOfRoll',
  ];
  for (const fn of panelFns) {
    const strays = [...codeOf(grab(fn)).matchAll(/(^|[^\w.$])cm\.(\w+)/g)].map((m) => m[2]);
    assert.deepEqual(strays, [], `${fn} still touches cm directly: ${strays.join(', ')}`);
  }
});

test('a panel\'s hand-edit re-read listens on both decks, but only to its own', () => {
  for (const [bound, sync] of [
    ['lfoCM', 'syncLfoFromCode'], ['presetCM', 'syncPresetFromCode'], ['grooveCM', 'syncGrooveFromCode'],
    ['prCM', 'syncPianorollFromCode'], ['recCM', 'syncRecordFromCode'], ['packCM', 'packSyncFromCode'],
    ['sliceCM', 'sliceSyncFromCode'], ['envCM', 'envSyncFromCode'],
  ]) {
    assert.ok(SRC.includes(`onEveryDeck((ed) => ed.on('change', () => { if (ed === ${bound}) ${sync}(); }));`), sync);
    assert.ok(!SRC.includes(`cm.on('change', ${sync})`), `${sync} is not the main buffer's alone`);
  }
});

// ---------------------------------------------------------------------------------------------
// Which deck an editor is, and which track a server id is
// ---------------------------------------------------------------------------------------------

function deckIds(withB = true) {
  const cm = fakeCm('a');
  const deckBCM = withB ? fakeCm('b') : null;
  // eslint-disable-next-line no-new-func
  const fns = new Function('cm', 'deckBCM', `
    ${grabConst('deckOfCM')}
    ${grabConst('cmOfDeck')}
    const groupsMod = null;
    ${grabConst('deckTrackId')}
    ${grabConst('blockTrackId')}
    ${grab('deckTrackParts')}
    return { deckOfCM, cmOfDeck, deckTrackId, blockTrackId, deckTrackParts };
  `)(cm, deckBCM);
  return { ...fns, cm, deckBCM };
}

test('deck B\'s tracks are "b:<label>" to the server, deck A\'s are the bare label', () => {
  const { deckOfCM, cmOfDeck, deckTrackId, blockTrackId, deckTrackParts, cm, deckBCM } = deckIds();
  assert.equal(deckOfCM(cm), 'a');
  assert.equal(deckOfCM(deckBCM), 'b');
  assert.equal(deckOfCM(null), 'a', 'anything that is not deck B\'s pane is the main deck');
  assert.equal(cmOfDeck('b'), deckBCM);
  assert.equal(cmOfDeck('a'), cm);
  assert.equal(deckTrackId(cm, 'lead'), 'lead');
  assert.equal(deckTrackId(deckBCM, 'lead'), 'b:lead');
  assert.equal(deckTrackId(deckBCM, null), null);
  // ...and a monitored block is its cued track, "<label>~M", on either deck
  assert.equal(blockTrackId(cm, { label: 'lead', monitored: true }), 'lead~M');
  assert.equal(blockTrackId(deckBCM, { label: 'lead', monitored: true }), 'b:lead~M');
  assert.equal(blockTrackId(deckBCM, { label: 'lead', monitored: false }), 'b:lead');
  // ...and back, which is how a capture or a recorded take finds the buffer it belongs in
  assert.deepEqual(deckTrackParts('b:lead'), { ed: deckBCM, label: 'lead' });
  assert.deepEqual(deckTrackParts('lead'), { ed: cm, label: 'lead' });
  // Before DJ mode has ever made deck B there is only one editor to be in.
  const solo = deckIds(false);
  assert.equal(solo.cmOfDeck('b'), solo.cm);
});

test('what the engine hands back about a track is written into that track\'s deck', () => {
  // A plugin captured, a knob moved under conf, a slot held, a take recorded, a bounce landed.
  assert.match(grab('writePluginState'), /const \{ ed, label: trackLabel \} = deckTrackParts\(trackId\);/);
  assert.match(grab('writePluginState'), /return writePresetState\(trackLabel, slot, state, plugin, named, ed\);/);
  assert.match(grab('writePluginState'), /return createPresetForSlot\(code, trackLabel, slot, plugin, state, ed\);/);
  assert.match(grab('upsertParam'), /const \{ ed, label: trackLabel \} = deckTrackParts\(trackId\);/);
  assert.match(grab('paramSpellingInCode'), /deckTrackParts\(trackId\)/);
  assert.match(grab('pollPluginEdits'), /const \{ ed, label \} = deckTrackParts\(e\.trackId\);/);
  assert.match(grab('paintHeldPresets'), /const \{ ed, label \} = deckTrackParts\(h\.trackId\);/);
  assert.match(grab('applyRecording'), /const \{ ed, label: own \} = deckTrackParts\(label\);/);
  assert.match(grab('applyRecording'), /for \(const ed of evalNeeded\) evalDeckOf\(ed, true\);/);
  assert.match(grab('applyBounce'), /const \{ ed, label \} = deckTrackParts\(trackId\);/);
  assert.match(grab('applyBounce'), /evalDeckOf\(ed, true\);/);
  // ...and a held preset is kept off the highlighter in its own deck's document only
  assert.match(grab('inHeldRange'), /heldRanges\.some\(\(\[d, a, b\]\) => d === deck && from >= a && to <= b\)/);
  // ...and the preset panel holds its slot by the server's name for the track
  assert.match(grab('presetHold'), /label: blockTrackId\(presetCM, target\)/);
});

test('a capture into deck B is thawed by deck B\'s evaluation, not deck A\'s', () => {
  // eslint-disable-next-line no-new-func
  const isDeckBCommit = new Function(`${grabConst('isDeckBCommit')}\nreturn isDeckBCommit;`)();
  assert.equal(isDeckBCommit({ trackId: 'b:lead' }), true);
  assert.equal(isDeckBCommit({ trackId: 'lead' }), false);
  assert.match(SRC, /const filed = commitOnEval\.filter\(\(c\) => !isDeckBCommit\(c\)\);\n\s+commitOnEval = commitOnEval\.filter\(isDeckBCommit\);/);
  const b = grab('evalDeckB');
  assert.match(b, /const filed = commitOnEval\.filter\(isDeckBCommit\);/);
  assert.match(b, /commitQueue\.push\(\.\.\.filed\);/);
  assert.match(b, /commitOnEval\.push\(\.\.\.filed\);/, 'and a failed eval leaves them waiting');
});

// ---------------------------------------------------------------------------------------------
// Folding, per editor
// ---------------------------------------------------------------------------------------------

function foldMemory() {
  const cm = fakeCm();
  const deckBCM = fakeCm();
  // eslint-disable-next-line no-new-func
  return { cm, deckBCM, ...new Function('cm', 'deckBCM', `
    const editorFolds = new WeakMap();
    ${grab('foldsOf')}
    ${grab('forgetExpandedFolds')}
    ${grabConst('foldsHere')}
    return { foldsOf, forgetExpandedFolds, foldsHere };
  `)(cm, deckBCM) };
}

test('each deck remembers its own opened chips and folded groups', () => {
  const { cm, deckBCM, foldsOf, forgetExpandedFolds, foldsHere } = foldMemory();
  foldsOf(cm).collapsed.add('drums');
  foldsOf(deckBCM).expanded.add('defs:roll:lead');
  assert.equal(foldsOf(cm), foldsOf(cm), 'one memory per editor, kept');
  assert.ok(!foldsOf(deckBCM).collapsed.has('drums'), 'folding deck A\'s drums leaves deck B\'s drums open');
  assert.ok(!foldsOf(cm).expanded.has('defs:roll:lead'));
  forgetExpandedFolds(deckBCM);
  assert.equal(foldsOf(deckBCM).expanded.size, 0, 'a buffer swapped out on deck B forgets deck B\'s');
  assert.ok(foldsOf(cm).collapsed.has('drums'), '...and only deck B\'s');
  assert.equal(foldsHere(cm), true);
  assert.equal(foldsHere(deckBCM), true, 'deck B folds');
  assert.equal(foldsHere(fakeCm()), false, 'an FX chain editor or an embed does not');
});

test('the fold machinery takes the editor it folds', () => {
  assert.match(grab('refoldAll'), /function refoldAll\(ed = cm\) \{\n\s+if \(!foldsHere\(ed\)\) return;/);
  assert.match(grab('refoldAll'), /foldConfigBlobs\(ed\);/);
  assert.match(grab('foldConfigBlobs'), /const code = ed\.getValue\(\);/);
  assert.match(grab('foldConfigBlobs'), /foldsOf\(ed\)\.openRuns = \[\];/);
  assert.ok(!/(^|[^\w.$])cm\./m.test(codeOf(grab('foldConfigBlobs') + grab('foldSpan') + grab('foldGroups') + grab('foldDefRuns'))),
    'nothing in it folds the main buffer by name');
  assert.match(grab('foldSpan'), /function foldSpan\(ed, fromIdx, toIdx, label, title, key = null, onOpen = null\)/);
  assert.ok(!/refoldEditor|expandedFolds|collapsedGroups\.(add|delete|has)\(|openDefRunSpans/.test(SRC.replace(grab('foldGroups'), '')),
    'the module-level fold state and the deck-A-only refold are gone');
  // Deck B draws the same gutter, and carries the undo hook and the rest of a deck's handlers.
  assert.equal((SRC.match(/gutters: \['CodeMirror-linenumbers', GROUP_GUTTER\],/g) ?? []).length, 2);
  assert.match(SRC, /onEveryDeck\(\(ed\) => ed\.on\('changes', \(_, changes\) => \{\n\s+if \(changes\.some\(\(c\) => c\.origin === 'undo' \|\| c\.origin === 'redo'\)\) refoldAll\(ed\);/);
  assert.match(grab('openMixMode'), /for \(const hook of deckEditorHooks\) hook\(deckBCM\);/);
  // ...and the painter refolds the deck it is on, both ways now.
  assert.match(SRC, /const arRefold = \(\) => refoldAll\(arCM\);/);
});

test('a file loaded onto deck B folds from scratch, like one opened in the main editor', () => {
  assert.match(grab('loadDeckBFile'), /deckBCM\.setValue\(code\);[\s\S]{0,400}forgetExpandedFolds\(deckBCM\);\n\s+refoldAll\(deckBCM\);/);
});

// ---------------------------------------------------------------------------------------------
// Debounced evaluation, aimed at the panel's deck
// ---------------------------------------------------------------------------------------------

function evalRig() {
  const timers = [];
  const ran = [];
  const cm = fakeCm();
  const deckBCM = fakeCm();
  // eslint-disable-next-line no-new-func
  const { deckEvalSoon, evalEditor } = new Function('cm', 'deckBCM', 'evaluate', 'evalDeckB', 'setTimeout', 'clearTimeout', `
    ${grabConst('deckOfCM')}
    ${grab('evalEditor')}
    ${grab('evalDeckOf')}
    ${grab('deckEvalSoon')}
    return { deckEvalSoon, evalEditor };
  `)(
    cm, deckBCM,
    (start) => ran.push(['a', start]),
    (start) => ran.push(['b', start]),
    (fn) => { timers.push(fn); return timers.length; },
    (id) => { if (id) timers[id - 1] = null; },
  );
  const flush = () => { for (const [i, fn] of timers.entries()) if (fn) { timers[i] = null; fn(); } };
  return { deckEvalSoon, evalEditor, ran, flush, cm, deckBCM };
}

test('a panel\'s debounced eval evaluates the deck the panel is editing', () => {
  const r = evalRig();
  r.evalEditor(r.deckBCM);
  r.evalEditor(r.cm);
  assert.deepEqual(r.ran, [['b', false], ['a', false]], 'the update path: the play state stays as it is');
  r.ran.length = 0;
  const slot = { timer: null, ed: null };
  r.deckEvalSoon(slot, r.deckBCM, 150);
  r.deckEvalSoon(slot, r.deckBCM, 150);
  assert.deepEqual(r.ran, [], 'debounced');
  r.flush();
  assert.deepEqual(r.ran, [['b', false]], 'once, on deck B');
});

test('a panel that moves decks with an eval pending fires the first deck\'s at once', () => {
  const r = evalRig();
  const slot = { timer: null, ed: null };
  r.deckEvalSoon(slot, r.cm, 150);
  r.deckEvalSoon(slot, r.deckBCM, 150);
  assert.deepEqual(r.ran, [['a', false]], 'deck A\'s edit is already in its buffer - it is not dropped');
  r.flush();
  assert.deepEqual(r.ran, [['a', false], ['b', false]]);
});

test('every panel schedules through its own deck', () => {
  for (const [fn, slot, bound] of [
    ['prScheduleEval', 'prEvalSoon', 'prCM'], ['lfoScheduleEval', 'lfoEvalSoon', 'lfoCM'],
    ['grooveScheduleEval', 'grooveEvalSoon', 'grooveCM'], ['packScheduleEval', 'packEvalSoon', 'packCM'],
    ['sliceScheduleEval', 'sliceEvalSoon', 'sliceCM'], ['envScheduleEval', 'envEvalSoon', 'envCM'],
  ]) {
    assert.match(grab(fn), new RegExp(`deckEvalSoon\\(${slot}, ${bound}, `), fn);
    assert.ok(!/evaluate\(false\)/.test(grab(fn)), `${fn} no longer evaluates deck A outright`);
  }
  // A preset is evaluated in the deck its program was written into - the panel's, or a capture's.
  assert.match(grab('presetScheduleEval'), /function presetScheduleEval\(ed = presetCM\) \{\n\s+deckEvalSoon\(presetEvalSoon, ed, /);
  assert.match(grab('writeRecordCall'), /deckEvalSoon\(recordEvalSoon, recCM, RECORD_EVAL_DEBOUNCE_MS\)/);
});

test('a dragged definition is re-filed live on its own deck', () => {
  // Each deck's definitions are its own on the server (liveOnDeck), so a drag on deck B's roll
  // must not re-file deck A's roll of the same name.
  assert.match(grab('prPushRoll'), /deck: deckOfCM\(prCM\),/);
  assert.match(SRC, /api\('POST', '\/api\/liveGroove', \{ deck: deckOfCM\(grooveCM\),/);
  assert.match(SRC, /api\('POST', '\/api\/liveSlices', \{ deck: deckOfCM\(sliceCM\),/);
  assert.match(SRC, /api\('POST', '\/api\/liveAuto', \{ deck: arDeck,/);
});

// ---------------------------------------------------------------------------------------------
// The registries act on their panel's deck
// ---------------------------------------------------------------------------------------------

function registry({ panelEd }) {
  const said = [];
  const evaluated = [];
  const opened = [];
  const refolded = [];
  const panel = {
    editor: () => panelEd,
    current: () => null,
    open: (id) => opened.push(id),
    close: () => {},
    carry: () => null,
    sourceCall: () => null,
    setCurrent: () => {},
    syncHead: () => {},
    scheduleEval: () => evaluated.push('panel'),
  };
  const env = {
    cm: fakeCm(),
    logLine: (line) => said.push(line),
    codeOnly: () => () => true,
    matchParen: null,
    splitFirstArg: null,
    idLiteralValue: null,
    lastDefRunEnd: () => null,
    refoldAll: (ed) => refolded.push(ed),
    evalEditor: (ed) => evaluated.push(ed),
    applyEdits: () => {},
    chordLabel: (c) => c,
  };
  const helpers = ['matchParen', 'splitFirstArg', 'idLiteralValue'].map(grab).join('\n\n');
  const keys = Object.keys(env).filter((k) => env[k] !== null);
  // eslint-disable-next-line no-new-func
  const make = new Function(...keys, `
    ${grabConst('DEF_ID_BAD')}
    ${helpers}
    ${grab('makeDefRegistry')}
    return makeDefRegistry;
  `)(...keys.map((k) => env[k]));
  const reg = make({
    kind: 'roll', section: 'pianorolls', defCall: '_roll', useCall: 'pianoroll', emptyBody: '""',
    isData: () => false, library: () => [], libraryNote: 'prebake', panel,
  });
  return { reg, said, evaluated, opened, refolded };
}

test('a registry gesture writes into the deck its panel is on', () => {
  const a = fakeCm('lead: pianoroll("lead")');
  const b = fakeCm('bass: pianoroll("bass")');
  const r = registry({ panelEd: b });
  r.reg.create('verse');
  assert.match(b.text, /_roll\("verse", ""\)/, 'filed in deck B, where the panel is');
  assert.ok(!/verse/.test(a.text), 'and not a character of it in deck A');
  assert.deepEqual(r.refolded, [b], 'deck B is refolded');
  assert.deepEqual(r.opened, ['verse'], 'and the panel shows it, being on that deck');
  assert.deepEqual(r.evaluated, ['panel'], 'through the panel\'s own debounced eval');
  assert.deepEqual(r.reg.defsInBuffer().map((d) => d.id), ['verse'], 'with no code, it reads the panel\'s deck');
});

test('a gesture from elsewhere names its deck, and leaves the panel be', () => {
  // The device window's curve picker: it belongs to whichever deck plays the device.
  const a = fakeCm('');
  const b = fakeCm('');
  const r = registry({ panelEd: b });
  r.reg.withEditor(a, () => r.reg.create('chorus'));
  assert.match(a.text, /_roll\("chorus", ""\)/, 'filed where it was asked for');
  assert.equal(b.text, '', 'not in the panel\'s deck');
  assert.deepEqual(r.opened, [], 'the panel, showing the other deck, is not pointed at it');
  assert.deepEqual(r.evaluated, [a], 'and the deck it was done in is the one re-evaluated');
  // ...and the override does not outlive the gesture
  r.reg.create('bridge');
  assert.match(b.text, /_roll\("bridge", ""\)/);
});

test('the registries\' editor hooks and their evaluation passes', () => {
  const make = grab('makeDefRegistry');
  assert.match(make, /const target = \(\) => override \?\? panelCM\(\);/);
  // Only its fallback names the main buffer; every read and write goes through the target.
  const strays = [...codeOf(make).matchAll(/(^|[^\w.$])cm\.(\w+)/g)].map((m) => m[2]);
  assert.deepEqual(strays, [], `makeDefRegistry still touches cm directly: ${strays.join(', ')}`);
  assert.match(make, /function materialize\(ed = target\(\)\)/);
  assert.match(make, /async function adopt\(id, sc = null, ed = target\(\)\)/);
  for (const [reg, bound] of [
    ['rollDefs', 'prCM'], ['shapeDefs', 'lfoCM'], ['presetDefs', 'presetCM'], ['packDefs', 'packCM'],
    ['sliceDefs', 'sliceCM'], ['autoDefs', 'arCM'], ['grooveDefs', 'grooveCM'],
  ]) {
    const at = SRC.indexOf(`const ${reg} = makeDefRegistry({`);
    assert.ok(at > 0, reg);
    const body = SRC.slice(at, SRC.indexOf('\n});', at));
    assert.match(body, new RegExp(`editor: \\(\\) => ${bound}`), `${reg} acts on ${bound}`);
  }
  // Deck A's evaluation names its own buffer, rather than whatever deck a panel happens to be on.
  assert.match(SRC, /for \(const reg of DEF_REGISTRIES\) reg\.materialize\(cm\);/);
});

// ---------------------------------------------------------------------------------------------
// Deck B's evaluation is deck A's
// ---------------------------------------------------------------------------------------------

test('deck B\'s evaluation makes every pass the main pane\'s does, over its own buffer', () => {
  const b = grab('evalDeckB');
  for (const pass of [
    /if \(byHand\) \{\n\s+forgetExpandedFolds\(deckBCM\);\n\s+refoldAll\(deckBCM\);/,
    /migrateDefNames\(deckBCM\);/,
    /convertLegacyStates\(deckBCM\);/,
    /if \(!prLibraryKnown\) await prRefreshRollList\(\);/,
    /for \(const reg of DEF_REGISTRIES\) reg\.materialize\(deckBCM\);/,
    /openBareGroups\(byHand, deckBCM\);/,
    /openPackById\(newPacks\[0\], \{\}, deckBCM\);/,
    /setPatchScale\(result\.scale, 'b'\);/,
    /setPatchGroove\(result\.groove \?\? null, 'b'\);/,
    /refreshDevicePanel\(\);/,
    /setupHighlighting\(result\.tracks, result\.gridFrom \?\? 0, result\.gridCount \?\? 32, 'b', deckBCM\);/,
    /refoldAll\(deckBCM\);\n\s+prNamesStale\(\);/,
    /loadChainParams\(\);/,
  ]) assert.match(b, pass);
  // ...and the migration passes it runs take the editor they migrate
  for (const fn of ['migrateDefNames', 'dedentDefRuns', 'sinkDefRuns', 'tightenDefRuns', 'renameLegacyDefCalls', 'convertLegacyStates']) {
    assert.match(grab(fn), new RegExp(`function ${fn}\\(ed = cm\\)`), fn);
  }
  assert.match(grab('openBareGroups'), /function openBareGroups\(placeCursor, ed = cm\)/);
  // By hand is the player's own cmd+enter and ↻ on deck B, as on deck A.
  assert.match(grab('deckBEditorKeys'), /play: \(\) => evalDeckB\(true, \{ byHand: true \}\),/);
  assert.match(SRC, /getElementById\('deckBUpdate'\)\.addEventListener\('click', \(\) => evalDeckB\(false, \{ byHand: true \}\)\);/);
});

test('each deck has its own key and feel, and the roll is drawn by its own deck\'s', () => {
  assert.match(SRC, /const deckKeys = \{ a: \{ scale: null, groove: null \}, b: \{ scale: null, groove: null \} \};/);
  assert.match(grab('syncPatchKey'), /const own = deckKeys\[deckOfCM\(prCM\)\];/);
  assert.match(grab('openPianorollEditor'), /syncPatchKey\(\);/);
  // ...and the clock its playhead and its clips are read by is its deck's too
  assert.match(grab('prSongPos'), /const deck = deckOfCM\(prCM\);/);
  assert.match(grab('prSongPos'), /currentCyclePos\(deck\)/);
  assert.match(grab('activeIdIn'), /if \(r\.deck !== deck\) continue;/);
});

// ---------------------------------------------------------------------------------------------
// The rest of what an editor does
// ---------------------------------------------------------------------------------------------

test('deck B\'s editor has deck A\'s keys', () => {
  assert.match(SRC, /extraKeys: deckBEditorKeys\(\),/);
  const keys = grab('deckBEditorKeys');
  for (const key of [
    /save: \(\) => saveFocusedDeck\(\),/,
    /saveAs: \(\) => saveFocusedDeck\(true\),/,
    /'Shift-Alt-Down': \(ed\) => copyLines\(ed, 'down'\),/,
    /'Shift-Alt-Up': \(ed\) => copyLines\(ed, 'up'\),/,
    /'Alt-Up': 'swapLineUp',/,
    /'Alt-Down': 'swapLineDown',/,
    /dj: \(\) => toggleMixMode\(\),/,
    /group: \(ed\) => groupSelection\(ed\),/,
  ]) assert.match(keys, key);
  // ⌘S off the editor saves the deck being worked in
  assert.match(SRC, /saveFocusedDeck\(action === 'saveAs'\);/);
  assert.match(grab('saveDeckBFile'), /api\('POST', '\/api\/patterns\/save', \{ name, code: deckBCM\.getValue\(\) \}\)/);
  assert.match(grab('saveDeckBFile'), /deckBFileName = name;/);
});

test('muted code dims, the menu offers the envelope, and drops land, on either deck', () => {
  assert.match(grab('updateMutedDim'), /function updateMutedDim\(ed = cm\)/);
  assert.match(SRC, /onEveryDeck\(\(ed\) => ed\.on\('change', \(\) => \{\n\s+clearTimeout\(mutedDimTimers\.get\(ed\)\);/);
  const menu = grab('openEditorMenu');
  assert.ok(!/ed === cm/.test(menu), 'nothing on the menu is deck A\'s alone');
  assert.match(menu, /openEnvelopeAt\(ed\.getValue\(\), at, ed\)/);
  assert.match(SRC, /const onDeck = \[cm, deckBCM\]\.find\(\(ed\) => ed\?\.getWrapperElement\(\)\.contains\(e\.target\)\) \?\? null;/);
  assert.match(SRC, /openMidiImport\(file, onDeck \?\? activeCM\(\)\);/);
  assert.match(grab('runMidiImport'), /const ed = st\.ed \?\? cm;/);
  assert.match(grab('insertSnippet'), /refoldAll\(ed\);/);
  assert.match(grab('bounceBlockAtCursor'), /const ed = activeCM\(\);/);
  // ...and a parameter completes against the deck's own track, "b:lead" on deck B
  assert.match(grab('paramHints'), /const track = block \? blockTrackId\(editor, block\) : null;/);
});

test('every panel open on deck B is put away when its buffer goes', () => {
  const close = grab('closePanelsOn');
  for (const [state, bound, fn] of [
    ['prState', 'prCM', 'closePianorollEditor'], ['lfoState', 'lfoCM', 'closeLfoEditor'],
    ['grooveState', 'grooveCM', 'closeGroovePanel'], ['presetState', 'presetCM', 'closePresetPanel'],
    ['packState', 'packCM', 'closePackPanel'], ['sliceState', 'sliceCM', 'closeSlicePanel'],
    ['envState', 'envCM', 'closeEnvelopePanel'], ['recordState', 'recCM', 'closeRecordPanel'],
  ]) assert.ok(close.includes(`if (${state} && ${bound} === ed) ${fn}();`), fn);
  assert.match(grab('closeMixMode'), /closePanelsOn\(deckBCM\);/);
  assert.match(grab('finishDjExit'), /closePanelsOn\(deckBCM\);[\s\S]{0,200}deckBCM\.setValue\(''\);/);
  assert.match(grab('exitDjMode'), /closePanelsOn\(deckBCM\);[^\n]*\n\s+cm\.setValue\(deckBCM\.getValue\(\)\);/);
});

test('the save chord saves the FOCUSED deck in DJ mode, not the one the cursor was last in', () => {
  const calls = [];
  // eslint-disable-next-line no-new-func
  const run = ({ mix = true, active = 'a', cursorIn = 'a', song = {} }, as = false) => {
    calls.length = 0;
    const deckBCM = { name: 'b' };
    new Function('mixModeOn', 'djActiveDeck', 'activeCM', 'deckBCM', 'songPanes', 'logLine', 'saveDeckBFile', 'savePatternFile', 'savePatternFileAs',
      `${grab('saveFocusedDeck')}; saveFocusedDeck(${as});`)(
      mix, active, () => (cursorIn === 'b' ? deckBCM : { name: 'a' }), deckBCM,
      { a: { song: song.a ?? null }, b: { song: song.b ?? null } },
      (m) => calls.push(`log ${m}`), (a) => calls.push(`B ${a}`), () => calls.push('A'), () => calls.push('A as'));
    return [...calls];
  };
  assert.deepEqual(run({ active: 'b', cursorIn: 'a' }), ['B false'], "deck B's ring wins over deck A's cursor");
  assert.deepEqual(run({ active: 'a', cursorIn: 'b' }), ['A'], "deck A's ring wins over deck B's cursor");
  assert.deepEqual(run({ active: 'b' }, true), ['B true'], 'save-as goes to the same deck');
  assert.deepEqual(run({ active: 'a' }, true), ['A as']);
  assert.match(run({ active: 'b', song: { b: { title: 'rola' } } })[0], /^log deck B is playing a song file/);
  assert.deepEqual(run({ mix: false, active: 'a', cursorIn: 'a' }), ['A'], 'off the desk there is one editor');
});
