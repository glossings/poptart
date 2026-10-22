'use strict';

// public/chords.js - the two modifier families, and the one rule that decides both what a chord is
// BOUND to and how it is WRITTEN.
//
// The bug this exists to keep fixed: off macOS there was only one family. editMod() correctly
// answered ctrl there, but the app's own chords were still literal ctrl+letter, so ctrl+A was both
// select-all and the arrangement, ctrl+D both delete-forward and DJ mode, and which one you got
// depended on what had focus - DJ mode could not be opened at all. Several of them were also the
// browser's (ctrl+P print, ctrl+R reload, ctrl+J downloads).
//
// So the families shift one key each off macOS: cmd -> ctrl for editing, ctrl -> alt for the app.
// Every assertion below is checked on BOTH platforms, because a rule that only holds on the
// machine the tests run on is how this happened in the first place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'chords.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// chords.js is a plain browser script over one global. Loading it with a `navigator` of our own is
// the whole of the platform fake - there is nothing else about the machine it reads.
function load(platform, stored = null) {
  // The rebindings live in localStorage; a Map-backed stand-in is all of it chords.js touches.
  const store = new Map(stored ? [['poptart.hotkeys', JSON.stringify(stored)]] : []);
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  // eslint-disable-next-line no-new-func
  return new Function('navigator', 'localStorage', `${SRC}
    return { IS_MAC, CM_APP, CM_MOD, MOD_LABEL, comboToSpec, specMatches, editMod, appMod, chordLabel, expandChords,
      HOTKEY_ACTIONS, hotkeyCombos, hotkeyMatches, hotkeyLabel, hotkeyReleases, hotkeyCMKeys, comboToCM,
      comboFromEvent, hotkeyProblem, setHotkey, resetAllHotkeys, hotkeyIsDefault };`)({ platform }, localStorage);
}
const mac = load('MacIntel');
const pc = load('Win32');

/** A KeyboardEvent as the handlers read one. */
const ev = (key, mods = {}) => ({
  key,
  code: /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
  metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  ...mods,
});
const CMD = { metaKey: true };
const CTRL = { ctrlKey: true };
const ALT = { altKey: true };
const ALTGR = { ctrlKey: true, altKey: true }; // what an international keyboard sends to type a character

// ---------------------------------------------------------------------------------------------
// The families themselves
// ---------------------------------------------------------------------------------------------

test('each family is one key per platform, and they are never the same key', () => {
  assert.equal(mac.editMod(ev('a', CMD)), true);
  assert.equal(mac.appMod(ev('a', CTRL)), true);
  assert.equal(pc.editMod(ev('a', CTRL)), true);
  assert.equal(pc.appMod(ev('a', ALT)), true);

  // The point of the whole change: no keystroke is ever both. On macOS that was already true; off
  // macOS ctrl was both, which is the bug.
  for (const plat of [mac, pc]) {
    for (const mods of [CMD, CTRL, ALT, ALTGR, {}]) {
      assert.ok(!(plat.editMod(ev('a', mods)) && plat.appMod(ev('a', mods))),
        `${JSON.stringify(mods)} answers to both families`);
    }
  }
});

test('the other family\'s key disqualifies a press outright', () => {
  // Held together (cmd+ctrl+A) the intent is not either chord, so neither claims it.
  assert.equal(mac.editMod(ev('a', { metaKey: true, ctrlKey: true })), false);
  assert.equal(mac.appMod(ev('a', { metaKey: true, ctrlKey: true })), false);
  assert.equal(pc.editMod(ev('a', { ctrlKey: true, metaKey: true })), false);
  assert.equal(pc.appMod(ev('a', ALTGR)), false);
});

test('AltGr types a character rather than firing an app chord', () => {
  // A German/Polish/Brazilian keyboard sends ctrl+alt for the third level of a key. alt+D is DJ
  // mode; AltGr+D is a letter, and the ctrl in it is what tells them apart.
  assert.equal(pc.appMod(ev('d', ALTGR)), false);
  assert.equal(pc.specMatches(pc.comboToSpec('app+d'), ev('d', ALTGR)), false);
  assert.equal(pc.specMatches(pc.comboToSpec('app+d'), ev('d', ALT)), true);
});

