'use strict';

// ---------------------------------------------------------------------------------------------
// The keyboard model, shared by the app (client.js) and the guide (docs.html) - one file because
// a chord's BINDING and the way a page WRITES it have to be the same rule, and they were not: the
// app bound ctrl+letter for its own chords while the docs spelled them "ctrl+X", which is right on
// a Mac and wrong everywhere else.
//
// poptart asks the keyboard for two separate things and they must not collapse onto one key:
//
//   the EDITING verbs   select all, copy, duplicate, undo      editMod   `mod+`   cmd -> ctrl
//   the APP's chords    arrangement, DJ mode, mixer, cue       appMod    `app+`   ctrl -> alt
//
// On a Mac those are cmd and ctrl, which is why the source is written in those terms throughout.
// Everywhere else cmd doesn't exist, so each family shifts one key along. That keeps them two
// keys rather than one - ctrl+D meant both DJ mode and the editor's delete-forward off macOS, and
// which one you got depended on what had focus - and it moves the app's chords off the ctrl+letter
// shortcuts a browser has already taken (ctrl+P print, ctrl+R reload, ctrl+J downloads).
//
// Everything that needs to know the rule asks one of these, and nothing else tests .metaKey /
// .ctrlKey / .altKey to tell the families apart:
//
//   editMod(e) / appMod(e)   a handler asking which family a keydown belongs to
//   comboToSpec + specMatches   the hotkey dispatcher, via the `mod+` and `app+` tokens
//   CM_MOD / CM_APP             CodeMirror's extraKeys, which spell keys their own way
//   chordLabel(combo)           anything a person reads: tooltips, log lines, the guide
//
// Pointer modifiers (a fine drag, ctrl+wheel zoom) are deliberately outside all of this - those
// are conventions of their own and take either key.
// ---------------------------------------------------------------------------------------------

// The one thing about the machine any of this depends on.
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

const KEY_CODE_MAP = {
  '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  enter: 'Enter', return: 'Enter', space: 'Space', tab: 'Tab', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};

// A combo token -> KeyboardEvent.code, or null if we should fall back to matching event.key.
function keyTokenToCode(tok) {
  if (/^[a-z]$/.test(tok)) return 'Key' + tok.toUpperCase();
  if (/^[0-9]$/.test(tok)) return 'Digit' + tok;
  return KEY_CODE_MAP[tok] ?? null;
}

function comboToSpec(combo) {
  const spec = { meta: false, ctrl: false, shift: false, alt: false, mod: false, app: false, code: null, key: null };
  for (const raw of String(combo).toLowerCase().split('+')) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === 'cmd' || tok === 'meta' || tok === 'command' || tok === 'win' || tok === 'super') spec.meta = true;
    else if (tok === 'ctrl' || tok === 'control') spec.ctrl = true;
    else if (tok === 'shift') spec.shift = true;
    else if (tok === 'alt' || tok === 'option' || tok === 'opt') spec.alt = true;
    else if (tok === 'mod') spec.mod = true;
    else if (tok === 'app') spec.app = true;
    else { spec.code = keyTokenToCode(tok); spec.key = tok; }
  }
  return spec;
}

/**
 * The WORKHORSE modifier - cmd on macOS, ctrl everywhere else. Every editing verb a panel offers
 * (select all, copy, cut, paste, duplicate, undo) asks this rather than taking cmd OR ctrl, so the
 * app's own chords stay distinct from it: app+A opens the arrangement, cmd+A selects everything in
 * it, and neither has to guess which was meant. Pointer modifiers (a fine drag, ctrl+wheel zoom)
 * are deliberately NOT this - those are conventions of their own and take either key.
 */
function editMod(e) {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * The APP modifier - ctrl on macOS, alt everywhere else. The chords that are poptart's own rather
 * than any editor's: the arrangement, DJ mode, the mixer, cue, record, bounce. The mirror of
 * editMod, and exclusive with it by construction, so the two families can never name the same
 * keystroke on any platform (which is exactly what ctrl+D meaning both DJ mode and delete-forward
 * did off macOS).
 *
 * Both halves reject the other family's key outright. Off macOS that also rules out AltGr, which
 * an international keyboard sends as ctrl+alt to type a character - alt+D is an app chord, AltGr+D
 * is a letter, and only the first has ctrl clear.
 */
function appMod(e) {
  return IS_MAC ? e.ctrlKey && !e.metaKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey;
}

function specMatches(spec, e) {
  const wantMeta = spec.meta || (spec.mod && IS_MAC);
  const wantCtrl = spec.ctrl || (spec.mod && !IS_MAC) || (spec.app && IS_MAC);
  const wantAlt = spec.alt || (spec.app && !IS_MAC);
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== wantAlt) return false;
  if (e.shiftKey !== spec.shift) return false;
  if (spec.code) return e.code === spec.code;
  return spec.key != null && e.key.toLowerCase() === spec.key;
}

