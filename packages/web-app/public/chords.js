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
  return specKeyMatches(spec, e);
}

// The key half of specMatches, without the modifiers.
function specKeyMatches(spec, e) {
  // A LETTER chord names the character, not the position: alt+A is the key with A printed on it,
  // which on an AZERTY keyboard sits where QWERTY has Q. Matching letters by position there fired
  // app+Q for a press of A and swallowed the keystroke, so the arrangement never opened - and it
  // disagreed with CodeMirror and the document handler, which both go by the character. Position
  // is only the fallback, for a press that types no Latin letter at all (option+A is 'å' on a
  // Mac, and a Cyrillic or Greek layout has no 'a' to give).
  if (spec.code && /^[a-z]$/.test(spec.key) && /^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === spec.key;
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

// ---------------------------------------------------------------------------------------------
// The rebindable chords. Each of the app's own actions names its default combos here, a person can
// learn a different one for any of them (settings → hotkeys…), and every place that takes one of
// these chords asks hotkeyMatches / hotkeyCMKeys for it rather than testing a key of its own - so
// the dispatcher, the document handler and the editors' keymaps all follow a rebinding at once.
//
// An action can hold several combos: the transport and save have always answered to cmd OR ctrl on
// a Mac, and that stays the default. Learning a chord replaces the whole list with that one.
// Overrides are stored as combo strings in the platform tokens (`mod+`, `app+`), so the guide reads
// them through the same rule as everything else.
// ---------------------------------------------------------------------------------------------

const HOTKEY_ACTIONS = [
  { id: 'play', section: 'transport', label: 'play', combos: ['mod+enter', 'ctrl+enter'],
    tip: 'evaluates the code and plays it. In DJ mode, plays the deck clicked into last' },
  { id: 'stop', section: 'transport', label: 'stop', combos: ['mod+.', 'ctrl+.'],
    tip: 'stops playback. In DJ mode, stops only the active deck' },
  { id: 'record', section: 'transport', label: 'record', combos: ['app+r'],
    tip: 'arms and stops MIDI recording, like the ● rec button' },
  { id: 'save', section: 'files', label: 'save', combos: ['mod+s', 'ctrl+s'],
    tip: 'saves over the open pattern\'s file, or asks for a name when it has none' },
  { id: 'saveAs', section: 'files', label: 'save as', combos: ['mod+shift+s', 'ctrl+shift+s'],
    tip: 'saves the buffer under a new name' },
  { id: 'organize', section: 'files', label: 'organize', combos: ['app+o'],
    tip: 'opens and closes the library: saves, imported tracks and playlists' },
  { id: 'arrange', section: 'views', label: 'arrangement', combos: ['app+a'],
    tip: 'opens and closes the arrangement of the deck being worked on' },
  { id: 'dj', section: 'views', label: 'DJ mode', combos: ['app+d'],
    tip: 'switches between the code view and the two-deck DJ view' },
  { id: 'mixer', section: 'views', label: 'mixer', combos: ['app+g'],
    tip: 'opens and closes the level meters, spectrum and stereo field for every playing track' },
  { id: 'sidebar', section: 'views', label: 'sidebar', combos: ['app+p'],
    tip: 'hides and shows the right-hand panel, keeping whichever tab was open' },
  { id: 'projector', section: 'views', label: 'projector', combos: ['f1'],
    tip: 'opens and closes the projector window' },
  { id: 'fx', section: 'code', label: 'add an effect', combos: ['app+f'],
    tip: 'inserts an .fx("") call at the cursor with the plugin list open' },
  { id: 'group', section: 'code', label: 'group tracks', combos: ['mod+g', 'shift+ctrl+g'],
    tip: 'wraps the selected tracks in a group({…})' },
  { id: 'snippets', section: 'code', label: 'snippets', combos: ['app+j'],
    tip: 'keeps the selection as a snippet, or opens the snippet browser when nothing is selected' },
  { id: 'bounce', section: 'code', label: 'bounce', combos: ['app+b'],
    tip: 'bounces the block the cursor is in to audio' },
  { id: 'conf', section: 'code', label: 'conf the track at the caret', combos: [],
    tip: 'turns conf on for the track the cursor is in - knobs moved in its plugin windows are written into the code - and off again' },
  { id: 'capture', section: 'code', label: 'capture plugin edits', combos: ['app+k'],
    tip: 'writes every plugin edit still waiting into the code now. While playing, each plugin captured briefly stops processing' },
  { id: 'rollKeys', section: 'piano roll', label: 'roll keyboard', combos: ['app+m'],
    tip: 'plays the open piano roll\'s track from the computer keyboard (its ⌨ button)' },
  { id: 'quantize', section: 'piano roll', label: 'quantize', combos: ['app+q'],
    tip: 'quantizes the open piano roll; a dialog asks which division' },
  { id: 'loops', section: 'decks', label: 'loops', combos: ['app+l'],
    tip: 'in DJ mode, turns the active deck\'s loop regions on and off. Outside it, releases the loop region playback is in' },
  { id: 'cue', section: 'decks', label: 'cue', combos: ['app+c'],
    tip: 'in DJ mode, held: previews the active deck from its cue point, and drops back on it at release' },
];
const HOTKEY_BY_ID = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, a]));
const HOTKEYS_STORE = 'poptart.hotkeys';
// The page's storage, or null where there is none (the tests load this file outside a browser).
const hotkeyStore = () => (typeof localStorage === 'undefined' ? null : localStorage);