// ---------------------------------------------------------------------------------------------
// The dispatcher's `app+` token
// ---------------------------------------------------------------------------------------------

test('app+ binds ctrl on macOS and alt elsewhere, and mod+ stays the editing modifier', () => {
  const appG = (p) => p.comboToSpec('app+g');
  assert.equal(mac.specMatches(appG(mac), ev('g', CTRL)), true);
  assert.equal(mac.specMatches(appG(mac), ev('g', ALT)), false);
  assert.equal(pc.specMatches(appG(pc), ev('g', ALT)), true);
  assert.equal(pc.specMatches(appG(pc), ev('g', CTRL)), false, 'ctrl+G off macOS is the editor\'s, not the mixer');

  const modS = (p) => p.comboToSpec('mod+s');
  assert.equal(mac.specMatches(modS(mac), ev('s', CMD)), true);
  assert.equal(pc.specMatches(modS(pc), ev('s', CTRL)), true);
});

test('a literal ctrl+ still means ctrl on every platform', () => {
  // The token did not change meaning - `app+` was added beside it. A prebake that binds ctrl+k
  // gets ctrl+k wherever it runs.
  for (const plat of [mac, pc]) {
    assert.equal(plat.specMatches(plat.comboToSpec('ctrl+k'), ev('k', CTRL)), true);
    assert.equal(plat.specMatches(plat.comboToSpec('ctrl+k'), ev('k', ALT)), false);
  }
});

test('an app chord is not fired by the same letter with nothing held', () => {
  for (const plat of [mac, pc]) {
    assert.equal(plat.specMatches(plat.comboToSpec('app+d'), ev('d')), false);
  }
});

// ---------------------------------------------------------------------------------------------
// Labels - the half that reaches a person
// ---------------------------------------------------------------------------------------------

test('a letter chord follows the letter printed on the key, not its QWERTY position', () => {
  // AZERTY: the key marked A sits where QWERTY has Q, so it reports code KeyQ and key 'a'. Matched
  // by position, alt+A fired app+Q (quantize) and the dispatcher swallowed the press before the
  // arrangement's own handler saw it.
  const azertyA = { ...ev('a', ALT), code: 'KeyQ' };
  const azertyQ = { ...ev('q', ALT), code: 'KeyA' };
  assert.equal(pc.specMatches(pc.comboToSpec('app+q'), azertyA), false);
  assert.equal(pc.specMatches(pc.comboToSpec('app+a'), azertyA), true);
  assert.equal(pc.specMatches(pc.comboToSpec('app+q'), azertyQ), true);
  // AZERTY's M is on the key QWERTY calls Semicolon.
  assert.equal(pc.specMatches(pc.comboToSpec('app+m'), { ...ev('m', ALT), code: 'Semicolon' }), true);
  // Shift only changes the case.
  assert.equal(pc.specMatches(pc.comboToSpec('app+shift+a'), { ...ev('A', { altKey: true, shiftKey: true }), code: 'KeyQ' }), true);

  // A press that types no Latin letter falls back to position: option+A is 'å' on a Mac, and a
  // Cyrillic layout types 'ф' from the same key.
  assert.equal(mac.specMatches(mac.comboToSpec('alt+a'), { ...ev('å', ALT), code: 'KeyA' }), true);
  assert.equal(pc.specMatches(pc.comboToSpec('app+a'), { ...ev('ф', ALT), code: 'KeyA' }), true);

  // Punctuation and digits stay positional, so shift cannot change which chord a key is.
  assert.equal(mac.specMatches(mac.comboToSpec('cmd+shift+.'), { ...ev('>', { metaKey: true, shiftKey: true }), code: 'Period' }), true);
});