// The app modifier in CodeMirror's key-name spelling, for the extraKeys tables: `${CM_APP}A` is
// 'Ctrl-A' on macOS and 'Alt-A' elsewhere. CodeMirror's own keymaps bind a handful of the chords
// we want (Ctrl-A goLineStart, Ctrl-D delete-forward, Ctrl-F cursor-right in the Mac keymap), so
// an editor with focus has to be told about them there or it swallows the keystroke.
const CM_APP = IS_MAC ? 'Ctrl-' : 'Alt-';
// ...and the editing modifier in the same spelling, for the chords CodeMirror has to be told about
// because its own keymap wants them (Cmd-G / Ctrl-G is find-next there).
const CM_MOD = IS_MAC ? 'Cmd-' : 'Ctrl-';

// How each modifier and the awkward keys are WRITTEN, per platform: [macOS, elsewhere]. A Mac
// spells a chord in glyphs and no separators (⇧⌘S); everywhere else it is words joined by + .
const CHORD_MODS = {
  mod: ['⌘', 'ctrl+'], // the editing modifier - editMod
  app: ['⌃', 'alt+'], // the app's own - appMod
  ctrl: ['⌃', 'ctrl+'],
  alt: ['⌥', 'alt+'],
  shift: ['⇧', 'shift+'],
  meta: ['⌘', 'cmd+'],
};
const CHORD_KEYS = {
  enter: ['↵', 'enter'], return: ['↵', 'enter'], esc: ['⎋', 'esc'], escape: ['⎋', 'esc'],
  backspace: ['⌫', 'backspace'], delete: ['⌦', 'delete'], tab: ['⇥', 'tab'], space: ['space', 'space'],
  up: ['↑', '↑'], down: ['↓', '↓'], left: ['←', '←'], right: ['→', '→'],
};

/**
 * A chord as a person reads it, from the same combo string comboToSpec takes: chordLabel('app+a')
 * is '⌃A' on a Mac and 'alt+A' elsewhere, chordLabel('mod+s') is '⌘S' / 'ctrl+S'. Every tooltip,
 * log line and doc that names a chord goes through here, so a label can never drift from the key
 * that is actually bound - and a Windows user is never told to press a key that isn't theirs.
 *
 * Modifiers come out in each platform's own order however the combo was written, so the callers
 * don't have to know it.
 */
function chordLabel(combo) {
  const spec = comboToSpec(combo);
  const at = IS_MAC ? 0 : 1;
  const mods = [];
  if (spec.ctrl || (spec.app && IS_MAC) || (spec.mod && !IS_MAC)) mods.push(CHORD_MODS.ctrl[at]);
  if (spec.alt || (spec.app && !IS_MAC)) mods.push(CHORD_MODS.alt[at]);
  if (spec.shift) mods.push(CHORD_MODS.shift[at]);
  if (spec.meta || (spec.mod && IS_MAC)) mods.push(CHORD_MODS.meta[at]);
  const key = spec.key ?? '';
  // A combo with no key at all names the modifier itself, for the prose that talks about a
  // gesture rather than a chord ("shift/ctrl-click for more") - so the joiner comes back off.
  if (!key) return mods.join('').replace(/\+$/, '');
  return mods.join('') + (CHORD_KEYS[key]?.[at] ?? key.toUpperCase());
}

// The editing modifier on its own, for prose about a POINTER gesture rather than a chord
// ("cmd+click to solo"). Those gestures deliberately take either key - see editMod - so this
// names the one a person on this platform would reach for.
const MOD_LABEL = chordLabel('mod');

/**
 * Every `{app+d}` / `{mod+s}` in a piece of text, replaced with this platform's spelling of it.
 * That brace form is how the markup, the tooltips and api-docs.js carry a chord, so the text can
 * be authored (and diffed, and read) as the binding rather than as one platform's keycaps.
 *
 * Anything in braces that isn't a chord is left exactly as it was - `group({…})` appears in the
 * guide, and a combo with no modifier in it is not one of ours.
 */
function expandChords(text) {
  return String(text).replace(/\{([a-z0-9+.\-]+)\}/gi, (whole, combo) => {
    const spec = comboToSpec(combo);
    const modified = spec.mod || spec.app || spec.meta || spec.ctrl || spec.alt || spec.shift;
    return modified ? chordLabel(combo) : whole;
  });
}

// Fill in a tree's chords: <kbd data-chord="app+a"> becomes the label itself, and
// data-chord-title="open the mixer ({app+g})" becomes that element's tooltip.
function paintChordLabels(root = document) {
  for (const el of root.querySelectorAll('[data-chord]')) el.textContent = chordLabel(el.dataset.chord);
  for (const el of root.querySelectorAll('[data-chord-title]')) el.title = expandChords(el.dataset.chordTitle);
}