// { [action id]: combo[] } - only the actions someone has changed. An empty list is "no key".
let hotkeyOverrides = readHotkeyOverrides();

function readHotkeyOverrides() {
  try {
    const raw = JSON.parse(hotkeyStore()?.getItem(HOTKEYS_STORE) ?? '{}');
    const out = {};
    for (const [id, combos] of Object.entries(raw ?? {})) {
      if (HOTKEY_BY_ID[id] && Array.isArray(combos)) out[id] = combos.filter((c) => typeof c === 'string' && c);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * One combo as the physical keys it names on this platform, in a fixed order - 'mod+shift+s' and
 * 'shift+mod+s' are one chord, and off macOS so are 'mod+enter' and 'ctrl+enter'. What two combos
 * are compared by, so a chord is never held by two actions under different spellings.
 */
function comboCanon(combo) {
  const s = comboToSpec(combo);
  const parts = [];
  if (s.ctrl || (s.mod && !IS_MAC) || (s.app && IS_MAC)) parts.push('ctrl');
  if (s.alt || (s.app && !IS_MAC)) parts.push('alt');
  if (s.shift) parts.push('shift');
  if (s.meta || (s.mod && IS_MAC)) parts.push('meta');
  if (s.key) parts.push(s.key === 'return' ? 'enter' : s.key === 'esc' ? 'escape' : s.key);
  return parts.join('+');
}

/** The combos an action answers to right now, without duplicates. */
function hotkeyCombos(id) {
  const combos = hotkeyOverrides[id] ?? HOTKEY_BY_ID[id]?.combos ?? [];
  const seen = new Set();
  return combos.filter((c) => {
    const canon = comboCanon(c);
    if (seen.has(canon)) return false;
    seen.add(canon);
    return true;
  });
}

function hotkeyIsDefault(id) {
  return !hotkeyOverrides[id];
}

function hotkeyMatches(id, e) {
  return hotkeyCombos(id).some((c) => specMatches(comboToSpec(c), e));
}

/** The action's first chord as a person reads it, or '' when it has none. */
function hotkeyLabel(id) {
  const [first] = hotkeyCombos(id);
  return first ? chordLabel(first) : '';
}

/** The key that ends a held chord (the cue): its own key, or any modifier it needs. */
function hotkeyReleases(id, e) {
  return hotkeyCombos(id).some((c) => {
    const canon = comboCanon(c);
    if (specKeyMatches(comboToSpec(c), e)) return true;
    return (canon.includes('ctrl') && e.key === 'Control') || (canon.includes('alt') && e.key === 'Alt')
      || (canon.includes('meta') && e.key === 'Meta') || (canon.includes('shift') && e.key === 'Shift');
  });
}

const CM_KEY_NAMES = {
  enter: 'Enter', return: 'Enter', space: 'Space', tab: 'Tab', esc: 'Esc', escape: 'Esc',
  backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};

/** A combo in CodeMirror's key-name spelling ('mod+shift+s' -> 'Shift-Cmd-S' on a Mac). */
function comboToCM(combo) {
  const s = comboToSpec(combo);
  if (!s.key) return null;
  const canon = comboCanon(combo);
  const key = CM_KEY_NAMES[s.key] ?? (/^f\d{1,2}$/.test(s.key) || s.key.length === 1 ? s.key.toUpperCase() : null);
  if (!key) return null;
  return (canon.includes('shift') ? 'Shift-' : '') + (canon.includes('meta') ? 'Cmd-' : '')
    + (canon.includes('ctrl') ? 'Ctrl-' : '') + (canon.includes('alt') ? 'Alt-' : '') + key;
}

/**
 * The extraKeys entries for a table of { [action id]: handler } - each action under every chord it
 * holds now. An editor rebuilds its extraKeys from this whenever the bindings change.
 */
function hotkeyCMKeys(handlers) {
  const out = {};
  for (const [id, fn] of Object.entries(handlers)) {
    for (const combo of hotkeyCombos(id)) {
      const name = comboToCM(combo);
      if (name) out[name] = fn;
    }
  }
  return out;
}

const CODE_KEY_TOKENS = {
  Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Enter: 'enter', NumpadEnter: 'enter',
  Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/**
 * The combo a keydown spells, in the platform tokens: cmd+K on a Mac is 'mod+k', ctrl+K there is
 * 'app+k', and the same two families off macOS. Null while only modifiers are down, or for a key
 * nothing here can name.
 */
function comboFromEvent(e) {
  let key = null;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toLowerCase();
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key.toLowerCase();
  else key = CODE_KEY_TOKENS[e.code] ?? null;
  if (!key) return null;
  const mods = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (IS_MAC ? e.ctrlKey : e.altKey) mods.push('app');
  if (IS_MAC ? e.altKey : e.metaKey) mods.push(IS_MAC ? 'alt' : 'cmd');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}

/**
 * Why a combo can't be an app chord, or null. A key that types something needs a modifier other
 * than shift, or it would fire on every press of that key in the code.
 */
function hotkeyProblem(combo) {
  const canon = comboCanon(combo);
  if (/(^|\+)(ctrl|alt|meta)\+/.test(canon)) return null;
  if (/(^|\+)f\d{1,2}$/.test(canon)) return null;
  return 'needs a modifier';
}

function saveHotkeyOverrides() {
  try {
    hotkeyStore()?.setItem(HOTKEYS_STORE, JSON.stringify(hotkeyOverrides));
  } catch {
    // Storage refused (a private window): the bindings hold for this page and are gone on reload.
  }
  globalThis.dispatchEvent?.(new Event('poptart-hotkeys'));
}

/**
 * Give an action these combos (null = its defaults). A chord another action holds is taken from it,
 * and the labels of those actions come back so the caller can say where each one went.
 */
function setHotkey(id, combos) {
  const wanted = combos ?? HOTKEY_BY_ID[id].combos;
  const canons = new Set(wanted.map(comboCanon));
  const takenFrom = [];
  for (const other of HOTKEY_ACTIONS) {
    if (other.id === id) continue;
    const held = hotkeyCombos(other.id);
    const kept = held.filter((c) => !canons.has(comboCanon(c)));
    if (kept.length === held.length) continue;
    hotkeyOverrides[other.id] = kept;
    takenFrom.push(other.label);
  }
  if (combos) hotkeyOverrides[id] = combos;
  else delete hotkeyOverrides[id];
  saveHotkeyOverrides();
  return takenFrom;
}

function resetAllHotkeys() {
  hotkeyOverrides = {};
  saveHotkeyOverrides();
}

/**
 * The combo a page should SHOW for one it was written with: an app chord that is an action's own
 * default reads as whatever that action holds now, so `{app+g}` in a tooltip follows the mixer
 * wherever it was moved. Editing-family combos are left alone - {mod+s} in a dialog means that
 * dialog's own save, not the app's.
 */
function reboundCombo(combo) {
  const s = comboToSpec(combo);
  if (!s.key || !(s.app || /^f\d{1,2}$/.test(s.key))) return combo;
  const canon = comboCanon(combo);
  const action = HOTKEY_ACTIONS.find((a) => hotkeyOverrides[a.id] && comboCanon(a.combos[0]) === canon);
  return action ? (hotkeyCombos(action.id)[0] ?? combo) : combo;
}

// Another window of this app (the guide, a second tab) changed them.
globalThis.addEventListener?.('storage', (e) => {
  if (e.key !== HOTKEYS_STORE) return;
  hotkeyOverrides = readHotkeyOverrides();
  globalThis.dispatchEvent(new Event('poptart-hotkeys'));
});

// How each modifier and the awkward keys are WRITTEN, per platform: [macOS, elsewhere]. A Mac
// spells a chord in glyphs and no separators (⇧⌘S); everywhere else it is words joined by + .
// (`mod` and `app` have no rows: chordLabel has resolved them to one of these by the time it asks.)
const CHORD_MODS = {
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
  return String(text).replace(/\{(#?)([a-z0-9+.\-]+)\}/gi, (whole, hash, combo) => {
    // `{#play}` names an action rather than a key: whatever chord it holds now.
    if (hash) return HOTKEY_BY_ID[combo] ? hotkeyLabel(combo) || 'no key' : whole;
    const spec = comboToSpec(combo);
    const modified = spec.mod || spec.app || spec.meta || spec.ctrl || spec.alt || spec.shift;
    return modified ? chordLabel(reboundCombo(combo)) : whole;
  });
}

// Fill in a tree's chords: <kbd data-chord="app+a"> becomes the label itself, and
// data-chord-title="open the mixer ({app+g})" becomes that element's tooltip. Run again after a
// rebinding, which is why the markup keeps the combo rather than the label.
function paintChordLabels(root = document) {
  for (const el of root.querySelectorAll('[data-chord]')) el.textContent = chordLabel(reboundCombo(el.dataset.chord));
  for (const el of root.querySelectorAll('[data-chord-title]')) el.title = expandChords(el.dataset.chordTitle);
}