test('a chord is written the way the platform it is bound on writes it', () => {
  assert.equal(mac.chordLabel('app+a'), '⌃A');
  assert.equal(pc.chordLabel('app+a'), 'alt+A');
  assert.equal(mac.chordLabel('mod+s'), '⌘S');
  assert.equal(pc.chordLabel('mod+s'), 'ctrl+S');
  assert.equal(mac.chordLabel('mod+enter'), '⌘↵');
  assert.equal(pc.chordLabel('mod+enter'), 'ctrl+enter');
});

test('modifiers come out in the platform\'s order however the combo was written', () => {
  assert.equal(mac.chordLabel('mod+shift+s'), '⇧⌘S');
  assert.equal(mac.chordLabel('shift+mod+s'), '⇧⌘S');
  assert.equal(pc.chordLabel('mod+shift+s'), 'ctrl+shift+S');
  assert.equal(pc.chordLabel('shift+mod+s'), 'ctrl+shift+S');
});

test('a bare modifier names itself, for prose about a pointer gesture', () => {
  // "shift/ctrl-click for more" - a trailing + there would read as an unfinished chord.
  assert.equal(mac.chordLabel('mod'), '⌘');
  assert.equal(pc.chordLabel('mod'), 'ctrl');
  assert.equal(pc.MOD_LABEL, 'ctrl');
  assert.equal(mac.MOD_LABEL, '⌘');
});

test('expandChords replaces chords in a sentence and leaves everything else alone', () => {
  assert.equal(pc.expandChords('press {app+a} to paint it'), 'press alt+A to paint it');
  assert.equal(mac.expandChords('press {app+a} to paint it'), 'press ⌃A to paint it');
  // The guide talks about `group({…})`, and a template's own braces are not ours to touch.
  assert.equal(pc.expandChords('name: group({…})'), 'name: group({…})');
  assert.equal(pc.expandChords('{notachord}'), '{notachord}');
});

test('CodeMirror gets the same rule in its own spelling', () => {
  assert.equal(mac.CM_APP, 'Ctrl-');
  assert.equal(pc.CM_APP, 'Alt-');
  assert.equal(mac.CM_MOD, 'Cmd-');
  assert.equal(pc.CM_MOD, 'Ctrl-');
});

// ---------------------------------------------------------------------------------------------
// ...and that the app actually uses it. These are the checks that would have caught the original
// bug: the rule existing is no use if a handler goes around it.
// ---------------------------------------------------------------------------------------------

