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
function load(platform) {
  // eslint-disable-next-line no-new-func
  return new Function('navigator', `${SRC}
    return { IS_MAC, CM_APP, CM_MOD, MOD_LABEL, comboToSpec, specMatches, editMod, appMod, chordLabel, expandChords };`)({ platform });
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

test('every built-in chord is registered as app+, never a literal ctrl+', () => {
  const combos = [...CLIENT.matchAll(/addHotkey\(builtinHotkeys, '([^']+)'/g)].map((m) => m[1]);
  assert.ok(combos.length >= 7, `expected the built-in chords, found ${combos.length}`);
  for (const combo of combos) {
    assert.match(combo, /^app\+/, `${combo} is bound to a literal key rather than the app family`);
  }
});

test('the chords hardcoded outside the dispatcher ask appMod rather than .ctrlKey', () => {
  // The document keydown handler (cue, the arrangement, DJ mode) and the painter's own close key.
  // Each of these was `e.ctrlKey && !e.metaKey && ...` before, which is what collided off macOS.
  for (const key of ['c', 'a', 'd']) {
    assert.match(CLIENT, new RegExp(`app && e\\.key\\.toLowerCase\\(\\) === '${key}'`),
      `the document handler's ${key} chord does not go through appMod`);
  }
  assert.match(CLIENT, /if \(appMod\(e\) && !e\.shiftKey && e\.key\.toLowerCase\(\) === 'a'\) \{ closeArrangeEditor\(\)/);
  assert.match(CLIENT, /const app = appMod\(e\);/);
});

test('the editor binds its app chords through CM_APP, so a keymap cannot keep them', () => {
  // CodeMirror's Mac keymap has Ctrl-A/D/F of its own and never lets them reach the document.
  for (const letter of ['A', 'D', 'F']) {
    assert.ok(CLIENT.includes(`[\`\${CM_APP}${letter}\`]`), `the editor's ${letter} chord is not platform-aware`);
  }
  assert.ok(!/'Ctrl-[ADF]':/.test(CLIENT), 'a literal Ctrl- binding is back in extraKeys');
});

test('the pages carry chords as combos, not as one platform\'s keycaps', () => {
  const index = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const docs = fs.readFileSync(path.join(__dirname, 'public', 'docs.html'), 'utf8');
  for (const [name, html] of [['index.html', index], ['docs.html', docs]]) {
    assert.ok(html.includes('chords.js'), `${name} does not load the keyboard model`);
    // Nothing a person reads may be spelled in cmd glyphs: those are Mac-only, and this is the
    // half a Windows user cannot act on.
    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!visible.includes('⌘'), `${name} still writes ⌘ into the page`);
  }
});