test('every built-in chord is a rebindable action, and the app ones default to app+', () => {
  const ids = [...CLIENT.matchAll(/addBuiltinHotkey\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected the built-in chords, found ${ids.length}`);
  assert.ok(!/addHotkey\(builtinHotkeys/.test(CLIENT), 'a built-in chord is bound around the action table');
  for (const id of ids) {
    const action = mac.HOTKEY_ACTIONS.find((a) => a.id === id);
    assert.ok(action, `${id} is not in HOTKEY_ACTIONS`);
    if (id !== 'projector') assert.match(action.combos[0], /^app\+/, `${id} defaults to a literal key rather than the app family`);
  }
});

test('the chords taken outside the dispatcher ask the action table', () => {
  // The document keydown handler and the painter's own close key. Each of these once tested a key
  // of its own, which is what collided off macOS - and what a rebinding could not reach.
  assert.match(CLIENT, /const action = DOC_HOTKEYS\.find\(\(id\) => hotkeyMatches\(id, e\)\);/);
  for (const id of ['cue', 'loops', 'arrange', 'dj', 'organize']) {
    assert.match(CLIENT, new RegExp(`action === '${id}'`), `the document handler's ${id} chord is not the action's`);
  }
  assert.match(CLIENT, /if \(hotkeyMatches\('arrange', e\)\) \{ closeArrangeEditor\(\)/);
  assert.match(CLIENT, /if \(hotkeyReleases\('cue', e\)\) songCueKeyUp\(\);/);
});

test('both editors take their app chords from the table, so a keymap cannot keep them', () => {
  // CodeMirror's Mac keymap has Ctrl-A/D/F of its own and never lets them reach the document.
  assert.match(CLIENT, /extraKeys: mainEditorKeys\(\),/);
  assert.match(CLIENT, /extraKeys: deckBEditorKeys\(\),/);
  assert.equal((CLIENT.match(/\.\.\.hotkeyCMKeys\(\{/g) ?? []).length, 2);
  assert.ok(!/'Ctrl-[ADF]':/.test(CLIENT), 'a literal Ctrl- binding is back in extraKeys');
});

// ---------------------------------------------------------------------------------------------
// Rebinding
// ---------------------------------------------------------------------------------------------

test('the defaults are the chords the app always had', () => {
  assert.deepEqual(mac.hotkeyCombos('play'), ['mod+enter', 'ctrl+enter']);
  // Off macOS mod IS ctrl, so the two defaults are one chord and the list says it once.
  assert.deepEqual(pc.hotkeyCombos('play'), ['mod+enter']);
  assert.equal(mac.hotkeyMatches('organize', ev('o', CTRL)), true);
  assert.equal(pc.hotkeyMatches('organize', ev('o', ALT)), true);
  assert.equal(pc.hotkeyMatches('organize', ev('o', CTRL)), false);
  assert.equal(mac.hotkeyMatches('projector', ev('F1')), true);
  assert.equal(mac.hotkeyLabel('mixer'), '⌃G');
});

test('a learned chord replaces the defaults and takes the chord from whoever held it', () => {
  const p = load('MacIntel');
  assert.deepEqual(p.setHotkey('organize', ['app+g']), ['mixer']);
  assert.equal(p.hotkeyMatches('organize', ev('g', CTRL)), true);
  assert.equal(p.hotkeyMatches('organize', ev('o', CTRL)), false);
  assert.equal(p.hotkeyMatches('mixer', ev('g', CTRL)), false);
  assert.equal(p.hotkeyLabel('mixer'), '');
  // A tooltip written as {app+o} follows the action; one written as {app+g} follows the mixer,
  // which has no key now and so reads as written.
  assert.equal(p.expandChords('library ({app+o})'), 'library (⌃G)');
  assert.equal(p.expandChords('{#mixer}'), 'no key');
  // Reset puts organize back on its own chord and leaves the mixer where the take left it.
  p.setHotkey('organize', null);
  assert.equal(p.hotkeyIsDefault('organize'), true);
  assert.equal(p.hotkeyMatches('organize', ev('o', CTRL)), true);
  p.resetAllHotkeys();
  assert.equal(p.hotkeyMatches('mixer', ev('g', CTRL)), true);
});

test('taking one of two default chords leaves the other', () => {
  const p = load('MacIntel');
  p.setHotkey('mixer', ['ctrl+enter']);
  assert.deepEqual(p.hotkeyCombos('play'), ['mod+enter']);
});

test('the bindings survive a reload, and junk in storage is ignored', () => {
  const p = load('Win32', { stop: ['mod+k'], nonsense: ['mod+q'], save: 'mod+w' });
  assert.equal(p.hotkeyMatches('stop', ev('k', CTRL)), true);
  assert.deepEqual(p.hotkeyCombos('save'), ['mod+s']);
});

test('a keypress becomes a combo in the platform tokens', () => {
  assert.equal(mac.comboFromEvent(ev('k', CMD)), 'mod+k');
  assert.equal(mac.comboFromEvent(ev('k', CTRL)), 'app+k');
  assert.equal(pc.comboFromEvent(ev('k', CTRL)), 'mod+k');
  assert.equal(pc.comboFromEvent(ev('k', ALT)), 'app+k');
  assert.equal(mac.comboFromEvent({ ...ev('>', { metaKey: true, shiftKey: true }), code: 'Period' }), 'mod+shift+.');
  assert.equal(mac.comboFromEvent({ ...ev('Shift', CMD), code: 'ShiftLeft' }), null, 'modifiers alone are not a chord yet');
  assert.equal(mac.comboFromEvent(ev('F5')), 'f5');
});

test('a key that types something needs a modifier other than shift', () => {
  assert.equal(mac.hotkeyProblem('k'), 'needs a modifier');
  assert.equal(mac.hotkeyProblem('shift+k'), 'needs a modifier');
  assert.equal(mac.hotkeyProblem('mod+k'), null);
  assert.equal(mac.hotkeyProblem('f5'), null);
});

test('CodeMirror gets each action under every chord it holds', () => {
  const fn = () => {};
  assert.deepEqual(Object.keys(mac.hotkeyCMKeys({ play: fn })), ['Cmd-Enter', 'Ctrl-Enter']);
  assert.deepEqual(Object.keys(pc.hotkeyCMKeys({ organize: fn })), ['Alt-O']);
  assert.equal(mac.comboToCM('mod+shift+s'), 'Shift-Cmd-S');
  assert.equal(pc.comboToCM('app+.'), 'Alt-.');
});

test('a held chord ends on its key or any of its modifiers', () => {
  assert.equal(mac.hotkeyReleases('cue', ev('c')), true);
  assert.equal(mac.hotkeyReleases('cue', ev('Control')), true);
  assert.equal(mac.hotkeyReleases('cue', ev('Alt')), false);
  assert.equal(pc.hotkeyReleases('cue', ev('Alt')), true);
});

// The guide's chapters, as [name, html].
function guidePages() {
  const dir = path.join(__dirname, 'public', 'docs');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => [`docs/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

test('the unlock-loop chord is the app\'s, because mod+L is the editor\'s selectLine', () => {
  // It was taken with either of cmd/ctrl, and the sublime keymap binds both to selectLine (cmd on
  // macOS, ctrl elsewhere) - so from inside the editor, where the guide says to press it, only
  // macOS's ctrl+L ever arrived. As an app chord it is a key CodeMirror leaves alone everywhere.
  assert.equal(mac.HOTKEY_ACTIONS.find((a) => a.id === 'loops').combos[0], 'app+l');
  const docs = guidePages().map(([, html]) => html).join('\n');
  assert.ok(docs.includes('{app+l}') && !docs.includes('{mod+l}'), 'the guide names the chord that is bound');
});

test('no string a person reads spells a chord by hand, in any of the spellings', () => {
  // The first sweep looked for "ctrl+X", "cmd+X" and the cmd glyph, and so walked past every
  // "cmd-D" in the context menus and log lines - 27 of them, each naming a key a Windows keyboard
  // doesn't have. What is asked here is the general thing: inside a string literal, a modifier
  // joined to a key by - or + is a label that should have come from chordLabel.
  const spelled = /['`"][^'`"]*\b(cmd|ctrl|alt|option)[-+](shift[-+])?([A-Z]\b|enter\b|backspace\b)/;
  // Conventions of their own, on every platform, and not chords at all (see the head of chords.js).
  const allowed = /ctrl\+wheel|ctrl[-+]hover/;
  const offenders = CLIENT.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // comments may say what they like
    .filter(([, line]) => !/^\s*'(Shift-)?(Cmd|Ctrl|Alt)-[^']+'\s*:/.test(line)) // CodeMirror's own key names
    .filter(([, line]) => !/addHotkey\(/.test(line))
    .filter(([, line]) => spelled.test(line.replace(/\/\/.*$/, '')) && !allowed.test(line));
  assert.deepEqual(offenders.map(([n, line]) => `${n}: ${line.trim().slice(0, 90)}`), []);
});

test('the pages carry chords as combos, not as one platform\'s keycaps', () => {
  const index = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  for (const [name, html] of [['index.html', index], ...guidePages()]) {
    assert.ok(html.includes('chords.js'), `${name} does not load the keyboard model`);
    // Nothing a person reads may be spelled in cmd glyphs: those are Mac-only, and this is the
    // half a Windows user cannot act on.
    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!visible.includes('⌘'), `${name} still writes ⌘ into the page`);
    assert.ok(!/\boption-|\bcmd[-+]/i.test(visible), `${name} still names a Mac key in words`);
  }
});
