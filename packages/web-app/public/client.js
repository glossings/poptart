'use strict';

// Browser UI: CodeMirror editor with poptart-aware autocomplete (real VST parameter names
// inside `.param("…")`, plugin names inside `.synth("…")`/`.fx("…")`, documented method/builder
// names elsewhere - see api-docs.js, which also feeds the doc panel beside the popup and the
// ctrl-hover tooltip), live playback highlighting of mini-notation (the atom currently sounding lights
// up, Strudel-style), a searchable params panel, plugin browser, an interactive theme editor,
// and transport - all over the same fetch('/api/…') endpoints. No build step: CodeMirror 5 is
// loaded as plain scripts from /vendor/codemirror/, and pattern-core's own mini parser + label
// splitter are imported as ESM from /pattern-core/ (both served by server.js), so the browser
// computes exactly the same steps the server plays.

const playBtn = document.getElementById('playBtn');
const updateBtn = document.getElementById('updateBtn');
const scanBtn = document.getElementById('scanBtn');
const engineStatus = document.getElementById('engineStatus');
const trackInfo = document.getElementById('trackInfo');
const paramSearch = document.getElementById('paramSearch');
const paramList = document.getElementById('paramList');
const paramsCount = document.getElementById('paramsCount');
const pluginList = document.getElementById('pluginList');
const log = document.getElementById('log');
const LOG_MAX_LINES = 500; // in-app console scrollback (see logLine) - .log() can fill it fast

// pattern-core modules, loaded async at startup; highlighting/label/shape-editor features just
// stay off until they arrive (or if the import fails).
let miniMod = null;
let labelsMod = null;
let shapeMod = null;
let pianorollMod = null;
let notesMod = null; // notes.mjs - pure music-theory helpers piped up to the userland prebake scope
// Resolves once pattern-core is loaded (or failed) - the startup prebake waits on it so a
// top-level noteToMidi()/etc. call in the prebake never races the import.
const coreReady = Promise.all([
  import('/pattern-core/mini.mjs'),
  import('/pattern-core/labels.mjs'),
  import('/pattern-core/shape.mjs'),
  import('/pattern-core/pianoroll.mjs'),
  import('/pattern-core/notes.mjs'),
])
  .then(([m, l, s, pr, nt]) => {
    miniMod = m;
    labelsMod = l;
    shapeMod = s;
    pianorollMod = pr;
    notesMod = nt;
    initLfoEditor();
    initPianorollEditor();
    initRecordPanel();
    initWidgetHandles(); // double-click a call's name to open its editor (needs all of the above)
    updateMutedDim();
  })
  .catch((e) => logLine(`pattern-core import failed (no live highlighting / lfo editor): ${e.message}`, true));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data;
}

function logLine(text, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'error';
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  log.prepend(line);
  // Newest first, so the tail is what gets dropped. A .log()'d track writes a line per event -
  // tens a second - and this panel is a scrollback, not a record: devtools below keeps the lot.
  while (log.childElementCount > LOG_MAX_LINES) log.lastElementChild.remove();
  // Mirror everything to the devtools console too, so the log is still there when the in-app
  // console is minimized (and gets devtools' filtering/timestamps).
  (isError ? console.error : console.log)(`[poptart] ${text}`);
}

function copyText(text, what) {
  navigator.clipboard.writeText(text);
  logLine(`copied ${what}: ${text}`);
}

// ---------------------------------------------------------------------------------------------
// Editor + autocomplete
// ---------------------------------------------------------------------------------------------

// Completion sources. `chainSlots` comes from GET /api/chainParams after each eval:
// [{ track, slot, plugin, params: [{ name, label, index }] }]. `knownPlugins` from the scan.
let chainSlots = [];
let knownPlugins = [];

// BUILDERS / METHODS / API_DOCS / lookupDoc come from api-docs.js (loaded just before this
// script): one documented entry per userland name, and the word lists are derived from it.

// The sublime keymap supplies the expected editing chords (Cmd/Ctrl-/ comment, Cmd/Ctrl-D
// select-next, etc.); extraKeys layers transport + VS Code-style line moving/duplication
// (Alt-Up/Down move, Shift-Alt-Up/Down copy) on top and wins on conflicts.

// VS Code-style copy line up/down: always duplicates the full lines touched by each
// selection (sublime's duplicateLine instead splices the selected region in place).
// A selection ending at column 0 doesn't include that final line, matching VS Code.
function selectionLineSpan(cm, sel) {
  const from = sel.from(), to = sel.to();
  let endLine = to.line;
  if (endLine > from.line && to.ch === 0) endLine--;
  return { startLine: from.line, endLine };
}

function copyLines(cm, dir) {
  cm.operation(() => {
    const sels = cm.listSelections();
    const edits = [];
    const newSels = [];
    let offset = 0;
    for (const sel of sels) {
      const { startLine, endLine } = selectionLineSpan(cm, sel);
      const nLines = endLine - startLine + 1;
      const text = cm.getRange(
        CodeMirror.Pos(startLine, 0),
        CodeMirror.Pos(endLine, cm.getLine(endLine).length)
      );
      if (dir === 'down') {
        // Insert the copy above; the original slides down and stays selected,
        // which reads as "cursor follows the copy below".
        edits.push({ pos: CodeMirror.Pos(startLine, 0), text: text + '\n' });
        offset += nLines;
        newSels.push({
          anchor: CodeMirror.Pos(sel.anchor.line + offset, sel.anchor.ch),
          head: CodeMirror.Pos(sel.head.line + offset, sel.head.ch),
        });
      } else {
        // Insert the copy below; selection stays on the upper (original) lines.
        edits.push({
          pos: CodeMirror.Pos(endLine, cm.getLine(endLine).length),
          text: '\n' + text,
        });
        newSels.push({
          anchor: CodeMirror.Pos(sel.anchor.line + offset, sel.anchor.ch),
          head: CodeMirror.Pos(sel.head.line + offset, sel.head.ch),
        });
        offset += nLines;
      }
    }
    for (let i = edits.length - 1; i >= 0; i--) {
      cm.replaceRange(edits[i].text, edits[i].pos, edits[i].pos, '+copyLine');
    }
    cm.setSelections(newSels);
    cm.scrollIntoView();
  });
}

const cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
  mode: { name: 'javascript' },
  theme: 'poptart',
  keyMap: 'sublime',
  lineNumbers: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  viewportMargin: Infinity,
  extraKeys: {
    'Cmd-Enter': () => evaluate(true),
    'Ctrl-Enter': () => evaluate(true),
    'Cmd-.': doStop,
    'Ctrl-.': doStop,
    'Cmd-S': () => savePatternFile(),
    'Ctrl-S': () => savePatternFile(),
    'Shift-Cmd-S': () => savePatternFileAs(),
    'Shift-Ctrl-S': () => savePatternFileAs(),
    'Shift-Alt-Down': (cm) => copyLines(cm, 'down'),
    'Shift-Alt-Up': (cm) => copyLines(cm, 'up'),
    'Alt-Up': 'swapLineUp',
    'Alt-Down': 'swapLineDown',
    'Ctrl-Space': () => showPoptartHint(),
  },
});

// Transport and save hotkeys work no matter what has focus (params search, plugin list, …). When
// the editor has focus CodeMirror handles these first and preventDefaults, so no double-fire.
// A dialog on screen owns the keyboard, though - not least because Cmd+S inside the prebake editor
// means "save the prebake".
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
  if (document.querySelector('.dir-picker-backdrop:not(.hidden)')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    evaluate(true);
  } else if (e.key === '.') {
    e.preventDefault();
    doStop();
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault(); // the browser's own "save page" is never what's wanted here
    if (e.shiftKey) savePatternFileAs();
    else savePatternFile();
  }
});

// ---------------------------------------------------------------------------------------------
// Browser history as a recovery net, + sharing.
//
// Evaluating, saving and loading each pin the buffer as a real history entry, so the browser's
// own history becomes a list of every state you cared about - searchable, because the tab title
// carries the pattern's @title (see updateDocTitle). Lose the file and the buffer both and the
// code is still reachable through Back, which loads that state into the editor rather than doing
// nothing.
//
// The URL holds a short SNAPSHOT ID (#s=…), not the code. It used to hold the whole buffer,
// base64'd - which broke both halves of the idea once a patch carried captured plugin state:
//
//   - pushState with a megabyte-long URL is slow (Chrome canonicalizes it, repaints the omnibox
//     and writes the session-history entry to disk, on the main thread), and checkpointing ran
//     *before* the eval request - so every Cmd+Enter paid that delay before the sound changed.
//   - Chrome's history database drops URLs past a couple of kilobytes, so the states never
//     appeared in chrome://history at all. The very thing the encoding was for didn't work.
//
// Typing no longer touches the URL either: the recovery net for un-checkpointed work is the wip
// autosave (on disk) plus restoreBuffer below (for a reload of this tab), neither of which costs
// a navigation.
//
// Sharing a patch is "export" - the file, which carries captured plugin state at any size. Links
// are only read here, never written: a base64 hash still decodes, so a link made back when the
// app minted them, and any history entry from before snapshots, both still open.
// ---------------------------------------------------------------------------------------------

function decodeCodeHash(hash) {
  const bin = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

let lastCheckpointCode = null;
let restoringFromHistory = false;
let checkpointSeq = 0; // checkpoints store asynchronously; only the newest may touch the URL

// The pattern file this buffer IS: the row lit up in the files tab, and what `save` writes over
// without asking. Null when the buffer has never been kept under a name (a fresh ＋ new, a loaded
// session, an import) - `save` then asks for one, the same as `save as`. Kept here rather than in
// a text field so it can only ever say a file that exists: everything that changes which pattern
// is open goes through setCurrentSavedName.
let currentSavedName = null;

function currentFileName() {
  return currentSavedName ?? '';
}

// What the browser tab (and therefore every history entry) is called: the pattern's own @title,
// else the name it's saved under, else a block label out of the code. This is the whole reason a
// history entry is findable later - "poptart" ten times over would not be.
function updateDocTitle(code) {
  const label = displayLabel({
    title: parseMeta(code).title,
    name: currentFileName(),
    code,
    borrowBlockLabel: true, // an unsaved buffer has no name to go by
  });
  document.title = code.trim() ? `${label} · poptart` : 'poptart';
}

// Survives a reload of THIS tab (and nothing else), which is what the URL used to cover for work
// typed since the last checkpoint. Per-tab by nature, so a shared link opened in a new tab still
// gets the code from its own hash. Kept best-effort: a buffer too big for the quota just isn't
// restorable this way, and the wip file on disk still has it.
const RESTORE_KEY = 'poptart.restoreBuffer';
// Restored alongside it, so a reload doesn't quietly cut the buffer loose from its file and turn
// the next save into a naming prompt.
const DOC_NAME_KEY = 'poptart.docName';

function saveRestoreBuffer(code) {
  try {
    sessionStorage.setItem(RESTORE_KEY, code);
  } catch {
    sessionStorage.removeItem(RESTORE_KEY); // over quota - a stale buffer would be worse
  }
}

// The one way the open pattern changes. `name` is a saved pattern's file name, or null for a
// buffer that isn't one yet.
function setCurrentSavedName(name) {
  currentSavedName = name || null;
  try {
    if (currentSavedName) sessionStorage.setItem(DOC_NAME_KEY, currentSavedName);
    else sessionStorage.removeItem(DOC_NAME_KEY);
  } catch {
    // no persistence across a reload, which is a smaller loss than failing the save
  }
  updateDocTitle(cm.getValue());
  markCurrentFileRow();
  // With no name field on screen, the button is where "which file does save write to?" gets
  // answered when the files tab isn't open.
  const saveBtn = document.getElementById('fileSaveBtn');
  if (saveBtn) {
    saveBtn.title = currentSavedName
      ? `save the buffer over "${currentSavedName}" (⌘/Ctrl+S)`
      : 'name this pattern and save it (⌘/Ctrl+S)';
  }
}

// Called on the typing debounce. The URL is deliberately left alone here.
function syncBufferState() {
  const code = cm.getValue();
  updateDocTitle(code);
  saveRestoreBuffer(code);
}

// Pin the current buffer as a history entry. Called at the moments worth returning to - eval,
// save, load - and deduped, so repeatedly hitting play doesn't pile up identical entries.
//
// Deliberately NOT awaited by its callers: storing the snapshot is a round trip, and the whole
// point of the id-in-URL design is that the recovery net never sits in front of the sound. The
// title is set synchronously, though, since that's what the history entry is named after.
function checkpointUrl() {
  const code = cm.getValue();
  if (!code.trim() || code === lastCheckpointCode) return;
  lastCheckpointCode = code;
  updateDocTitle(code);
  saveRestoreBuffer(code);
  const seq = ++checkpointSeq;
  api('POST', '/api/snapshot', { code })
    .then(({ id }) => {
      // A later checkpoint (or a Back) already moved the URL - this one is stale, and pushing it
      // now would reorder history behind the user's back.
      if (seq !== checkpointSeq) return;
      if (location.hash === `#s=${id}`) return; // this entry already is that state
      history.pushState(null, '', `#s=${id}`);
    })
    .catch((e) => logLine(`could not add this state to browser history (${e.message ?? e})`, true));
}

// A hash is either `s=<id>` (a snapshot on this machine) or, for a shared link and for history
// entries made before snapshots existed, the whole buffer base64'd. The two ways this can come
// back empty are told apart by the caller, because they mean opposite things to the user: a
// pruned snapshot is expected housekeeping, a link that won't decode is a damaged link.
const HASH_EMPTY = { reason: 'empty' };
const HASH_PRUNED = { reason: 'pruned' };
const hashDamaged = (len) => ({ reason: 'damaged', len });

async function loadCodeFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return HASH_EMPTY;
  if (hash.startsWith('s=')) {
    const { code } = await api('GET', `/api/snapshot?id=${encodeURIComponent(hash.slice(2))}`);
    return code === null ? HASH_PRUNED : code;
  }
  try {
    return decodeCodeHash(hash);
  } catch {
    return hashDamaged(hash.length);
  }
}

// How a patch is shared: as a file. It is exactly the code - captured
// plugin states included, since those live in the code - so it is also just what the patterns
// folder holds, and the other end can import it or drop it straight into ~/.poptart/patterns.
async function exportPatch() {
  await settlePluginState(); // the file has to carry the sound as it is right now
  const code = cm.getValue();
  if (!code.trim()) {
    logLine('nothing to export - the buffer is empty', true);
    return;
  }
  const label = displayLabel({ title: parseMeta(code).title, name: currentFileName(), code, borrowBlockLabel: true });
  const stem = (label || 'patch').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'patch';
  try {
    const name = `${stem}.js`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    logLine(`exported ${name} (${(code.length / 1024).toFixed(1)}kb) - send that file to share the patch`);
  } catch (e) {
    logLine(`could not export: ${e.message ?? e}`, true);
  }
}

async function importPatch(file) {
  if (!file) return;
  try {
    const text = await file.text();
    if (!text.trim()) throw new Error('the file is empty');
    // Deliberately not opened *as* a saved pattern: nothing of that name is in the folder yet, and
    // save must never write to a file the user hasn't been shown. The file name is only a
    // suggestion for when they do save it.
    await openInEditor(text, null);
    saveNameHint = file.name.replace(/\.js$/i, '');
    logLine(`imported ${file.name} - Cmd/Ctrl+Enter to play it`);
  } catch (e) {
    logLine(`could not import ${file.name}: ${e.message ?? e}`, true);
  }
}

// Put `code` in the editor without letting the change handler push the URL around.
function setBufferQuietly(code) {
  restoringFromHistory = true; // CodeMirror fires 'change' synchronously from setValue
  try {
    cm.setValue(code);
  } finally {
    restoringFromHistory = false;
  }
  foldConfigBlobs();
  lastCheckpointCode = code;
  updateDocTitle(code);
}

// Opening the app: a reload of this tab keeps whatever was in the buffer, otherwise the hash
// decides (a shared link, a history entry, or nothing - the default snippet).
(async () => {
  const restored = sessionStorage.getItem(RESTORE_KEY);
  if (restored !== null) {
    // The name goes back with the buffer it belongs to, even when the buffer itself is already
    // what's in the editor - otherwise a reload leaves the pattern open but nameless.
    currentSavedName = sessionStorage.getItem(DOC_NAME_KEY) || null;
    if (restored !== cm.getValue()) {
      setBufferQuietly(restored);
      return;
    }
  }
  updateDocTitle(cm.getValue());
  if (!location.hash) return;
  let code = null;
  try {
    code = await loadCodeFromHash();
  } catch (e) {
    logLine(`could not read the code this URL points at (${e.message ?? e})`, true);
    return;
  }
  if (code === HASH_EMPTY) return; // a bare "#" - nothing was being pointed at
  if (code === HASH_PRUNED) {
    logLine('the URL points at a state that is no longer stored - keeping the default snippet', true);
    return;
  }
  if (code.reason === 'damaged') {
    logLine(
      `this share link is incomplete (${(code.len / 1024).toFixed(1)}kb of code in it, which did not decode) - ` +
        'a link this long is usually cut short by the address bar it was pasted into. Ask for the ' +
        'patch as an exported file instead.',
      true,
    );
    return;
  }
  setBufferQuietly(code);
  saveRestoreBuffer(code);
  // An incoming share link carries the whole buffer. Trade it for a snapshot id in place (no new
  // history entry - this IS that entry), so the address bar stops being a megabyte long and the
  // rest of the session behaves like any other. The link that was shared still works; it just
  // isn't what this tab keeps navigating with.
  if (!location.hash.startsWith('#s=')) {
    api('POST', '/api/snapshot', { code })
      .then(({ id }) => history.replaceState(null, '', `#s=${id}`))
      .catch(() => {}); // the long hash keeps working - nothing to tell the user
  }
})();

// Back/Forward: put that state back in the editor. No confirm needed - the buffer being replaced
// keeps its own work-in-progress file on the way out (rollWipSession), so navigating away from
// something you never named still can't lose it.
window.addEventListener('popstate', async () => {
  let code = null;
  try {
    code = await loadCodeFromHash();
  } catch (e) {
    logLine(`could not read that history entry (${e.message ?? e})`, true);
    return;
  }
  if (code === HASH_EMPTY) return;
  if (code === HASH_PRUNED || code.reason === 'damaged') {
    logLine('that state has been pruned from the snapshot store - nothing to restore', true);
    return;
  }
  if (code === cm.getValue()) return;
  await rollWipSession();
  setBufferQuietly(code);
  saveRestoreBuffer(code);
  checkpointSeq++; // an in-flight checkpoint must not push its URL over where we just landed
  logLine('restored code from browser history - Cmd/Ctrl+Enter to play it');
});

// ---------------------------------------------------------------------------------------------
// Live-reload (see server.js serveDevReload): a `reload` event means a public/ file changed under
// a running server; a `boot` id different from the one this page connected with means the server
// restarted (node --watch picked up a server-side edit) while the stream was down. Either way the
// page refreshes itself - the buffer rides sessionStorage back in (saveRestoreBuffer), so work
// typed since the last debounce tick is carried along explicitly before reloading.
// ---------------------------------------------------------------------------------------------

(() => {
  const es = new EventSource('/api/devReload');
  let bootId = null;
  // An edit to a file the server ALSO loads (public/pattern-meta.js) both broadcasts a reload and
  // restarts the process - reloading into the gap would strand the tab on a browser error page
  // with no EventSource left to recover it. So the reload waits until the server answers again.
  let reloading = false;
  async function reloadWhenUp() {
    if (reloading) return;
    reloading = true;
    saveRestoreBuffer(cm.getValue());
    for (let i = 0; i < 40; i++) {
      try {
        await fetch('/', { method: 'HEAD', cache: 'no-store' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    location.reload(); // after the retry budget, reload anyway and let the browser say what's wrong
  }
  es.addEventListener('boot', (e) => {
    if (bootId !== null && e.data !== bootId) return reloadWhenUp();
    bootId = e.data;
  });
  es.addEventListener('reload', reloadWhenUp);
})();

// ---------------------------------------------------------------------------------------------
// Config folding: captured plugin-state blobs (`synth("Serum 2", { state: "..." })`) and long
// lfo() shape strings collapse to a small clickable widget so they don't drown the code. The
// full text stays in the buffer - and therefore in the URL hash - only the *display* folds.
// Click a widget to expand it; everything re-folds on load and after each eval.
// ---------------------------------------------------------------------------------------------

function foldSpan(fromIdx, toIdx, label, title) {
  const from = cm.posFromIndex(fromIdx);
  const to = cm.posFromIndex(toIdx);
  if (cm.findMarks(from, to).some((mk) => mk.poptartFold)) return; // already folded
  const widget = document.createElement('span');
  widget.className = 'cm-config-fold';
  widget.textContent = label;
  widget.title = title;
  const mk = cm.markText(from, to, { replacedWith: widget, atomic: true });
  mk.poptartFold = true;
  widget.onclick = () => mk.clear();
}

function foldConfigBlobs() {
  const code = cm.getValue();
  let m;
  // Captured plugin state - megabytes of base64, so a simple regex is safe. The text stays in the
  // buffer (it *is* the patch); only the display folds, to a chip showing what it weighs.
  const stateRe = /\{\s*state:\s*"[A-Za-z0-9+/=]+"\s*\}/g;
  while ((m = stateRe.exec(code))) {
    const kb = Math.max(1, Math.round(m[0].length / 1024));
    foldSpan(m.index, m.index + m[0].length, `{◆ ${kb}kb}`, 'captured plugin state — click to expand');
  }
  // lfo() shape strings and pianoroll() note strings: editor-written data, not code to read, so
  // they always fold - length doesn't matter. An empty string is left alone: there's nothing to
  // hide, and a "⋯" chip would imply content that isn't there.
  const DATA_ARG_TITLES = {
    lfo: 'lfo shape — click to expand, or use the shape editor',
    pianoroll: 'piano roll notes — click to expand, or use the piano roll editor',
  };
  const dataArgRe = /\b(lfo|pianoroll)\s*\(\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((m = dataArgRe.exec(code))) {
    const str = m[2];
    if (str.length <= 2) continue; // "" - already as small as it gets
    const start = m.index + m[0].length - str.length;
    foldSpan(start, start + str.length, '"⋯"', DATA_ARG_TITLES[m[1]]);
  }
}

// String/bracket-aware scan from an opening paren to its matching close; -1 if unbalanced. The one
// call-span scanner in this file - conf's param upsert, the lfo/pianoroll editors, and the MIDI
// recorder's call rewrites all go through it.
function matchParen(code, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Tells whether a character offset in `code` is live code rather than text inside a comment or a
// string (labels.mjs's own lexer, so this agrees with the block splitter). Every regex below that
// hunts for a call to rewrite asks this about its match: a commented-out `.synth("Serum 2", …)` is
// a preset you are not hearing, and it must not receive the running plugin's state or take up a
// slot number. Falls back to "everything is code" before pattern-core has loaded, which is also
// when none of these rewrites can run anyway.
function codeOnly(code) {
  const mask = labelsMod?.codeMask ? labelsMod.codeMask(code) : null;
  return (idx) => !mask || mask[idx] === 1;
}

// Locates the synth(...) call (slot 0) or the slot-th .fx(...) call inside a track's block and
// returns where its `{ state }` argument goes: [afterFirstArg, closeParen). Commented-out calls
// are skipped entirely - they neither match nor count towards the .fx() numbering, so the slots
// here are the slots the evaluated chain has.
function findChainCall(code, from, to, slot) {
  const re = /\b(synth|fx)\s*\(/g;
  re.lastIndex = from;
  const isCode = codeOnly(code);
  let m;
  let fxSeen = 0;
  while ((m = re.exec(code)) && m.index < to) {
    if (!isCode(m.index)) continue;
    const isTarget = m[1] === 'synth' ? slot === 0 : ++fxSeen === slot;
    if (!isTarget) continue;
    const open = m.index + m[0].length - 1;
    const closeParen = matchParen(code, open);
    if (closeParen < 0 || closeParen > to) return null;
    const lit = firstStringLiteral(code, open + 1, closeParen);
    if (!lit) return null;
    return { afterFirstArg: lit.end, closeParen, plugin: lit.content };
  }
  return null;
}

// First string literal in [from, to): its unescaped content and the index just past its closing
// quote, or null. Used by conf's param upsert to read a .param("name", ...) call's name.
function firstStringLiteral(code, from, to) {
  for (let i = from; i < to; i++) {
    const q = code[i];
    if (q !== '"' && q !== "'") continue;
    let s = '';
    for (let j = i + 1; j < to; j++) {
      if (code[j] === '\\') { s += code[j + 1]; j++; }
      else if (code[j] === q) return { content: s, end: j + 1 };
      else s += code[j];
    }
    return null;
  }
  return null;
}

// Finds an existing `.param("name", <value>)` call for `name` within [from, to) and returns the
// character range of its value argument (after the separator comma, up to the close paren), so
// conf can overwrite the value in place instead of appending a duplicate. null if not present.
function findParamCall(code, from, to, name) {
  const re = /\.param\s*\(/g;
  re.lastIndex = from;
  const isCode = codeOnly(code);
  let m;
  while ((m = re.exec(code)) && m.index < to) {
    if (!isCode(m.index)) continue; // a commented-out .param() keeps its value; write a live one
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0 || close > to) continue;
    const lit = firstStringLiteral(code, open + 1, close);
    if (!lit || lit.content !== name) continue;
    let i = lit.end;
    while (i < close && code[i] !== ',') i++;
    if (code[i] !== ',') continue;
    return { valueStart: i + 1, valueEnd: close };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Auto-pin: `synth("Serum 2")` with no state argument means "however the plugin defaults", but
// the moment you touch anything in the plugin's own window that stops being true. The server
// notices the edit, captures the state (debounced - see captureDirtyPlugins), and we write it
// into that slot's synth/fx call as `{ state }`. So the code always describes what you're hearing.
//
// What gets written is the state itself - the plugin's whole program, gzipped and base64'd, often
// megabytes of it. The buffer carries the sound, which is what lets you duplicate a line, change
// the preset on one copy, and swap between them by commenting: both states are right there in the
// text. It folds to a chip on screen (foldConfigBlobs), so what you read stays short.
//
// The state lands about half a second after you let go of the knob. Asking a plugin for its program
// suspends it briefly, which you can hear, so there is a second mode (POPTART_AUTOPIN=deferred)
// that holds captures during a performance and takes them at the next eval/stop/save instead -
// quieter, but your sound design sits outside the buffer until then. settlePluginState below is
// what the actions that write the buffer out use to make sure nothing is still being held.
// ---------------------------------------------------------------------------------------------

function writePluginState(trackLabel, slot, state, plugin) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === trackLabel);
  const call = block && findChainCall(code, block.start, block.end, slot);
  if (!call) {
    // The call was renamed or deleted between the gesture and the capture. Nothing to write to;
    // the next edit in that plugin captures again.
    logLine(`auto-pin: no ${slot === 0 ? 'synth(...)' : '.fx(...)'} call for track "${trackLabel}" slot ${slot} - state not written`, true);
    return;
  }
  // A slot is a position, and positions move: reorder two .fx(...) calls between the gesture and
  // the capture and slot 2 is a different plugin than the one this state came out of. Writing it
  // there would put a reverb's program in a chorus's call - the state is only ever written to a
  // call naming the plugin it was captured from.
  if (plugin && call.plugin !== plugin) {
    logLine(`auto-pin: "${trackLabel}" slot ${slot} is ${call.plugin || 'something else'} now, not ${plugin} - state not written (re-touch the plugin to capture it again)`, true);
    return;
  }
  const replacement = `, { state: "${state}" }`;
  const from = cm.posFromIndex(call.afterFirstArg);
  const to = cm.posFromIndex(call.closeParen);
  // Identical text means the plugin came back exactly as the code already describes it - a gesture
  // that landed back where it started, or a capture racing an edit elsewhere. Writing it anyway
  // would spend an undo step, a change event and a megabyte-scale buffer edit on nothing.
  if (cm.getRange(from, to) === replacement) return;
  // Tagged with a single `+`-prefixed origin so CodeMirror merges consecutive writes into one
  // undo step (same trick as the copy-line edits), so a knob drag can't bury your last real edit
  // under a run of captures in the undo history.
  cm.replaceRange(replacement, from, to, '+autopin');
  foldConfigBlobs();
}

// Deliberately does NOT re-evaluate: the state is already live in the plugin (it came from
// there), so an eval would only push it back and make the plugin reload what it already has.
let pinsPending = 0; // slots the server is holding uncaptured, so we mention it once, not per poll

async function pollPluginEdits({ flush = false } = {}) {
  const { edits, logs, pending } = await api('POST', '/api/pluginEdits', { flush });
  for (const e of edits ?? []) writePluginState(e.trackId, e.slot, e.state, e.plugin);
  // .log() event lines from the scheduler, which runs server-side - same drain, same 500ms.
  for (const line of logs ?? []) logLine(line);
  // Said once when edits start being held, so a plugin tweak that hasn't reached the code yet
  // doesn't look like auto-pin missed it.
  if (pending && !pinsPending) {
    logLine('plugin edited - writing its state into the code on the next play, stop or save (capturing it now would interrupt the plugin)');
  }
  pinsPending = pending ?? 0;
}

setInterval(() => pollPluginEdits().catch(() => {}), 500);

// Before writing the buffer out anywhere it has to be true - saving, exporting, sharing - settle
// any plugin edit the server is still holding (it defers captures while the clock runs, because
// each one briefly suspends the plugin: see the auto-pin section of server.js). The states land in
// the buffer first, so what gets written is the sound you can actually hear.
async function settlePluginState() {
  try {
    await pollPluginEdits({ flush: true });
  } catch {
    // The engine is down or the capture failed - already logged server-side. Writing the buffer
    // out with the states it has beats refusing to save over it.
  }
}

// ---------------------------------------------------------------------------------------------
// "conf" (configure) capture, Ableton-style: toggle it on for a track, then every knob you move
// in that track's plugin editor windows is dropped into the code as .param("Name", value). The
// server coalesces the touched parameters (latest value per param) and we poll for them; each is
// inserted right after its slot's synth()/.fx() call (so it targets that plugin) or, if a
// .param("Name", ...) for it already exists in the block, overwrites that value in place.
// ---------------------------------------------------------------------------------------------

let confSession = null; // { trackLabel, timer } while a track is configuring

async function toggleConf(trackLabel, btn) {
  if (confSession && confSession.trackLabel === trackLabel) {
    await stopConf();
    return;
  }
  await stopConf(); // only one track configures at a time
  try {
    await api('POST', '/api/confMode', { trackId: trackLabel, on: true });
  } catch (e) {
    logLine(e.message ?? String(e), true);
    return;
  }
  confSession = { trackLabel, timer: setInterval(() => pollConf().catch(() => {}), 200) };
  btn?.classList.add('conf-active');
  logLine(`conf on for "${trackLabel}" - move knobs in its plugin windows and they drop into the code (click conf again to finish)`);
}

async function stopConf() {
  if (!confSession) return;
  const { trackLabel, timer } = confSession;
  clearInterval(timer);
  confSession = null;
  try { await pollConf(trackLabel); } catch {} // final drain of anything touched since the last poll
  try { await api('POST', '/api/confMode', { trackId: trackLabel, on: false }); } catch {}
  document.querySelectorAll('.conf-active').forEach((b) => b.classList.remove('conf-active'));
}

async function pollConf(labelOverride) {
  const trackLabel = labelOverride ?? confSession?.trackLabel;
  if (!trackLabel) return;
  const { active, params } = await api('POST', '/api/confPending', { trackId: trackLabel });
  for (const p of params ?? []) upsertParam(trackLabel, p.slot, p.name, p.value);
  // active:false on a session we think is live means the server restarted out from under it -
  // stop and say so instead of silently polling a dead session with the button still lit.
  // (Not on the final-drain call from stopConf, which passes labelOverride and expects this.)
  if (!active && !labelOverride && confSession?.trackLabel === trackLabel) {
    await stopConf();
    logLine('conf: the server lost this capture session (restarted?) - click conf again to re-arm it', true);
  }
}

function upsertParam(trackLabel, slot, name, value) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === trackLabel);
  if (!block) return;
  // Overwrite an existing .param() for this name, else insert one targeting the touched slot.
  const existing = findParamCall(code, block.start, block.end, name);
  if (existing) {
    cm.replaceRange(` ${value}`, cm.posFromIndex(existing.valueStart), cm.posFromIndex(existing.valueEnd));
    return;
  }
  const call = findChainCall(code, block.start, block.end, slot);
  if (!call) {
    logLine(`conf: couldn't find slot ${slot}'s call in "${trackLabel}" - re-evaluate and try again`, true);
    return;
  }
  cm.replaceRange(`.param(${JSON.stringify(name)}, ${value})`, cm.posFromIndex(call.closeParen + 1));
}

let hashTimer = null;
cm.on('change', () => {
  clearTimeout(hashTimer);
  // A history restore already put this state on screen - re-titling and re-storing it is just
  // work, and the entry the user navigated to is already what the URL says.
  if (!restoringFromHistory) hashTimer = setTimeout(syncBufferState, 400);
  clearTimeout(mutedDimTimer);
  mutedDimTimer = setTimeout(updateMutedDim, 150);
  scheduleWipSave();
});

// ---------------------------------------------------------------------------------------------
// Work-in-progress autosave. Everything you type goes to a file on disk whether or not you ever
// name it: one file per editing session, filed by month, under ~/.poptart/patterns/wip/. So a
// closed tab, a crash, or a "＋ new" you didn't mean to hit costs you nothing - the session is
// in the files tab under "work in progress", ready to load and, if it turned out good, keep
// under a real name. Blanking the buffer deletes the file (see the wip/save route).
// ---------------------------------------------------------------------------------------------

// "2026-08/2026-08-02-143205" - the month folder plus a session stamp, which is also the file's
// path under wip/. `after` forces a later stamp, so rolling twice in one second can't collide.
function newWipSessionId(after = '') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = () => {
    const month = `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    return `${month}/${month}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  let id = stamp();
  while (id <= after) {
    d.setSeconds(d.getSeconds() + 1);
    id = stamp();
  }
  return id;
}

let wipSessionId = newWipSessionId();
let wipTimer = null;
let wipLastSent = null;
let wipWarned = false;

function scheduleWipSave() {
  clearTimeout(wipTimer);
  wipTimer = setTimeout(saveWip, 1200);
}

// The row this session would show as in the files tab. Autosaving fires every second or so and
// almost never changes what the list *says* - so compare this and re-render only when it does
// (a session's first write, a new @title, a renamed first block, an emptied buffer), which is
// what makes a brand new session appear the moment it lands on disk.
function wipRowKey(code) {
  if (!code.trim()) return `${wipSessionId}\n(gone)`;
  const label = displayLabel({ title: parseMeta(code).title, code, borrowBlockLabel: true });
  return `${wipSessionId}\n${label}`;
}

let wipListedRow = null;

async function saveWip() {
  clearTimeout(wipTimer);
  const code = cm.getValue();
  const id = wipSessionId;
  if (code === wipLastSent) return;
  wipLastSent = code;
  try {
    await api('POST', '/api/patterns/wip/save', { id, code });
    const row = wipRowKey(code);
    if (row !== wipListedRow) {
      wipListedRow = row;
      if (!filesTab.classList.contains('hidden')) refreshPatternFiles();
    }
  } catch (e) {
    if (id === wipSessionId) wipLastSent = null; // let the next keystroke retry
    if (!wipWarned) {
      wipWarned = true; // once per session - this must never nag over a performance
      logLine(`autosave failed (${e.message ?? e}) - your work isn't being written to disk`, true);
    }
  }
}

// Leaving the current buffer behind (＋ new, or loading another pattern): flush it, then start a
// new session file. Without the roll, clearing the editor would blank - and so delete - the very
// file that was holding the work.
async function rollWipSession() {
  // The buffer is about to be replaced, so this is the last chance for a held plugin edit to
  // reach the session file it belongs to.
  await settlePluginState();
  await saveWip();
  wipSessionId = newWipSessionId(wipSessionId);
  wipLastSent = null;
  wipListedRow = null; // the next write is a new session's first - always worth showing
  markCurrentFileRow(); // the session that was the live one no longer is
}

// Closing the tab inside the debounce window would otherwise lose the last seconds of typing.
// sendBeacon survives teardown, which fetch() does not.
window.addEventListener('pagehide', () => {
  const code = cm.getValue();
  if (code === wipLastSent) return;
  const body = new Blob([JSON.stringify({ id: wipSessionId, code })], { type: 'application/json' });
  navigator.sendBeacon('/api/patterns/wip/save', body);
});

// ---------------------------------------------------------------------------------------------
// Muted-code dimming: blocks that won't play - muted (`_name:`) or not soloed while another
// block is (`Sname:`) - render in the comment color, no syntax highlighting, so what's actually
// sounding is obvious at a glance. Recomputed straight from the buffer text on every edit
// (mute/solo are just label spellings), no eval needed. Explicit `//` comments already get the
// same treatment from the syntax mode itself.
// ---------------------------------------------------------------------------------------------

let mutedDimTimer = null;
let mutedDimMarks = [];

function updateMutedDim() {
  if (!labelsMod) return;
  for (const mk of mutedDimMarks) mk.clear();
  mutedDimMarks = [];
  const blocks = labelsMod.splitLabeledBlocks(cm.getValue());
  const anySolo = blocks.some((b) => b.soloed && !b.muted);
  for (const b of blocks) {
    if (!b.muted && !(anySolo && !b.soloed)) continue;
    mutedDimMarks.push(
      cm.markText(cm.posFromIndex(b.start), cm.posFromIndex(b.end), { className: 'cm-muted-code' }),
    );
  }
}

// Rank case-insensitively: prefix matches first, then substring matches, alphabetical within
// each group. Used for params and plugin names alike.
function rankedMatches(names, typed, limit) {
  const q = typed.toLowerCase();
  const starts = [];
  const contains = [];
  for (const item of names) {
    const idx = item.key.toLowerCase().indexOf(q);
    if (idx === 0) starts.push(item);
    else if (idx > 0) contains.push(item);
  }
  return [...starts, ...contains].slice(0, limit);
}

function hintResult(cur, typed, completions) {
  return {
    list: completions,
    from: CodeMirror.Pos(cur.line, cur.ch - typed.length),
    to: cur,
  };
}

// Which labeled block is the cursor inside? Scopes `.param(` autocomplete to that block's
// track chain. Falls back to a whole-buffer view if the label splitter isn't loaded yet.
function blockAtCursor() {
  if (!labelsMod) return null;
  const idx = cm.indexFromPos(cm.getCursor());
  const blocks = labelsMod.splitLabeledBlocks(cm.getValue());
  return blocks.find((b) => idx >= b.start && idx <= b.end) ?? null;
}

// Give each parameter its address string - the plain name, or "Name#index" when the plugin
// reuses that name (Diva's three "Frequency"), so completing/copying it targets the exact one.
// Duplicate detection is per param list (a name collides only within its own plugin).
function withParamAddrs(params) {
  const counts = new Map();
  for (const p of params) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return params.map((p) => ({ ...p, addr: counts.get(p.name) > 1 ? `${p.name}#${p.index}` : p.name }));
}

function paramHints(cur, typed, textBefore) {
  // A `.param(` call targets whatever is last in the chain at that point of the method chain:
  // slot 0 (the instrument) before any .fx(), then slot 1, 2, … after each. Count `.fx(`
  // occurrences between the block start and the cursor to mirror that rule.
  const block = blockAtCursor();
  const sinceBlockStart = block ? textBefore.slice(block.start) : textBefore;
  const slot = (sinceBlockStart.match(/\.fx\s*\(/g) ?? []).length;
  const entry =
    (block && chainSlots.find((s) => s.track === block.label && s.slot === slot)) ??
    chainSlots.find((s) => s.slot === slot);
  // Fall back to every loaded plugin's params (tagged by plugin) if the slot isn't loaded yet.
  const pool = entry?.params?.length
    ? withParamAddrs(entry.params).map((p) => ({ key: p.addr, param: p }))
    : chainSlots.flatMap((s) => withParamAddrs(s.params).map((p) => ({ key: p.addr, param: p, plugin: s.plugin })));
  const completions = rankedMatches(pool, typed, 80).map((item) => ({
    text: item.param.addr,
    displayText:
      item.param.addr +
      (item.param.label ? ` · ${item.param.label}` : '') +
      (item.plugin ? `  (${item.plugin})` : ''),
  }));
  return hintResult(cur, typed, completions);
}

function pluginHints(cur, typed) {
  const pool = knownPlugins.map((p) => ({ key: p.name, plugin: p }));
  const completions = rankedMatches(pool, typed, 40).map((item) => ({
    text: item.plugin.name,
    displayText: `${item.plugin.name}  (${item.plugin.format}${item.plugin.isInstrument ? ', instrument' : ''})`,
  }));
  return hintResult(cur, typed, completions);
}

// Connected MIDI device names for the device string of midicc("/midikeys(". Fetched lazily on
// first use (the request also switches on MIDI input engine-side, which typing a MIDI builder
// implies anyway) - the first popup awaits the fetch (show-hint accepts a promise), later ones
// use the cache and refresh it in the background.
let midiDevices = null;

async function fetchMidiDevices() {
  const firstFetch = midiDevices == null;
  try {
    midiDevices = await api('GET', '/api/midiDevices');
    if (firstFetch && midiDevices.length === 0) {
      logLine('midikeys/midicc: engine reports no MIDI sources - they are scanned once at engine start, so restart poptart after plugging a device in', true);
    }
  } catch (err) {
    if (firstFetch) logLine(`midikeys/midicc: device list unavailable (${err.message})`, true);
    midiDevices = midiDevices ?? []; // engine not up yet - background refreshes will self-heal
  }
  return midiDevices;
}

function midiDeviceHints(cur, typed) {
  const toResult = (devices) => {
    const pool = devices.map((d) => ({ key: d }));
    let matches = rankedMatches(pool, typed, 24);
    // The string must name a real connected device, so when what's typed matches nothing the
    // most useful popup is the full list ("here's what IS connected"), not silence.
    if (matches.length === 0) matches = pool.slice(0, 24);
    return hintResult(cur, typed, matches.map((item) => ({ text: item.key })));
  };
  if (midiDevices) {
    fetchMidiDevices();
    return toResult(midiDevices);
  }
  return fetchMidiDevices().then(toResult);
}

// Addressable audio inputs for the device string of input(". Deliberately the booted device's
// LAYOUT rather than every input device on the system: SuperCollider opens one device, so a name
// only resolves if its channels are part of that one (see the settings tab's extra inputs). Same
// lazy-fetch-then-cache shape as the MIDI device list above.
let audioInputs = null;

async function fetchAudioInputs() {
  const firstFetch = audioInputs == null;
  try {
    const { layout } = await api('GET', '/api/audioInputs');
    audioInputs = layout ?? [];
    if (firstFetch && audioInputs.length === 0) {
      logLine('input(): the current audio device exposes no inputs - pick an input-capable device in settings', true);
    }
  } catch (err) {
    if (firstFetch) logLine(`input(): audio input list unavailable (${err.message})`, true);
    audioInputs = audioInputs ?? []; // engine not up yet - background refreshes will self-heal
  }
  return audioInputs;
}

function audioInputHints(cur, typed) {
  const toResult = (layout) => {
    // The running offsets here are the same arithmetic the server resolves with, so the popup
    // shows exactly which channel numbers each name makes available.
    let offset = 0;
    const pool = layout.map((d) => {
      const first = offset + 1;
      offset += d.inChannels;
      return { key: d.name, range: d.inChannels === 1 ? `ch ${first}` : `ch ${first}–${offset}` };
    });
    let matches = rankedMatches(pool, typed, 24);
    // The string must name a device that's actually there, so when nothing matches the useful
    // popup is the full list rather than silence.
    if (matches.length === 0) matches = pool.slice(0, 24);
    return hintResult(cur, typed, matches.map((item) => ({
      text: item.key,
      displayText: `${item.key} · ${item.range}`,
    })));
  };
  if (audioInputs) {
    fetchAudioInputs();
    return toResult(audioInputs);
  }
  return fetchAudioInputs().then(toResult);
}

// Exact sample files for se(". Completes a folder at a time - pick a folder, the popup then lists
// what's inside it - which is what keeps a deep library navigable from the keyboard. Each listing
// is fetched once and cached; the sample root doesn't change under a session (changing it in
// settings reloads the page).
const sampleDirCache = new Map(); // root-relative dir -> { dirs, files }

async function fetchSampleDir(dir) {
  if (sampleDirCache.has(dir)) return sampleDirCache.get(dir);
  let listing;
  try {
    listing = await api('GET', `/api/sampleFiles?dir=${encodeURIComponent(dir)}`);
  } catch {
    listing = { dirs: [], files: [] }; // missing folder / engine down - popup just stays empty
  }
  sampleDirCache.set(dir, listing);
  return listing;
}

function sampleFileHints(cur, typed) {
  // The reference is written inside single quotes because a path holds characters mini-notation
  // reads as operators ("/" is slow). Completions supply the quotes, so the user never has to
  // remember them - they just type the name.
  const body = typed.startsWith("'") ? typed.slice(1) : typed;
  const cut = body.lastIndexOf('/');
  const dir = cut < 0 ? '' : body.slice(0, cut);
  const partial = cut < 0 ? body : body.slice(cut + 1);
  return fetchSampleDir(dir).then((listing) => {
    const pool = [
      ...(listing.dirs ?? []).map((d) => ({ key: d, isDir: true })),
      ...(listing.files ?? []).map((f) => ({ key: f, isDir: false })),
    ];
    let matches = rankedMatches(pool, partial, 40);
    // The path has to name something real, so when nothing matches the useful popup is the
    // folder's whole contents rather than silence.
    if (matches.length === 0) matches = pool.slice(0, 40);
    return hintResult(cur, typed, matches.map((item) => {
      const full = dir ? `${dir}/${item.key}` : item.key;
      // A folder completes to itself plus a "/" so the next popup lists inside it; a file
      // completes to the finished, quoted reference.
      return {
        text: item.isDir ? `'${full}/` : `'${full}'`,
        displayText: item.isDir ? `${item.key}/` : item.key,
      };
    }));
  });
}

// Recording names for sr(". A flat list on purpose - names are minted unique across every month
// folder, so the name IS the address (see osc-engine/recordings.js).
let recordingList = null;

async function fetchRecordings() {
  try {
    const { items } = await api('GET', '/api/recordings');
    recordingList = items ?? [];
  } catch {
    recordingList = recordingList ?? []; // engine/server hiccup - background refreshes self-heal
  }
  return recordingList;
}

function recordingHints(cur, typed) {
  const toResult = (items) => {
    const pool = items.map((r) => ({ key: r.name, month: r.month }));
    let matches = rankedMatches(pool, typed, 40);
    if (matches.length === 0) matches = pool.slice(0, 40);
    return hintResult(cur, typed, matches.map((item) => ({
      text: item.key,
      displayText: `${item.key}  (${item.month})`,
    })));
  };
  if (recordingList) {
    fetchRecordings(); // refresh in the background - a bounce made this session should show up
    return toResult(recordingList);
  }
  return fetchRecordings().then(toResult);
}

function wordHints(cur, typed, words, context) {
  const pool = words.map((w) => ({ key: w }));
  const completions = rankedMatches(pool, typed, 24).map((item) => {
    const doc = lookupDoc(item.key, context);
    // A value (macro1..8) completes bare; everything else is a call, so type its paren too.
    const text = doc && doc.call === false ? item.key : `${item.key}(`;
    return { text, displayText: text, doc, render: doc ? renderHintRow : undefined };
  });
  return hintResult(cur, typed, completions);
}

// One completion row: name and signature only. The description belongs to the doc panel beside
// the list - repeating it here just widens the popup, and at high zoom the two end up stacked.
function renderHintRow(el, data, completion) {
  const { name, display } = completion.doc;
  const nameEl = document.createElement('span');
  nameEl.className = 'hint-name';
  nameEl.textContent = name;
  el.appendChild(nameEl);
  const args = display.slice(display.indexOf(name) + name.length); // "(factor)", or "" for a value
  if (args) {
    const argsEl = document.createElement('span');
    argsEl.className = 'hint-args';
    argsEl.textContent = args;
    el.appendChild(argsEl);
  }
}

function poptartHint(cm) {
  const cur = cm.getCursor();
  const before = cm.getRange(CodeMirror.Pos(0, 0), cur);

  // Inside the name string of .param(" → real VST parameter names.
  let m = before.match(/\.param\s*\(\s*["']([^"']*)$/);
  if (m) return paramHints(cur, m[1], before);

  // Inside the name string of synth(" or .fx(" → scanned plugin names. \b instead of a literal
  // dot: chains can *start* with synth(...), so the call isn't always in method position.
  m = before.match(/\b(?:synth|fx)\s*\(\s*["']([^"']*)$/);
  if (m) return pluginHints(cur, m[1]);

  // Inside the device string of midicc(" or midikeys(" → connected MIDI device names.
  m = before.match(/\b(?:midicc|midikeys)\s*\(\s*["']([^"']*)$/);
  if (m) return midiDeviceHints(cur, m[1]);

  // Inside the device string of input(" → the audio inputs the booted device actually exposes.
  m = before.match(/\binput\s*\(\s*["']([^"']*)$/);
  if (m) return audioInputHints(cur, m[1]);

  // Inside se(" → sample files, a folder at a time. The typed text may already carry the opening
  // single quote a path needs, so it's captured too and the completion replaces the lot.
  m = before.match(/(?<![.\w$])se\s*\(\s*"('?[^"]*)$/);
  if (m) return sampleFileHints(cur, m[1]);

  // Inside sr(" → recording names.
  m = before.match(/(?<![.\w$])sr\s*\(\s*["']([^"']*)$/);
  if (m) return recordingHints(cur, m[1]);

  // After a dot → chain methods; bare word → top-level builders. A dot straight after a digit is
  // the decimal point of a number being typed (`begin(0.3`), not a chain - offering the whole
  // method list there pops a menu over every float you type.
  m = before.match(/(\d?)\.([A-Za-z_]*)$/);
  if (m && !m[1]) return wordHints(cur, m[2], METHODS, 'method');
  m = before.match(/(?:^|[^.\w"'])([A-Za-z_]+)$/);
  if (m) return wordHints(cur, m[1], BUILDERS, 'builder');

  return { list: [], from: cur, to: cur };
}

// Auto-open the hint popup while typing (quotes/parens/word chars, plus spaces so multi-word
// param names like "Filter 1 Freq" keep the popup alive).
cm.on('inputRead', (cm, change) => {
  if (cm.state.completionActive) return;
  const typedChar = change.text[change.text.length - 1].slice(-1);
  if (/[\w"'( ]/.test(typedChar)) {
    showPoptartHint();
  }
});

// ---------------------------------------------------------------------------------------------
// Documentation tooltips - the same api-docs.js entries in two places: a panel beside the
// autocomplete popup describing whichever completion is selected, and a ctrl-hover tooltip over
// any documented name already in the buffer. Both off together via the settings toggle.
// ---------------------------------------------------------------------------------------------

const DOC_TOOLTIPS_KEY = 'poptart-doc-tooltips';
let docTooltipsEnabled = localStorage.getItem(DOC_TOOLTIPS_KEY) !== '0'; // default on

function setDocTooltips(on) {
  docTooltipsEnabled = on;
  localStorage.setItem(DOC_TOOLTIPS_KEY, on ? '1' : '0');
  if (!on) {
    hideHintDoc();
    hideHoverDoc();
  }
}

// Signature / description / example, the shared body of both boxes.
function renderDocBox(el, doc) {
  el.innerHTML = '';
  const sig = document.createElement('div');
  sig.className = 'doc-sig';
  sig.textContent = doc.display;
  const desc = document.createElement('div');
  desc.className = 'doc-desc';
  desc.textContent = doc.desc;
  el.append(sig, desc);
  if (doc.eg) {
    const eg = document.createElement('div');
    eg.className = 'doc-eg';
    eg.textContent = doc.eg;
    el.appendChild(eg);
  }
}

function makeDocBox(className) {
  const el = document.createElement('div');
  el.className = `doc-box ${className}`;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

// --- the panel beside the completion popup ---

let hintDocEl = null;

function hideHintDoc() {
  if (hintDocEl) hintDocEl.style.display = 'none';
}

// Park the panel next to the hint list, flipping to its left when the window runs out. When the
// window is zoomed far enough that neither side fits the panel at full width, narrow it into the
// roomier side instead of letting it land on top of the list.
function showHintDoc(doc, listEl) {
  if (!hintDocEl) hintDocEl = makeDocBox('doc-box-hint');
  renderDocBox(hintDocEl, doc);
  hintDocEl.style.display = 'block';
  hintDocEl.style.left = '0px'; // measure at a known position before deciding where it goes
  hintDocEl.style.top = '0px';
  hintDocEl.style.maxWidth = '';
  const list = listEl.getBoundingClientRect();
  const gap = 6;
  const roomRight = window.innerWidth - 4 - (list.right + gap);
  const roomLeft = list.left - gap - 4;
  let left;
  const width = hintDocEl.getBoundingClientRect().width;
  if (width <= roomRight) left = list.right + gap;
  else if (width <= roomLeft) left = list.left - gap - width;
  else {
    const squeezed = Math.max(140, Math.max(roomRight, roomLeft));
    hintDocEl.style.maxWidth = `${squeezed}px`;
    left = roomRight >= roomLeft ? list.right + gap : list.left - gap - squeezed;
  }
  const height = hintDocEl.getBoundingClientRect().height; // re-measure: narrowing made it taller
  hintDocEl.style.left = `${Math.max(4, left)}px`;
  hintDocEl.style.top = `${Math.max(4, Math.min(list.top, window.innerHeight - height - 4))}px`;
}

// Wrap a hint source so whichever completion is highlighted shows its docs. Completions without
// a `doc` (param names, plugins, MIDI devices) just leave the panel closed.
function withDocPanel(hintFn) {
  return (...args) => {
    const result = hintFn(...args);
    const attach = (res) => {
      if (!res || !res.list) return res;
      CodeMirror.on(res, 'select', (completion, node) => {
        if (docTooltipsEnabled && completion && completion.doc) showHintDoc(completion.doc, node.parentNode);
        else hideHintDoc();
      });
      CodeMirror.on(res, 'close', hideHintDoc);
      // show-hint only signals "close" when a list is on screen: if the next keystroke narrows the
      // list to nothing it drops the popup silently, and the panel would hang around describing a
      // completion that is no longer offered. "update" fires on the outgoing result either way, and
      // the replacement's "select" re-shows the panel in the same frame, so there's no flicker.
      CodeMirror.on(res, 'update', hideHintDoc);
      return res;
    };
    return result && typeof result.then === 'function' ? result.then(attach) : attach(result);
  };
}

function showPoptartHint() {
  cm.showHint({ hint: withDocPanel(poptartHint), completeSingle: false });
}

// Backstop for the same asymmetry: a completion session that already lost its popup closes without
// signalling its result, so hang the panel's last word on the editor-level event instead.
cm.on('endCompletion', hideHintDoc);

// --- ctrl-hover over a name in the buffer ---

let hoverDocEl = null;
let hoverDocKey = null; // the token the tooltip is currently showing, so a jiggle doesn't rerender

function hideHoverDoc() {
  if (hoverDocEl) hoverDocEl.style.display = 'none';
  hoverDocKey = null;
}

function showHoverDoc(doc, key, tokenBox) {
  if (!hoverDocEl) hoverDocEl = makeDocBox('doc-box-hover');
  // Already open on this very token - moving the pointer within it shouldn't re-measure anything.
  if (hoverDocKey === key && hoverDocEl.style.display === 'block') return;
  renderDocBox(hoverDocEl, doc);
  hoverDocKey = key;
  hoverDocEl.style.display = 'block';
  hoverDocEl.style.left = '0px';
  hoverDocEl.style.top = '0px';
  const box = hoverDocEl.getBoundingClientRect();
  const left = Math.min(tokenBox.left, window.innerWidth - box.width - 4);
  // Below the token by default; above it when the tooltip would fall off the bottom.
  const below = tokenBox.bottom + 6;
  const top = below + box.height <= window.innerHeight - 4 ? below : Math.max(4, tokenBox.top - 6 - box.height);
  hoverDocEl.style.left = `${Math.max(4, left)}px`;
  hoverDocEl.style.top = `${top}px`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

// The documented name under the pointer, if any. CodeMirror's coordsChar snaps to the nearest
// character, so the pointer is checked against the token's own box before we call it a hover.
function docAtCoords(clientX, clientY) {
  const pos = cm.coordsChar({ left: clientX, top: clientY }, 'window');
  const line = cm.getLine(pos.line);
  if (line == null) return null;
  let token = cm.getTokenAt(pos, true);
  // getTokenAt returns the token ENDING at pos, so on the left edge of a name we get whatever
  // precedes it (the dot, a space) - look one character right before giving up.
  if ((!token || !IDENTIFIER_RE.test(token.string)) && pos.ch < line.length) {
    token = cm.getTokenAt(CodeMirror.Pos(pos.line, pos.ch + 1), true);
  }
  if (!token || !IDENTIFIER_RE.test(token.string)) return null;
  const startBox = cm.charCoords(CodeMirror.Pos(pos.line, token.start), 'window');
  const endBox = cm.charCoords(CodeMirror.Pos(pos.line, token.end), 'window');
  if (clientY < startBox.top || clientY > startBox.bottom) return null;
  if (clientX < startBox.left || clientX > endBox.left) return null;
  const context = /\.\s*$/.test(line.slice(0, token.start)) ? 'method' : 'builder';
  const doc = lookupDoc(token.string, context);
  return doc ? { doc, key: `${token.string}:${context}`, box: startBox } : null;
}

const editorWrapper = cm.getWrapperElement();
let lastHoverPoint = null; // so holding ctrl without moving the mouse still opens the tooltip

function updateHoverDoc(point, ctrlHeld) {
  lastHoverPoint = point;
  if (!point || !ctrlHeld || !docTooltipsEnabled || cm.state.completionActive) {
    hideHoverDoc();
    return;
  }
  const hit = docAtCoords(point.x, point.y);
  if (!hit) hideHoverDoc();
  else showHoverDoc(hit.doc, hit.key, hit.box);
}

editorWrapper.addEventListener('mousemove', (e) => updateHoverDoc({ x: e.clientX, y: e.clientY }, e.ctrlKey));
editorWrapper.addEventListener('mouseleave', () => updateHoverDoc(null, false));
// Ctrl pressed with the pointer already parked over a name, and released again.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control') updateHoverDoc(lastHoverPoint, true);
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || !e.ctrlKey) hideHoverDoc();
});
cm.on('scroll', hideHoverDoc); // the code moved out from under the pointer

// ---------------------------------------------------------------------------------------------
// Widget handles - DOUBLE-CLICK a call's name to open its editor.
//
// `lfo`, `pianoroll`, `record`, `synth` and `fx` all work the same way: the NAME is a handle, and
// double-clicking it opens that call's editor (the plugin's own window, for synth/fx). A single
// click - or the text cursor merely landing on the name while you edit - deliberately does
// nothing. Those happen all day by accident, and a panel that opens on its own takes the screen
// and, for the roll, the keyboard, right in the middle of a line you were typing. Nothing but the
// name is a handle either way: the arguments are ordinary code, so double-clicking a word inside
// them still selects the word.
//
// This hangs off CodeMirror's `mousedown` rather than its `dblclick` because only mousedown fires
// early enough to preventDefault the word-selection the second click would otherwise make.
// ---------------------------------------------------------------------------------------------

function initWidgetHandles() {
  cm.on('mousedown', (_cm, e) => {
    if (e.detail !== 2 || e.button !== 0) return;
    const idx = cm.indexFromPos(cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
    if (openWidgetAt(cm.getValue(), idx)) e.preventDefault(); // the double-click WAS the gesture
  });
}

/** Opens whichever editor `idx` is the handle for. True if one of them took it. */
function openWidgetAt(code, idx) {
  const lfo = shapeMod && findLfoCallAt(code, idx);
  if (lfo?.onName) {
    if (!lfoState || lfo.start !== lfoState.callStart) openLfoEditor(lfo);
    return true;
  }
  const roll = pianorollMod && findPianorollCallAt(code, idx);
  if (roll?.onName) {
    if (!prState || roll.start !== prState.callStart) openPianorollEditor(roll);
    // Opening the roll on purpose hands it the keyboard: cmd-A, the arrows and delete belong to
    // the notes now, not to the code buffer.
    prCanvas.focus({ preventScroll: true });
    return true;
  }
  const rec = findRecordCallAt(code, idx);
  if (rec?.onName) {
    if (!recordState || rec.start !== recordState.callStart) openRecordPanel(rec);
    return true;
  }
  const chain = findChainHandleAt(code, idx);
  if (chain) {
    showPluginEditor(chain.label, chain.slot);
    return true;
  }
  return false;
}

/**
 * The `name(...)` call containing idx, plus whether idx is on its name - the handle. `re` must be
 * a /g regex matching the name and its opening paren; `name` is the word inside it that counts as
 * the handle (`.record(` matches with a leading dot, but only `record` is the handle).
 */
function findNamedCallAt(code, idx, re, name) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    if (idx < m.index || idx > close + 1) continue;
    const nameStart = m.index + m[0].indexOf(name);
    return { start: m.index, open, close, onName: idx >= nameStart && idx <= nameStart + name.length };
  }
  return null;
}

/**
 * The synth(...) / .fx(...) call whose name `idx` sits on, as the { label, slot } pair that
 * addresses one plugin - exactly what the track panel's `ui` button sends. Slot 0 is the
 * instrument; .fx() calls number from 1 in the order they appear, which is how a chain is
 * addressed everywhere else (see findChainCall).
 */
function findChainHandleAt(code, idx) {
  if (!labelsMod) return null;
  const block = labelsMod.splitLabeledBlocks(code).find((b) => idx >= b.start && idx <= b.end);
  if (!block) return null;
  const re = /\b(synth|fx)\s*\(/g;
  re.lastIndex = block.start;
  const isCode = codeOnly(code);
  let m;
  let fxSeen = 0;
  while ((m = re.exec(code)) && m.index < block.end) {
    if (!isCode(m.index)) continue; // commented-out calls aren't in the chain, so they hold no slot
    const slot = m[1] === 'synth' ? 0 : ++fxSeen;
    if (idx >= m.index && idx <= m.index + m[1].length) return { label: block.label, slot };
  }
  return null;
}

/** Open a plugin's own editor window - the engine owns it, so this is a request, not a panel. */
function showPluginEditor(trackId, slot) {
  api('POST', '/api/showEditor', { trackId, slot }).catch((e) => logLine(e.message, true));
}

// ---------------------------------------------------------------------------------------------
// Interactive LFO shape editor - double-click the `lfo` name in any `lfo(...)` call (just the
// name: its arguments are code you may want to edit by hand) and a Serum-style panel opens: drag
// breakpoints, drag a segment to bend it (curvature), double-click to add/remove points, pick
// presets, set rate + free/retrigger/envelope mode. Every change is serialized back into the code as
// `lfo("x,y,c …", { rate, mode })` and re-evaluated (debounced), so the modulation follows the
// shape without a manual ⏎; hand edits to the call flow the other way, back into the open panel.
// The code stays the single source of truth (and shares via the URL hash like everything else).
// ---------------------------------------------------------------------------------------------

const lfoPanel = document.getElementById('lfoPanel');
const lfoCanvas = document.getElementById('lfoCanvas');
const lfoPreset = document.getElementById('lfoPreset');
const lfoRandom = document.getElementById('lfoRandom');
const lfoCloseBtn = document.getElementById('lfoClose');
const lfoRate = document.getElementById('lfoRate');
const lfoMode = document.getElementById('lfoMode');

let lfoState = null; // { marker, callStart, points, rate, mode }
let lfoSuppressCursor = false;
const LFO_EVAL_DEBOUNCE_MS = 150; // quiet time after the last shape edit before it re-evaluates

// The lfo(...) call containing idx, plus whether idx is on the *handle* that opens the editor -
// the `lfo` name itself. Its arguments - the shape string, rate:, mode: - are ordinary code you may
// want to edit by hand, so they are never a handle. Same rule as pianoroll's and record's.
function findLfoCallAt(code, idx) {
  return findNamedCallAt(code, idx, /\blfo\s*\(/g, 'lfo');
}

function parseLfoCall(inner) {
  const shapeMatch = /(["'])((?:\\.|(?!\1).)*?)\1/.exec(inner);
  const rate = Number((/rate\s*:\s*([\d.]+)/.exec(inner) ?? [])[1] ?? 1) || 1;
  const mode = (/mode\s*:\s*["'](\w+)["']/.exec(inner) ?? [])[1] ?? 'free';
  let points = null;
  try {
    if (shapeMatch?.[2]?.trim()) points = shapeMod.parseShapePoints(shapeMatch[2]);
  } catch {
    // unparseable shape string - fall back to the default below
  }
  if (!points) points = shapeMod.parseShapePoints('0,0 0.5,1 1,0');
  return { points, rate, mode: ['free', 'retrigger', 'envelope'].includes(mode) ? mode : 'free' };
}

function serializeLfoCall({ points, rate, mode }) {
  const cfg = mode === 'free' ? `{ rate: ${rate} }` : `{ rate: ${rate}, mode: '${mode}' }`;
  return `lfo("${shapeMod.serializeShapePoints(points)}", ${cfg})`;
}

function openLfoEditor(call) {
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (lfoState?.marker) lfoState.marker.clear();
  lfoState = { marker: cm.markText(from, to, {}), callStart: call.start, ...parseLfoCall(inner) };
  lfoRate.value = lfoState.rate;
  lfoMode.value = lfoState.mode;
  lfoPreset.value = '';
  lfoPanel.classList.remove('hidden');
  drawLfoShape();
}

function closeLfoEditor() {
  if (lfoState?.marker) lfoState.marker.clear();
  lfoState = null;
  lfoPanel.classList.add('hidden');
}

function writeLfoCall() {
  if (!lfoState) return;
  const range = lfoState.marker.find();
  if (!range) return;
  const text = serializeLfoCall(lfoState);
  lfoSuppressCursor = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    // replaceRange collapses the marker - re-pin it over the fresh text
    lfoState.marker.clear();
    const startIdx = cm.indexFromPos(range.from);
    lfoState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    lfoState.callStart = startIdx;
  } finally {
    lfoSuppressCursor = false; // never leave it latched: that would wedge the panel shut for good
  }
  lfoScheduleEval();
}

// A shape edit isn't finished until it *sounds*, so every write re-evaluates the buffer - debounced,
// so dragging a breakpoint costs one request, not one per pointerup. evaluate(false) is the "update"
// path: a stopped clock stays stopped, a running one keeps running with the new modulation.
let lfoEvalTimer = null;
function lfoScheduleEval() {
  clearTimeout(lfoEvalTimer);
  lfoEvalTimer = setTimeout(() => { lfoEvalTimer = null; evaluate(false); }, LFO_EVAL_DEBOUNCE_MS);
}

// The reverse direction: the panel re-reads the call whenever it's edited by hand, so tweaking
// `rate:`/`mode:`/the shape string in the code updates the panel instead of being silently reverted
// by the next drag.
function syncLfoFromCode() {
  if (!lfoState || lfoSuppressCursor || !shapeMod) return;
  const range = lfoState.marker.find();
  // The call the panel is anchored to was deleted (or typed into something that is no longer an
  // lfo call) - there is nothing left to edit, so the panel goes with it. This is the only thing
  // that closes it by itself now that opening is an explicit double-click.
  if (!range) { closeLfoEditor(); return; }
  const text = cm.getRange(range.from, range.to);
  if (!/^\s*lfo\s*\(/.test(text)) { closeLfoEditor(); return; }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const parsed = parseLfoCall(text.slice(open + 1, close));
  lfoState.callStart = cm.indexFromPos(range.from);
  lfoState.points = parsed.points;
  lfoState.rate = parsed.rate;
  lfoState.mode = parsed.mode;
  lfoRate.value = parsed.rate;
  lfoMode.value = parsed.mode;
  drawLfoShape();
}

function initLfoEditor() {
  for (const name of Object.keys(shapeMod.SHAPE_PRESETS)) lfoPreset.add(new Option(name, name));

  // Opening is initWidgetHandles' job (double-click the name). Closing is the ✕, Escape, or the
  // call itself leaving the buffer - see syncLfoFromCode. Nothing about where the text cursor
  // happens to be: a panel you asked for stays put while you edit around it.
  cm.on('change', syncLfoFromCode); // hand edits to the open call flow back into the panel

  lfoPreset.addEventListener('change', () => {
    if (!lfoState || !lfoPreset.value) return;
    lfoState.points = shapeMod.parseShapePoints(shapeMod.SHAPE_PRESETS[lfoPreset.value]);
    writeLfoCall();
    drawLfoShape();
  });
  lfoRandom.addEventListener('click', () => {
    if (!lfoState) return;
    const count = 3 + Math.floor(Math.random() * 5);
    const xs = [0, 1, ...Array.from({ length: count }, () => Math.random())].sort((a, b) => a - b);
    lfoState.points = xs.map((x) => ({
      x,
      y: Math.round(Math.random() * 100) / 100,
      c: Math.random() < 0.4 ? Math.round((Math.random() * 8 - 4) * 10) / 10 : 0,
    }));
    lfoPreset.value = '';
    writeLfoCall();
    drawLfoShape();
  });
  lfoRate.addEventListener('change', () => {
    if (!lfoState) return;
    lfoState.rate = Math.max(0.01, Number(lfoRate.value) || 1);
    writeLfoCall();
  });
  lfoMode.addEventListener('change', () => {
    if (!lfoState) return;
    lfoState.mode = lfoMode.value;
    writeLfoCall();
  });
  lfoCloseBtn.addEventListener('click', () => closeLfoEditor());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lfoState) closeLfoEditor();
  });

  initLfoCanvas();
}

// --- canvas: draw + interactions ---

const LFO_PAD = 10;

function lfoToCanvas(p) {
  const w = lfoCanvas.width - 2 * LFO_PAD;
  const h = lfoCanvas.height - 2 * LFO_PAD;
  return { px: LFO_PAD + p.x * w, py: LFO_PAD + (1 - p.y) * h };
}

function canvasToLfo(px, py) {
  const w = lfoCanvas.width - 2 * LFO_PAD;
  const h = lfoCanvas.height - 2 * LFO_PAD;
  return {
    x: Math.min(1, Math.max(0, (px - LFO_PAD) / w)),
    y: Math.min(1, Math.max(0, 1 - (py - LFO_PAD) / h)),
  };
}

function drawLfoShape() {
  if (!lfoState || !shapeMod) return;
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const ctx = lfoCanvas.getContext('2d');
  const { width: W, height: H } = lfoCanvas;
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = col('--border');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gx = LFO_PAD + ((W - 2 * LFO_PAD) * i) / 4;
    const gy = LFO_PAD + ((H - 2 * LFO_PAD) * i) / 4;
    ctx.beginPath(); ctx.moveTo(gx, LFO_PAD); ctx.lineTo(gx, H - LFO_PAD); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(LFO_PAD, gy); ctx.lineTo(W - LFO_PAD, gy); ctx.stroke();
  }

  ctx.strokeStyle = col('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const { px, py } = lfoToCanvas({ x, y: shapeMod.sampleShape(lfoState.points, x) });
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  for (const p of lfoState.points) {
    const { px, py } = lfoToCanvas(p);
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = col('--bg-panel');
    ctx.fill();
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function initLfoCanvas() {
  let drag = null; // { kind: 'point'|'curve', index }

  const canvasPos = (e) => {
    const r = lfoCanvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const hitPoint = (px, py) => {
    for (let i = 0; i < lfoState.points.length; i++) {
      const c = lfoToCanvas(lfoState.points[i]);
      if (Math.hypot(c.px - px, c.py - py) < 8) return i;
    }
    return null;
  };

  const segmentAt = (px) => {
    const { x } = canvasToLfo(px, 0);
    const pts = lfoState.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (x >= pts[i].x && x <= pts[i + 1].x && pts[i + 1].x > pts[i].x) return i;
    }
    return null;
  };

  lfoCanvas.addEventListener('pointerdown', (e) => {
    if (!lfoState) return;
    lfoCanvas.setPointerCapture(e.pointerId);
    const { px, py } = canvasPos(e);
    const pointIdx = hitPoint(px, py);
    drag = pointIdx != null ? { kind: 'point', index: pointIdx } : { kind: 'curve', index: segmentAt(px) };
  });

  lfoCanvas.addEventListener('pointermove', (e) => {
    if (!drag || !lfoState || drag.index == null) return;
    const { px, py } = canvasPos(e);
    const pts = lfoState.points;
    if (drag.kind === 'point') {
      const i = drag.index;
      const { x, y } = canvasToLfo(px, py);
      const isEnd = i === 0 || i === pts.length - 1;
      pts[i] = {
        ...pts[i],
        // endpoints keep their x (the shape always spans the full period)
        x: isEnd ? pts[i].x : Math.min(pts[i + 1].x, Math.max(pts[i - 1].x, x)),
        y,
      };
    } else {
      // vertical drag bends the segment: push the curve toward the pointer
      const seg = pts[drag.index];
      const rising = pts[drag.index + 1].y >= seg.y;
      const delta = (e.movementY ?? 0) * 0.08 * (rising ? 1 : -1);
      seg.c = Math.max(-12, Math.min(12, (seg.c ?? 0) + delta));
    }
    drawLfoShape();
  });

  lfoCanvas.addEventListener('pointerup', (e) => {
    if (drag && lfoState) writeLfoCall();
    drag = null;
    lfoCanvas.releasePointerCapture(e.pointerId);
  });

  lfoCanvas.addEventListener('dblclick', (e) => {
    if (!lfoState) return;
    const { px, py } = canvasPos(e);
    const pointIdx = hitPoint(px, py);
    const pts = lfoState.points;
    if (pointIdx != null) {
      // delete (endpoints stay - the shape must span the period)
      if (pointIdx > 0 && pointIdx < pts.length - 1) pts.splice(pointIdx, 1);
    } else {
      const { x, y } = canvasToLfo(px, py);
      const at = pts.findIndex((p) => p.x > x);
      pts.splice(at === -1 ? pts.length - 1 : at, 0, { x, y, c: 0 });
    }
    lfoPreset.value = '';
    writeLfoCall();
    drawLfoShape();
  });
}

// ---------------------------------------------------------------------------------------------
// Interactive piano roll editor - double-click the `pianoroll` name in any `pianoroll(...)` call
// (just the name: its arguments are code you may want to edit by hand) and an Ableton-style grid opens
// over the editor, with a real piano keyboard down the left edge and a playhead that sweeps the
// steps as it plays. Two tools (pencil draws, arrow marquee-selects); click a note
// to select it (shift-click extends, ctrl/cmd-A selects all), drag to move, drag a note's right
// edge to resize, cmd-drag vertically to set velocity or probability (the vel/prob toggle), cmd-D
// duplicates, cmd-Z / cmd-shift-Z walk the roll's own undo history. Arrow keys nudge the
// selection (shift-up/down = octave, shift-right/left lengthen/shorten), delete removes
// it, double-click erases one, and 0 mutes it - greyed out and silent, still there to switch back
// on with another 0 (Live's deactivate). A value lane along the bottom shows every note's velocity
// or probability (the vel/prob toggle, also reachable from the lane's own gutter label) as an
// Ableton-style marker - a dot at the onset, a line running right for the duration, dashed for
// probability - which drags up and down, whole selection at once. A note dropped on one already sounding at that pitch keeps its own
// length and the one underneath gives way - cut short, or hidden if it was landed on square - and
// gets everything back the moment the note on top moves away (see prClipOverlaps). Wheel scrolls
// pitch, shift-wheel scrolls time, ctrl-wheel (or cmd ±)
// zooms in on fine grids. Clicking the scale chip snaps every note into the key. Clicking
// anywhere outside the panel closes it - the roll is a tool you reach past to get back to the code.
// With 🎧 on, drawing/dragging previews the note through the track's own
// synth; →♪ rewrites the whole roll as an equivalent mini-notation note("…"). Every change is
// serialized straight back into `pianoroll("midi,start,len[,vel[,prob]] …", { steps })` and
// re-evaluated (debounced), so the track plays what's drawn without a manual ⏎; hand edits to the
// call flow the other way, back into the open panel. The code stays the single source of truth,
// exactly like the lfo() shape editor.
// ---------------------------------------------------------------------------------------------

const prPanel = document.getElementById('pianorollPanel');
const prCanvas = document.getElementById('pianorollCanvas');
const prGridSelect = document.getElementById('pianorollGrid');
const prLenInput = document.getElementById('pianorollLen');
const prToolBtn = document.getElementById('pianorollTool');
const prCmdModeBtn = document.getElementById('pianorollCmdMode');
const prFoldBtn = document.getElementById('pianorollFold');
const prScaleLabel = document.getElementById('pianorollScale');
const prPreviewBtn = document.getElementById('pianorollPreview');
const prToMiniBtn = document.getElementById('pianorollToMini');
const prCloseBtn = document.getElementById('pianorollClose');

const PR_W = 660; // logical canvas size (backing store is scaled by devicePixelRatio for crispness)
const PR_TOPBAR = 16; // loop-ruler strip along the top (drag it to set the loop length)
const PR_GRIDH = 384; // piano-grid height below the ruler
const PR_LANEH = 64; // value lane below the grid (per-note velocity / probability markers)
const PR_CH = PR_TOPBAR + PR_GRIDH + PR_LANEH; // full canvas height
const PR_LANE_PAD = 5; // lane inset above 1.0 / below 0.0, so end-stop markers stay visible
const PR_ROWS = 24; // visible semitone rows (2 octaves)
const PR_GUTTER = 54; // left piano-keyboard gutter, px
const PR_DEFAULT_TOP = 72; // top row when a fresh/empty roll opens (c5 = 60 here, so 72 = c6)
const PR_DEFAULT_VEL = 0.8; // velocity of a freshly drawn note
const PR_EDGE_PX = 6; // right-edge grab zone for resizing
const PR_MAX_ZOOM = 24; // deepest horizontal zoom (cells that many times wider than "fit")
const PR_ZOOM_WHEEL = 0.0012; // wheel-zoom sensitivity (smaller = slower); proportional to deltaY
const PR_PITCH_WHEEL = 0.013; // wheel pitch-scroll sensitivity, rows per deltaY unit (smaller = slower)
const PR_BTN_ZOOM = 1.4; // per-keypress zoom step for cmd ± (the wheel zooms proportionally)
const PR_EVAL_DEBOUNCE_MS = 150; // quiet time after the last roll edit before it re-evaluates
const PR_GRID_DIVS = [['1/4', 4], ['1/8', 8], ['1/8T', 12], ['1/16', 16], ['1/16T', 24], ['1/32', 32], ['1/64', 64]];

// Cursors that echo the tool under the pointer (Ableton's pencil / bracket / up-down), as inline
// SVGs so no asset files are needed. The trailing two numbers are the hotspot.
const svgCursor = (svg, x, y, fallback) => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CUR_PENCIL = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2.5 17.5l1.2-3.2 9-9 2 2-9 9-3.2 1.2z" fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/><path d="M13 4.5l2-2 2 2-2 2z" fill="#7aa2ff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  2, 18, 'crosshair',
);
const CUR_BRACKET = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="20" viewBox="0 0 18 20"><g fill="none" stroke="#111" stroke-width="3"><path d="M5 3H3v14h2"/><path d="M13 3h2v14h-2"/></g><g fill="none" stroke="#fff" stroke-width="1.3"><path d="M5 3H3v14h2"/><path d="M13 3h2v14h-2"/></g></svg>',
  9, 10, 'ew-resize',
);
const CUR_UPDOWN = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 16 22"><g fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"><path d="M8 1l4 5H9v10h3l-4 5-4-5h3V6H4z"/></g></svg>',
  8, 11, 'ns-resize',
);

let prState = null; // see openPianorollEditor for the full shape (notes, steps, pitchTop, zoom, scroll, sel, tool, cmdMode, trackLabel)
let prSuppressCursor = false;
let prPreviewEnabled = localStorage.getItem('poptartPianorollPreview') !== '0';
let prSounding = null; // midi note currently ringing from a preview (so we can note-off it)
let prTool = localStorage.getItem('poptartPianorollTool') === 'select' ? 'select' : 'draw'; // pencil vs arrow
let prCmdMode = localStorage.getItem('poptartPianorollCmd') === 'prob' ? 'prob' : 'vel'; // what cmd-drag sets
let prFold = localStorage.getItem('poptartPianorollFold') === '1'; // fold the roll to the scale's notes
let prRaf = null; // requestAnimationFrame handle for the playhead sweep
let prPlayheadOn = false; // whether the last frame drew a playhead (so we clear it once on stop)
let prPointer = { px: -1, py: -1 }; // last pointer position, for live cursor updates on cmd-key changes
let prRefreshCursor = () => {}; // re-derives the canvas cursor in place (set by initPianorollCanvas)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12)}`;
const isBlackKey = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
const pitchClass = (m) => ((m % 12) + 12) % 12;

// The buffer's key - whatever `setscale(...)` last set, reported by /api/status at load and by
// every evaluate. The roll colours its lanes by it (tonic, in-key, out-of-key) and can fold the
// out-of-key rows away entirely, the way Live's scale-aware piano roll does.
let patchScale = null;

function setPatchScale(name) {
  const next = name ?? null;
  if (next === patchScale) return;
  patchScale = next;
  if (prScaleLabel) prScaleLabel.textContent = patchScale ?? '';
  if (prState) drawPianoroll();
}

// `{ tonic, pcs }` for the global scale - its tonic pitch class and the set of pitch classes in
// it - or null when no scale is set (or its name doesn't parse, which the server already reported
// at the setscale call). Null leaves the roll on its plain black/white lanes.
// Memoized by name: the roll asks for this several times a frame while the playhead sweeps, and
// the answer only changes when setscale() does.
let prScaleCache = { name: null, info: null };

function prScaleInfo() {
  if (!patchScale || !notesMod) return null;
  if (prScaleCache.name !== patchScale) {
    let info = null;
    try {
      const { rootMidi, intervals } = notesMod.parseScaleName(patchScale);
      info = { tonic: pitchClass(rootMidi), pcs: new Set(intervals.map((iv) => pitchClass(rootMidi + iv))) };
    } catch {
      info = null; // the server already reported the bad name at the setscale call
    }
    prScaleCache = { name: patchScale, info };
  }
  return prScaleCache.info;
}

// --- pitch lanes ---
// The roll's vertical axis is a list of LANES rather than raw semitones. Unfolded every semitone
// gets one, so a lane index simply *is* its MIDI note and all the geometry below is unchanged.
// Folded, only the scale's notes get a lane - plus any pitch the roll actually uses, so folding
// can never hide a note you drew (an out-of-key one keeps its dimmed lane, which is exactly the
// signal you want) - and the roll compresses to the key.

/** The lane list, low to high, or null for the identity mapping (lane index === midi). */
function prLaneList() {
  const info = prState.fold ? prScaleInfo() : null;
  if (!info) return null;
  const used = new Set(prLiveNotes(prState.notes).map((nt) => nt.midi));
  const lanes = [];
  for (let midi = 0; midi <= 127; midi++) if (info.pcs.has(pitchClass(midi)) || used.has(midi)) lanes.push(midi);
  return lanes.length ? lanes : null;
}

// Where a pitch sits in the key: 2 = the tonic, 1 = in the scale, 0 = out of it. null when no
// scale is set, which leaves the roll on its plain black/white lanes. Both the grid and the piano
// gutter shade by this, so "in key" is visible as colour and not merely as the absence of dimming.
const prScaleRank = (midi, info) => (!info ? null : pitchClass(midi) === info.tonic ? 2 : info.pcs.has(pitchClass(midi)) ? 1 : 0);

// How strongly the accent tints a lane / a piano key at each rank. The grid stays faint (notes
// have to read on top of it); the keyboard can afford to be bolder, the way Live colours the keys.
const PR_LANE_TINT = [0, 0.07, 0.18]; // out (unused - dimmed instead), in key, tonic
const PR_KEY_TINT = [0, 0.26, 0.62];

/** midi -> lane index. Off-lane pitches (a note mid-drag) resolve to the nearest lane below. */
const prPosOf = (midi, m) => (m.lanes ? m.laneOf[Math.min(127, Math.max(0, Math.round(midi)))] : midi);

/** lane index -> midi, clamped to the ends of the axis. */
const prMidiOf = (pos, m) =>
  m.lanes
    ? m.lanes[Math.min(m.lanes.length - 1, Math.max(0, Math.round(pos)))]
    : Math.min(127, Math.max(0, Math.round(pos)));

// The pianoroll(...) call containing idx, plus whether idx is on the *handle* that opens the
// editor - the `pianoroll` name itself. The arguments - the note string, grid:, len: - are
// ordinary code you may want to edit, so they are never a handle.
function findPianorollCallAt(code, idx) {
  return findNamedCallAt(code, idx, /\bpianoroll\s*\(/g, 'pianoroll');
}

// The label of the block a `pianoroll(...)` call lives in - the engine track we preview through.
function prBlockLabelAt(idx) {
  if (!labelsMod) return null;
  return labelsMod.splitLabeledBlocks(cm.getValue()).find((b) => idx >= b.start && idx <= b.end)?.label ?? null;
}

// --- note preview: play the drawn note through the track's own synth (if the 🎧 toggle is on and
// the track has been evaluated with an instrument). One note at a time; always paired with an off.
function prPreviewSend(note, isOn) {
  if (!prState?.trackLabel) return;
  api('POST', '/api/previewNote', { trackId: prState.trackLabel, note, vel: PR_DEFAULT_VEL, isOn }).catch(() => {});
}
function prPreview(midi) {
  if (!prPreviewEnabled || prSounding === midi) return;
  if (prSounding != null) prPreviewSend(prSounding, false);
  prPreviewSend(midi, true);
  prSounding = midi;
}
function prPreviewOff() {
  if (prSounding == null) return;
  prPreviewSend(prSounding, false);
  prSounding = null;
}
// Audition the top note of a group being dragged or nudged. Muted notes are skipped: one is
// switched off, and moving it around is no reason to hear it.
function prPreviewNotes(notes) {
  const live = notes.filter((n) => !n.mute);
  if (live.length) prPreview(Math.max(...live.map((n) => n.midi)));
}

function parsePianorollCall(inner) {
  const strMatch = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(inner);
  const noteStr = strMatch?.[2] ?? '';
  const int = (re) => { const m = re.exec(inner); return m ? Math.max(1, Math.round(Number(m[1]))) : null; };
  // grid: `grid: N`, the legacy `steps: N`, or a bare-number second arg. len: `len: N`, else a cycle.
  let grid = int(/\bgrid\s*:\s*(\d+)/) ?? int(/\bsteps\s*:\s*(\d+)/);
  if (grid == null) { const bare = /["'`]\s*,\s*(\d+)\s*$/.exec(inner.trim()); if (bare) grid = Math.max(1, Number(bare[1])); }
  if (grid == null) grid = 16;
  const len = int(/\blen\s*:\s*(\d+)/) ?? grid;
  let notes = [];
  try {
    notes = pianorollMod.parsePianoRoll(noteStr);
  } catch {
    // unparseable note string - start from an empty roll
  }
  return { notes, grid, len };
}

// Hidden notes (buried under another - see prClipOverlaps) are left out: the code holds what
// actually sounds, and they are only kept around in the panel so they can come back.
function serializePianorollCall({ notes, grid, len }) {
  return `pianoroll("${pianorollMod.serializePianoRoll(prLiveNotes(notes))}", { grid: ${grid}, len: ${len} })`;
}

// Frame the pitch window so the drawn notes sit centered; default to PR_DEFAULT_TOP for an empty
// roll. Works in lane coordinates, so it frames a folded roll just as well; prMetrics clamps the
// result to the ends of the axis.
function prFramePitch() {
  const m = prMetrics();
  const notes = prLiveNotes(prState.notes);
  if (!notes.length) {
    prState.pitchTop = prPosOf(PR_DEFAULT_TOP, m);
    return;
  }
  const positions = notes.map((nt) => prPosOf(nt.midi, m));
  const center = Math.round((Math.min(...positions) + Math.max(...positions)) / 2);
  prState.pitchTop = center + Math.floor(PR_ROWS / 2);
}

// (Re)populate the grid <select> and len field from prState; a non-standard grid gets its own option.
function prSyncGridLenInputs() {
  if (!prState) return;
  const opts = [...PR_GRID_DIVS];
  if (!opts.some(([, n]) => n === prState.grid)) opts.push([String(prState.grid), prState.grid]);
  opts.sort((a, b) => a[1] - b[1]);
  prGridSelect.innerHTML = '';
  for (const [label, n] of opts) prGridSelect.add(new Option(label, String(n)));
  prGridSelect.value = String(prState.grid);
  prLenInput.value = prState.len;
}

function openPianorollEditor(call) {
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (prState?.marker) prState.marker.clear();
  const { notes, grid, len } = parsePianorollCall(inner);
  prState = {
    marker: cm.markText(from, to, {}),
    callStart: call.start,
    notes,
    grid, // granularity: cells per cycle (the *grid multiplier)
    len, // loop length in cells (grid-th notes)
    pitchTop: PR_DEFAULT_TOP, // replaced by prFramePitch below, which needs prState to exist
    fold: prFold, // show only the scale's lanes (sticky across rolls, like the tool and cmd mode)
    zoom: 1, // 1 = the whole rendered width fits; >1 zooms in horizontally with a scroll offset
    scrollCells: 0, // leftmost visible cell when zoomed in
    sel: new Set(), // currently selected note objects (transient; mutated in place, never reserialized)
    history: [], // undo snapshots, oldest first (see prPushHistory); seeded with the opening state
    histIdx: -1,
    trackLabel: prBlockLabelAt(call.start),
  };
  prPushHistory(); // the state the roll opened in - what the first cmd-Z comes back to
  prFramePitch();
  prSyncGridLenInputs();
  prPanel.classList.remove('hidden');
  drawPianoroll();
  if (!prRaf) prRaf = requestAnimationFrame(prPlayheadLoop); // sweep a playhead while it plays
  // Focus isn't taken here - openWidgetAt hands it to the canvas, because the double-click that
  // got us here says the notes are what the keyboard is for now.
}

function closePianorollEditor() {
  prPreviewOff();
  if (prRaf) { cancelAnimationFrame(prRaf); prRaf = null; }
  if (prState?.marker) prState.marker.clear();
  prState = null;
  prPanel.classList.add('hidden');
}

// Redraw each frame while the transport is running, so the playhead tracks the cycle; when it's
// paused, redraw once to clear the last playhead, then idle (the loop keeps spinning cheaply so it
// picks straight back up when play resumes). currentCyclePos() is the scheduler's own timebase.
function prPlayheadLoop() {
  if (!prState) { prRaf = null; return; }
  if (!transport.paused) drawPianoroll();
  else if (prPlayheadOn) drawPianoroll();
  prRaf = requestAnimationFrame(prPlayheadLoop);
}

// --- undo history ---
// The roll keeps its own history rather than leaning on CodeMirror's: cmd-Z with the canvas
// focused should step through what you DREW, not through unrelated edits elsewhere in the buffer,
// and one drag that moves a dozen notes is one undo step. Every commit point (see
// writePianorollCall's callers) records a snapshot; restoring one writes it back to the code, so
// the buffer and the panel never disagree.

const PR_HISTORY_MAX = 200; // snapshots kept; the oldest are dropped past this

const prSnapshot = () => ({ notes: prState.notes.map((nt) => ({ ...nt })), grid: prState.grid, len: prState.len });
const prSnapKey = (s) => `${pianorollMod.serializePianoRoll(prLiveNotes(s.notes))}|${s.grid}|${s.len}`;

// Record the roll's current state, unless it's identical to the entry we're already sitting on -
// which makes this safe to call from anywhere, including the code-sync path that fires on every
// keystroke in the buffer.
function prPushHistory() {
  const snap = prSnapshot();
  const current = prState.history[prState.histIdx];
  if (current && prSnapKey(current) === prSnapKey(snap)) return;
  prState.history.length = prState.histIdx + 1; // a fresh edit drops whatever redo tail was there
  prState.history.push(snap);
  if (prState.history.length > PR_HISTORY_MAX) prState.history.shift();
  prState.histIdx = prState.history.length - 1;
}

/** Step `delta` entries through the history (-1 = undo, +1 = redo); a no-op at either end. */
function prHistoryStep(delta) {
  const next = prState.histIdx + delta;
  if (next < 0 || next >= prState.history.length) return;
  prState.histIdx = next;
  const snap = prState.history[next];
  prState.notes = snap.notes.map((nt) => ({ ...nt }));
  prState.grid = snap.grid;
  prState.len = snap.len;
  prState.sel.clear(); // the restored notes are new objects; the old selection means nothing
  prSyncGridLenInputs();
  writePianorollCall(false); // restoring is not itself an edit to record
  drawPianoroll();
}

function writePianorollCall(record = true) {
  if (!prState) return;
  const range = prState.marker.find();
  if (!range) return;
  if (record) prPushHistory();
  const text = serializePianorollCall(prState);
  prSuppressCursor = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    // replaceRange collapses the marker - re-pin it over the fresh text (see writeLfoCall)
    prState.marker.clear();
    const startIdx = cm.indexFromPos(range.from);
    prState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    prState.callStart = startIdx;
  } finally {
    prSuppressCursor = false; // never leave it latched: that would wedge the panel shut for good
  }
  prScheduleEval();
}

// A roll edit isn't finished until it *sounds*, so every write re-evaluates the buffer - debounced,
// so a drag that touches a dozen notes still costs one request. evaluate(false) is the "update"
// path (the ⏎ shortcut): it keeps the current play state, so drawing while stopped stays stopped.
let prEvalTimer = null;
function prScheduleEval() {
  clearTimeout(prEvalTimer);
  prEvalTimer = setTimeout(() => { prEvalTimer = null; evaluate(false); }, PR_EVAL_DEBOUNCE_MS);
}

// The reverse direction: the panel re-reads the call whenever it's edited by hand, so tweaking
// `grid:`/`len:`/the note string in the code updates the roll instead of being silently reverted
// by the next drag. Notes are only rebuilt when the string actually changed (the parsed objects
// are identity-tracked by the selection), so hand-editing grid/len keeps the selection intact.
function syncPianorollFromCode() {
  if (!prState || prSuppressCursor || !pianorollMod) return;
  const range = prState.marker.find();
  // The call the roll is anchored to was deleted (or edited into something that is no longer a
  // pianoroll call) - nothing left to draw on, so the roll goes with it. This is the only thing
  // that closes it by itself now that opening is an explicit double-click.
  if (!range) { closePianorollEditor(); return; }
  const text = cm.getRange(range.from, range.to);
  if (!/^\s*pianoroll\s*\(/.test(text)) { closePianorollEditor(); return; }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const parsed = parsePianorollCall(text.slice(open + 1, close));
  prState.callStart = cm.indexFromPos(range.from);
  prState.grid = parsed.grid;
  prState.len = parsed.len;
  if (pianorollMod.serializePianoRoll(parsed.notes) !== pianorollMod.serializePianoRoll(prLiveNotes(prState.notes))) {
    prState.notes = parsed.notes;
    prState.sel.clear(); // the old note objects are gone
  }
  // A hand edit is an edit like any other, so cmd-Z can walk back over it. Identical states are
  // ignored (see prPushHistory), which is what keeps typing elsewhere in the buffer out of here.
  prPushHistory();
  prSyncGridLenInputs();
  drawPianoroll();
}

// --- canvas geometry (logical coordinates; the backing store is scaled by devicePixelRatio) ---
// The grid renders `cols` cells - at least the loop (len) plus a little headroom, and at least one
// cycle (grid) for context. Horizontal zoom widens each cell past the "fit" width and scrolls; the
// pitch axis never zooms. A loop ruler occupies the top PR_TOPBAR px; note rows sit below it.

// Rendered columns: the loop rounded up to its next whole bar, plus a little headroom to drag into.
// Frozen (prState._dragCols) during a loop drag so the cell width - and thus the drag mapping -
// stays put instead of feeding back on itself as len changes.
const prRenderCols = () => (Math.floor(prState.len / prState.grid) + 1) * prState.grid + 4;

function prMetrics() {
  const gridW = PR_W - PR_GUTTER;
  const rowH = PR_GRIDH / PR_ROWS;
  const cols = prState._dragCols ?? prRenderCols();
  const cellW = (gridW / cols) * prState.zoom;
  const visibleCells = gridW / cellW; // = cols / zoom
  const maxScroll = Math.max(0, cols - visibleCells);
  const scroll = Math.min(maxScroll, Math.max(0, prState.scrollCells));
  prState.scrollCells = scroll; // keep state clamped as len/grid/zoom change
  // The pitch axis in lane terms (see prLaneList): laneOf is midi -> lane for O(1) lookups during
  // a draw, built here so folding, drawing and hit-testing all read the same axis.
  const lanes = prLaneList();
  let laneOf = null;
  if (lanes) {
    laneOf = new Int16Array(128);
    let i = 0;
    for (let midi = 0; midi <= 127; midi++) {
      while (i + 1 < lanes.length && lanes[i + 1] <= midi) i++;
      laneOf[midi] = i;
    }
  }
  const laneMax = (lanes ? lanes.length : 128) - 1;
  // Clamp the pitch window the same way scrollCells is clamped, so toggling fold (or deleting the
  // notes that were holding a lane open) can't leave the view parked past the end of the axis.
  prState.pitchTop = Math.max(Math.min(PR_ROWS - 1, laneMax), Math.min(laneMax, prState.pitchTop));
  return { W: PR_W, H: PR_CH, gridTop: PR_TOPBAR, gridH: PR_GRIDH, laneTop: PR_TOPBAR + PR_GRIDH, laneH: PR_LANEH, gridW, cols, cellW, rowH, visibleCells, maxScroll, scroll, lanes, laneOf, laneMax, bottomPos: prState.pitchTop - PR_ROWS };
}

const prCellToX = (cell, m) => PR_GUTTER + (cell - m.scroll) * m.cellW;
const prPosToY = (pos, m) => PR_TOPBAR + (prState.pitchTop - pos) * m.rowH;
const prMidiToY = (midi, m) => prPosToY(prPosOf(midi, m), m);
const prCellFloat = (px, m) => m.scroll + (px - PR_GUTTER) / m.cellW; // fractional cell under px

function prCanvasPos(e) {
  const r = prCanvas.getBoundingClientRect();
  return { px: (e.clientX - r.left) * (PR_W / r.width), py: (e.clientY - r.top) * (PR_CH / r.height) };
}

function prCellAt(px, m) {
  if (px < PR_GUTTER) return null;
  const cell = Math.floor(prCellFloat(px, m));
  return cell >= 0 && cell < m.cols ? cell : null;
}

const prClampCell = (px, m) => Math.max(0, Math.min(m.cols - 1, Math.floor(prCellFloat(px, m))));
// pitchTop is fractional (smooth scroll); the integer lane containing py is ceil(top - rows).
const prPosAt = (py, m) => Math.ceil(prState.pitchTop - (py - PR_TOPBAR) / m.rowH);
const prMidiAt = (py, m) => prMidiOf(prPosAt(py, m), m);

// Topmost note covering (cell, midi) - later notes draw on top (and win overlaps), so scan from
// the end. Hidden notes aren't on the grid at all, so they can't be hit.
function prNoteAt(cell, midi) {
  for (let i = prState.notes.length - 1; i >= 0; i--) {
    const nt = prState.notes[i];
    if (!nt.hidden && nt.midi === midi && cell >= nt.start && cell < nt.start + nt.len) return i;
  }
  return null;
}

function prRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A literal piano down the left edge - white/black keys, note names, C's called out. Fixed
// key colours (a piano reads the same in any theme); the divider follows the theme. With a scale
// set, every key IN the scale is tinted with the theme accent and the tonic is tinted hardest -
// the way Live colours its keyboard - so the key you're in reads off the piano itself rather than
// off the note names. Black and white keys both take the tint, over their own base colour, so
// the piano still reads as a piano underneath.
function drawPianoKeys(ctx, col, m, info) {
  const { H, gridTop, rowH, laneTop } = m;
  const accent = col('--accent');
  ctx.textBaseline = 'middle';
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#ececed';
  ctx.fillRect(0, gridTop, PR_GUTTER, laneTop - gridTop);

  ctx.save(); // clip keys/labels to the grid area so partial edge lanes don't spill into the ruler or the value lane
  ctx.beginPath(); ctx.rect(0, gridTop, PR_GUTTER, laneTop - gridTop); ctx.clip();
  const topP = Math.ceil(prState.pitchTop);
  const botP = Math.floor(prState.pitchTop - PR_ROWS) - 1;

  ctx.textAlign = 'right';
  for (let p = topP; p >= botP; p--) {
    if (p < 0 || p > m.laneMax) continue;
    const M = prMidiOf(p, m);
    if (isBlackKey(M)) continue;
    const rank = prScaleRank(M, info);
    const y = prPosToY(p, m);
    if (rank >= 1) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = PR_KEY_TINT[rank];
      ctx.fillRect(0, y + 1, PR_GUTTER, rowH - 1);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, y + rowH); ctx.lineTo(PR_GUTTER, y + rowH); ctx.stroke();
    // Labels darken with the tint they sit on, so every one of them stays legible.
    ctx.fillStyle = rank === 2 || M % 12 === 0 ? '#161619' : rank === 1 ? '#3c3c46' : '#70707a';
    ctx.fillText(midiName(M), PR_GUTTER - 5, y + rowH / 2 + 0.5);
  }

  const bw = PR_GUTTER * 0.62; // black keys reach ~62% across the gutter
  for (let p = topP; p >= botP; p--) {
    if (p < 0 || p > m.laneMax) continue;
    const M = prMidiOf(p, m);
    if (!isBlackKey(M)) continue;
    const rank = prScaleRank(M, info);
    const y = prPosToY(p, m);
    ctx.fillStyle = '#242429';
    prRoundRect(ctx, -3, y + 1, bw + 3, rowH - 2, 2);
    ctx.fill();
    if (rank >= 1) { // the accent over the dark key, so an in-key black key reads as in-key too
      ctx.fillStyle = accent;
      ctx.globalAlpha = PR_KEY_TINT[rank];
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = rank >= 1 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'right';
    ctx.fillText(midiName(M), bw - 4, y + rowH / 2 + 0.5);
  }
  ctx.restore();

  ctx.strokeStyle = col('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER + 0.5, 0); ctx.lineTo(PR_GUTTER + 0.5, H); ctx.stroke();
}

// The loop ruler across the top: bar ticks, the loop region [0,len] highlighted, and a grab handle
// at the loop end. Returns the loop-end x so the interaction code can hit-test the handle.
function drawLoopBar(ctx, col, m) {
  const accent = col('--accent');
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, 0, m.W, PR_TOPBAR);

  const loopEndX = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prState.len, m)));
  const loopStartX = Math.max(PR_GUTTER, prCellToX(0, m));
  ctx.fillStyle = col('--accent-soft');
  ctx.fillRect(loopStartX, 0, Math.max(0, loopEndX - loopStartX), PR_TOPBAR);

  // bar ticks + numbers (a bar = `grid` cells = one cycle)
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = col('--text-dim');
  for (let c = 0; c <= m.cols; c += prState.grid) {
    const x = prCellToX(c, m);
    if (x < PR_GUTTER - 0.5 || x > m.W + 0.5) continue;
    ctx.strokeStyle = col('--border-strong');
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, PR_TOPBAR); ctx.stroke();
    ctx.fillText(String(c / prState.grid + 1), x + 3, PR_TOPBAR / 2);
  }

  // grab handle at the loop end
  if (loopEndX <= m.W) {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(loopEndX, 0); ctx.lineTo(loopEndX, PR_TOPBAR); ctx.lineTo(loopEndX - 6, PR_TOPBAR / 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = col('--border');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER, PR_TOPBAR + 0.5); ctx.lineTo(m.W, PR_TOPBAR + 0.5); ctx.stroke();
  return loopEndX;
}

// --- value lane ---
// Ableton's velocity/chance editor, along the bottom: every note gets a marker at its value's
// height - a dot at its onset with a line running right for its duration, drawn dashed when the
// lane is showing probability (Live's chance style). Drag a marker up or down to set the value; a
// marker in the selection drags the whole selection together, keeping their differences. The label
// in the lane's gutter names the channel on show and clicks through to the same vel/prob switch as
// the header button.

/** Which note channel the lane (and cmd-drag) is editing right now. */
const prLaneKey = () => (prCmdMode === 'prob' ? 'prob' : 'vel');

/** value (0..1) -> lane y, inset so the end-stop dots at 0 and 1 stay fully visible. */
const prLaneY = (v, m) => m.laneTop + PR_LANE_PAD + (1 - v) * (m.laneH - 2 * PR_LANE_PAD);

// The note whose lane column contains px - grabbing anywhere under a note works, like Live. When
// several share the column (a chord), the marker nearest the pointer wins; ties go to the topmost
// note, matching the grid's hit order.
function prLaneNoteAt(px, py, m) {
  const key = prLaneKey();
  let best = null, bestDy = Infinity;
  for (let i = prState.notes.length - 1; i >= 0; i--) {
    const nt = prState.notes[i];
    if (nt.hidden) continue;
    if (px < prCellToX(nt.start, m) - 4 || px >= prCellToX(nt.start + nt.len, m)) continue;
    const dy = Math.abs(prLaneY(nt[key], m) - py);
    if (dy < bestDy) { bestDy = dy; best = nt; }
  }
  return best;
}

function drawValueLane(ctx, col, m) {
  const { W, laneTop, laneH } = m;
  const accent = col('--accent');
  const key = prLaneKey();
  ctx.fillStyle = col('--bg');
  ctx.fillRect(PR_GUTTER, laneTop, W - PR_GUTTER, laneH);

  // bar lines carry on through the lane, so the markers stay locatable in time
  const c0 = Math.max(0, Math.floor(m.scroll));
  const c1 = Math.min(m.cols, Math.ceil(m.scroll + m.visibleCells));
  for (let c = Math.ceil(c0 / prState.grid) * prState.grid; c <= c1; c += prState.grid) {
    const x = prCellToX(c, m);
    if (x < PR_GUTTER - 0.5 || x > W + 0.5) continue;
    ctx.strokeStyle = col('--border');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, laneTop); ctx.lineTo(x, laneTop + laneH); ctx.stroke();
  }
  // dim past the loop end, matching the grid above
  const dimX = Math.max(PR_GUTTER, prCellToX(prState.len, m));
  if (dimX < W) {
    ctx.fillStyle = 'rgba(120,120,130,0.22)';
    ctx.fillRect(dimX, laneTop, W - dimX, laneH);
  }

  // markers - selected ones drawn last so a chord's dragged marker stays visible on top
  const selCol = col('--text');
  const muteCol = col('--text-dim');
  const marker = (nt) => {
    const x = prCellToX(nt.start, m);
    const x2 = prCellToX(nt.start + nt.len, m);
    if (x2 <= PR_GUTTER || x >= W) return;
    const y = prLaneY(nt[key], m);
    const selected = prState.sel.has(nt);
    ctx.strokeStyle = ctx.fillStyle = nt.mute ? muteCol : selected ? selCol : accent;
    ctx.globalAlpha = nt.mute ? 0.35 : 0.9;
    ctx.lineWidth = selected ? 2 : 1.4;
    ctx.setLineDash(key === 'prob' ? [2, 3] : []);
    ctx.beginPath(); ctx.moveTo(Math.max(PR_GUTTER, x) + 1, y); ctx.lineTo(Math.min(W, x2) - 1, y); ctx.stroke();
    ctx.setLineDash([]);
    if (x >= PR_GUTTER - 0.5) { ctx.beginPath(); ctx.arc(x + 1, y, selected ? 3.5 : 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  };
  const live = prLiveNotes(prState.notes);
  for (const nt of live) if (!prState.sel.has(nt)) marker(nt);
  for (const nt of live) if (prState.sel.has(nt)) marker(nt);

  // live readout on the marker being dragged, so the number lands where the eye already is
  const dragNt = prState._laneDrag;
  if (dragNt && !dragNt.hidden) {
    const x = prCellToX(dragNt.start, m);
    const y = prLaneY(dragNt[key], m);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col('--text');
    ctx.fillText(String(Math.round(dragNt[key] * 100) / 100), Math.max(PR_GUTTER + 3, x + 7), Math.min(laneTop + laneH - 6, Math.max(laneTop + 7, y - 9)));
  }

  // gutter: the channel on show; clicking it flips to the other one (the header button's switch)
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, laneTop, PR_GUTTER, laneH);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  ctx.fillText(key, PR_GUTTER / 2, laneTop + laneH / 2);

  ctx.strokeStyle = col('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, laneTop + 0.5); ctx.lineTo(W, laneTop + 0.5); ctx.stroke();
}

function drawPianoroll() {
  if (!prState || !pianorollMod) return;
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const ctx = prCanvas.getContext('2d');
  ctx.setTransform(prCanvas._dpr || 1, 0, 0, prCanvas._dpr || 1, 0, 0);
  const m = prMetrics();
  const { W, H, gridTop, gridH, rowH, laneTop } = m;
  ctx.clearRect(0, 0, W, H);

  // grid background + per-note lanes. Iterating integer lanes (not fixed rows) lets a fractional
  // pitchTop scroll smoothly - each lane sits at its own y, partial lanes clipped at the edges.
  // With a scale set the lanes are shaded by their place in it rather than by black/white: the
  // tonic in the accent, in-key notes on the plain background, out-of-key ones dimmed - so the
  // key reads off the grid the way it does in Live. Folded, the out-of-key lanes are gone
  // entirely and the dimmed ones left are notes you drew outside the key.
  const info = prScaleInfo();
  const accent = col('--accent');
  ctx.fillStyle = col('--bg');
  ctx.fillRect(PR_GUTTER, gridTop, W - PR_GUTTER, gridH);
  const topP = Math.ceil(prState.pitchTop);
  const botP = Math.floor(prState.pitchTop - PR_ROWS) - 1;
  for (let p = topP; p >= botP; p--) {
    if (p < 0 || p > m.laneMax) continue;
    const M = prMidiOf(p, m);
    const rank = prScaleRank(M, info);
    const y = prPosToY(p, m);
    const y0 = Math.max(gridTop, y), y1 = Math.min(laneTop, y + rowH);
    if (y1 > y0) {
      // In key: an accent wash, stronger on the tonic. Out of key (or a black key with no scale
      // set): the same dim the roll has always used.
      if (rank >= 1) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = PR_LANE_TINT[rank];
        ctx.fillRect(PR_GUTTER, y0, W - PR_GUTTER, y1 - y0);
        ctx.globalAlpha = 1;
      } else if (rank === 0 || (rank === null && isBlackKey(M))) {
        ctx.fillStyle = col('--hover-bg');
        ctx.fillRect(PR_GUTTER, y0, W - PR_GUTTER, y1 - y0);
      }
    }
    if (y >= gridTop - 0.5 && y <= laneTop + 0.5) {
      ctx.strokeStyle = col('--border');
      // heavier at each octave boundary - the tonic's when there's a scale, otherwise each C
      ctx.lineWidth = (info ? rank === 2 : M % 12 === 0) ? 1.2 : 0.5;
      ctx.beginPath(); ctx.moveTo(PR_GUTTER, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  // vertical lines (visible span only): heaviest at each bar (a cycle = grid cells), medium at beats
  const beat = prState.grid % 4 === 0 ? prState.grid / 4 : prState.grid;
  const c0 = Math.max(0, Math.floor(m.scroll));
  const c1 = Math.min(m.cols, Math.ceil(m.scroll + m.visibleCells));
  for (let c = c0; c <= c1; c++) {
    const x = prCellToX(c, m);
    if (x < PR_GUTTER - 0.5 || x > W + 0.5) continue;
    ctx.strokeStyle = c % prState.grid === 0 ? col('--border-strong') : col('--border');
    ctx.lineWidth = c % prState.grid === 0 ? 1.4 : c % beat === 0 ? 1.1 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, laneTop); ctx.stroke();
  }
  // dim the region past the loop end (cells >= len are outside the loop)
  const dimX = prCellToX(prState.len, m);
  if (dimX < W) {
    ctx.fillStyle = 'rgba(120,120,130,0.22)';
    ctx.fillRect(Math.max(PR_GUTTER, dimX), gridTop, W - Math.max(PR_GUTTER, dimX), gridH);
  }

  // notes: fill opacity encodes velocity; a dashed outline marks a sub-unity probability; selected
  // notes get a bright solid outline. A muted note drops out of the accent entirely and is drawn in
  // flat grey - it's still on the grid, and still selectable, but it reads as switched off.
  // Rectangles are clipped to the grid when scrolled.
  const selCol = col('--text');
  const muteCol = col('--text-dim');
  for (const nt of prLiveNotes(prState.notes)) {
    const pos = prPosOf(nt.midi, m);
    if (pos > prState.pitchTop + 1 || pos < m.bottomPos) continue; // +1: keep a partial top lane
    const x = prCellToX(nt.start, m);
    const x2 = prCellToX(nt.start + nt.len, m);
    if (x2 <= PR_GUTTER || x >= W) continue;
    const dx = Math.max(PR_GUTTER + 0.5, x);
    const dx2 = Math.min(W, x2);
    const y = prMidiToY(nt.midi, m);
    const w = Math.max(2, dx2 - dx - 1);
    const selected = prState.sel.has(nt);
    // Muted notes ignore velocity too - a fixed wash, since the loudness of a note that doesn't
    // play is nothing to read off the grid.
    ctx.globalAlpha = nt.mute ? 0.3 : 0.4 + 0.6 * nt.vel;
    ctx.fillStyle = nt.mute ? muteCol : accent;
    prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? selCol : nt.mute ? muteCol : accent;
    ctx.setLineDash(nt.prob < 1 && !selected ? [3, 2] : []);
    prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.stroke();
    ctx.setLineDash([]);
  }

  // marquee rubber-band (select tool)
  if (prState.marquee) {
    const r = prState.marquee;
    ctx.fillStyle = col('--accent-soft');
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
  }

  drawValueLane(ctx, col, m);

  // playhead: sweeps the loop (position = absolute cell mod len) while the transport runs
  prPlayheadOn = false;
  if (!transport.paused) {
    const abs = currentCyclePos() * prState.grid;
    const x = prCellToX(((abs % prState.len) + prState.len) % prState.len, m);
    if (x >= PR_GUTTER && x <= W) {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, H); ctx.stroke();
      ctx.globalAlpha = 1;
      prPlayheadOn = true;
    }
  }

  drawLoopBar(ctx, col, m);
  drawPianoKeys(ctx, col, m, info); // last, so it overlays the grid's left edge cleanly
}

// Keep the moved selection within the visible pitch window (in lane coordinates, so it follows a
// folded roll too). prMetrics clamps whatever this sets to the ends of the axis.
function prScrollTo(notes) {
  if (!notes.length) return;
  const m = prMetrics();
  const positions = notes.map((n) => prPosOf(n.midi, m));
  const hi = Math.max(...positions);
  const lo = Math.min(...positions);
  if (hi > prState.pitchTop) prState.pitchTop = hi;
  else if (lo < prState.pitchTop - PR_ROWS + 1) prState.pitchTop = lo + PR_ROWS - 1;
}

// Which cursor the pointer should show at (px,py), given whether a velocity/prob modifier is held.
function prCursorFor(px, py, m, velMod) {
  if (py < PR_TOPBAR) return px >= PR_GUTTER ? 'ew-resize' : 'default'; // loop ruler (drag its end)
  if (py >= m.laneTop) { // value lane: markers drag up/down, the gutter label is the vel/prob switch
    if (px < PR_GUTTER) return 'pointer';
    return prLaneNoteAt(px, py, m) ? CUR_UPDOWN : 'default';
  }
  if (px < PR_GUTTER) return 'pointer'; // over the piano keyboard
  const cell = prCellAt(px, m);
  const emptyCursor = prTool === 'draw' ? CUR_PENCIL : 'crosshair'; // pencil draws, arrow marquees
  if (cell == null) return emptyCursor;
  const hit = prNoteAt(cell, prMidiAt(py, m));
  if (hit == null) return emptyCursor;
  const nt = prState.notes[hit];
  if (velMod) return CUR_UPDOWN; // cmd/ctrl over a note = velocity/probability drag
  if (px >= prCellToX(nt.start + nt.len, m) - PR_EDGE_PX) return CUR_BRACKET; // right-edge = length
  return 'move';
}

// Ableton's overlap rule (see clipOverlaps): no two notes ring at one pitch. The note on top keeps
// its full drawn length; one it merely runs into is cut off at its onset, and one it lands square
// on top of is hidden outright. Both are non-destructive - the drawn length rides on `full` and a
// hidden note stays in prState.notes, just out of the roll and out of the code - so this can run
// live on every drag frame, and moving the note on top away brings the other one straight back.
//
// Hidden notes are the roll's only invisible state, so everything that reads notes for the user -
// drawing, hit-testing, the marquee, the serializer - goes through prLiveNotes.
const prLiveNotes = (notes) => notes.filter((nt) => !nt.hidden);

function prClipOverlaps() {
  if (!prState || !pianorollMod) return;
  pianorollMod.clipOverlaps(prState.notes);
  for (const n of [...prState.sel]) if (n.hidden) prState.sel.delete(n); // can't act on what isn't there
}

// Put `notes` on top: priority is array order, so the notes an edit just placed go last and are
// the ones that keep their length. Called before the edit, so clipping afterwards resolves in
// their favour.
function prTouch(notes) {
  const raised = new Set(notes);
  if (!raised.size) return;
  prState.notes = [...prState.notes.filter((n) => !raised.has(n)), ...prState.notes.filter((n) => raised.has(n))];
}

// Live's `0`: switch notes off without deleting them. They stay on the grid greyed out - still
// selectable, still draggable, still holding their lane against the overlap rule - and simply don't
// sound, which is a `!` on their token in the code. One key does both directions: a group with any
// note still playing is muted whole, and a group that's already all muted comes back on, so
// tapping 0 twice over a phrase is exactly where you started.
//
// It acts on the selection, or - with nothing selected - on the note under the pointer, so the key
// works the same whether you marquee'd a phrase or are just hovering one note with the pencil.
function prToggleMute() {
  let notes = [...prState.sel];
  if (!notes.length) {
    const m = prMetrics();
    const cell = prCellAt(prPointer.px, m);
    const hit = cell == null ? null : prNoteAt(cell, prMidiAt(prPointer.py, m));
    if (hit == null) return;
    notes = [prState.notes[hit]];
  }
  const mute = notes.some((n) => !n.mute);
  for (const n of notes) n.mute = mute;
  if (mute) prPreviewOff(); // a note that just went silent shouldn't be left ringing
  writePianorollCall();
  drawPianoroll();
}

// Duplicate the selection one block-length to the right (Ableton's cmd-D), selecting the copies.
function prDuplicate() {
  if (!prState.sel.size) return;
  const sel = [...prState.sel];
  const shift = Math.max(1, Math.max(...sel.map((n) => n.start + n.len)) - Math.min(...sel.map((n) => n.start)));
  const copies = sel.map((n) => ({ ...n, start: Math.min(prState.len - 1, n.start + shift) }));
  prState.notes.push(...copies);
  prState.sel = new Set(copies);
  prClipOverlaps(); // the copies were pushed last, so they land on top of anything already there
  writePianorollCall();
  drawPianoroll();
}

// Fold on/off, keeping the view where it was: the pitch axis changes length underneath, so the
// note at the middle of the window is re-centered in the new coordinates rather than letting the
// raw lane index carry over (which would jump the roll somewhere unrelated).
function prSetFold(on) {
  const before = prMetrics();
  const centerMidi = prMidiOf(Math.round(prState.pitchTop - PR_ROWS / 2), before);
  prState.fold = on;
  const after = prMetrics();
  prState.pitchTop = prPosOf(centerMidi, after) + Math.floor(PR_ROWS / 2);
  drawPianoroll();
}

// Horizontal zoom that keeps the cell currently under `anchorPx` pinned to that same screen x, so
// it zooms toward the pointer; anchorPx defaults to the view's center. (scrollCells is clamped in
// prMetrics, so the pin gives way gracefully at the edges.)
function prZoomBy(factor, anchorPx) {
  const m = prMetrics();
  const px = anchorPx ?? PR_GUTTER + m.gridW / 2;
  const cell = prCellFloat(px, m); // the cell under the pointer before zooming
  prState.zoom = Math.min(PR_MAX_ZOOM, Math.max(1, prState.zoom * factor));
  const m2 = prMetrics();
  prState.scrollCells = cell - (px - PR_GUTTER) / m2.cellW; // put that cell back under the pointer
  drawPianoroll();
}

function initPianorollCanvas() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  prCanvas._dpr = dpr;
  prCanvas.width = PR_W * dpr;
  prCanvas.height = PR_CH * dpr;
  prCanvas.style.width = PR_W + 'px';
  prCanvas.style.height = PR_CH + 'px';
  prCanvas.tabIndex = 0; // focusable, so arrow keys / delete / ctrl-a reach it

  let drag = null; // { kind: 'create'|'move'|'resize'|'vel'|'lane'|'marquee'|'loop'|'audition', ... }
  const snapshotPos = () => [...prState.sel].map((n) => ({ n, start: n.start, midi: n.midi }));
  const snapshotLen = () => [...prState.sel].map((n) => ({ n, len: n.len }));
  // Raise the dragged notes over whatever they land on - but only once the drag has actually moved
  // something, so a click that merely selects a note never reshuffles the lane it sits in.
  const raiseOnce = (d) => { if (!d.raised) { d.raised = true; prTouch(prState.sel); } };
  const setCursor = (c) => { if (prCanvas.style.cursor !== c) prCanvas.style.cursor = c; };
  const dragCursor = (d) =>
    ({ vel: CUR_UPDOWN, lane: CUR_UPDOWN, resize: CUR_BRACKET, move: 'grabbing', create: CUR_PENCIL, marquee: 'crosshair', loop: 'ew-resize', audition: 'pointer' }[d.kind] ?? 'default');

  prCanvas.addEventListener('contextmenu', (e) => { if (prState) e.preventDefault(); }); // ctrl-drag (mac) = velocity, not a menu

  prCanvas.addEventListener('pointerdown', (e) => {
    if (!prState) return;
    prCanvas.focus();
    prCanvas.setPointerCapture(e.pointerId);
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    prPointer = { px, py };
    if (py < PR_TOPBAR) { // loop ruler - drag to set the loop length (written on pointerup)
      if (px >= PR_GUTTER) { drag = { kind: 'loop' }; prState._dragCols = m.cols; prState.len = Math.max(1, Math.round(prCellFloat(px, m))); prLenInput.value = prState.len; drawPianoroll(); }
      return;
    }
    if (py >= m.laneTop) { // value lane - drag a marker to set velocity/probability (see drawValueLane)
      if (px < PR_GUTTER) { prCmdModeBtn.click(); return; } // the vel/prob label (the button redraws)
      const nt = prLaneNoteAt(px, py, m);
      if (!nt) { prState.sel = new Set(); drawPianoroll(); return; }
      if (e.shiftKey) { // shift-click toggles selection, same as on the note itself
        if (prState.sel.has(nt)) prState.sel.delete(nt); else prState.sel.add(nt);
        drawPianoroll();
        return;
      }
      if (!prState.sel.has(nt)) prState.sel = new Set([nt]);
      drag = { kind: 'lane', lastPy: py };
      prState._laneDrag = nt; // the marker the readout follows
      drawPianoroll();
      return;
    }
    const pos = prPosAt(py, m);
    const midi = prMidiOf(pos, m);
    const cell = prCellAt(px, m);
    if (cell == null) {
      // clicked the piano keyboard - audition that key, don't edit
      if (px < PR_GUTTER && pos <= prState.pitchTop && pos >= m.bottomPos) { drag = { kind: 'audition' }; prPreview(midi); }
      return;
    }
    const hit = prNoteAt(cell, midi);
    const velMod = e.metaKey || e.ctrlKey; // cmd (mac) / ctrl - velocity or probability drag
    if (hit != null) {
      const nt = prState.notes[hit];
      if (e.shiftKey && !velMod) { // shift-click toggles this note in/out of the selection
        if (prState.sel.has(nt)) prState.sel.delete(nt); else prState.sel.add(nt);
        drawPianoroll();
        return;
      }
      if (!prState.sel.has(nt)) prState.sel = new Set([nt]); // clicking an unselected note selects just it
      if (velMod) {
        drag = { kind: 'vel' };
      } else if (px >= prCellToX(nt.start + nt.len, m) - PR_EDGE_PX) {
        drag = { kind: 'resize', grabCell: cell, orig: snapshotLen() };
      } else {
        drag = { kind: 'move', grabCell: cell, grabPos: pos, orig: snapshotPos() };
        prPreviewNotes([nt]);
      }
    } else if (prTool === 'select') {
      // rubber-band select (shift keeps the existing selection as a base). Without shift the click
      // deselects right away, so a click that never becomes a drag still lands on empty space empty-handed.
      if (!e.shiftKey) prState.sel = new Set();
      drag = { kind: 'marquee', x0: px, y0: py, base: e.shiftKey ? new Set(prState.sel) : new Set() };
      prState.marquee = { x: px, y: py, w: 0, h: 0 };
    } else if (cell < prState.len) { // draw a note (only inside the loop)
      if (!e.shiftKey) prState.sel = new Set();
      const nt = { midi, start: cell, len: 1, full: 1, vel: PR_DEFAULT_VEL, prob: 1, mute: false };
      prState.notes.push(nt);
      prState.sel.add(nt);
      drag = { kind: 'create', note: nt };
      prClipOverlaps(); // pushed last, so it takes the lane from whatever was under the pencil
      prPreview(midi);
    } else {
      prState.sel = new Set(); // click in the dimmed area past the loop end - just clear selection
    }
    drawPianoroll();
  });

  prCanvas.addEventListener('pointermove', (e) => {
    if (!prState) return;
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    prPointer = { px, py };
    if (!drag) { setCursor(prCursorFor(px, py, m, e.metaKey || e.ctrlKey)); return; }
    if (drag.kind === 'loop') {
      prState.len = Math.max(1, Math.round(prCellFloat(px, m)));
      prLenInput.value = prState.len;
    } else if (drag.kind === 'create') {
      drag.note.full = Math.max(1, prClampCell(px, m) - drag.note.start + 1); // what you drew...
      prClipOverlaps(); // ...and what the lane leaves room for
    } else if (drag.kind === 'resize') {
      // The edge you grabbed is the one you can see, so a resize re-authors the length from there.
      const d = prClampCell(px, m) - drag.grabCell;
      if (d) raiseOnce(drag);
      for (const o of drag.orig) o.n.full = Math.max(1, o.len + d);
      prClipOverlaps();
    } else if (drag.kind === 'move') {
      const cell = prCellAt(px, m);
      if (cell == null) return;
      const dCell = cell - drag.grabCell;
      const dPos = prPosAt(py, m) - drag.grabPos; // lanes, so a folded drag steps through the scale
      if (dCell || dPos) raiseOnce(drag);
      for (const o of drag.orig) {
        o.n.start = Math.min(prState.len - 1, Math.max(0, o.start + dCell));
        o.n.midi = prMidiOf(prPosOf(o.midi, m) + dPos, m);
      }
      prClipOverlaps(); // notes it passes over give way, and come back behind it
      if (drag.orig[0]) prPreviewNotes([drag.orig[0].n]);
    } else if (drag.kind === 'vel') {
      const d = (e.movementY ?? 0) * 0.01;
      for (const n of prState.sel) {
        if (prCmdMode === 'prob') n.prob = Math.min(1, Math.max(0, n.prob - d));
        else n.vel = Math.min(1, Math.max(0, n.vel - d));
      }
    } else if (drag.kind === 'lane') {
      // The lane's full height is the full 0..1 range; the delta is relative, so a multi-note drag
      // keeps the selection's differences until a note reaches an end stop.
      const d = (py - drag.lastPy) / (m.laneH - 2 * PR_LANE_PAD);
      drag.lastPy = py;
      const key = prLaneKey();
      for (const n of prState.sel) n[key] = Math.min(1, Math.max(0, n[key] - d));
    } else if (drag.kind === 'marquee') {
      const xa = Math.min(Math.max(px, PR_GUTTER), PR_W), xb = Math.min(Math.max(drag.x0, PR_GUTTER), PR_W);
      const ya = Math.min(Math.max(py, PR_TOPBAR), m.laneTop), yb = Math.min(Math.max(drag.y0, PR_TOPBAR), m.laneTop);
      const rx = Math.min(xa, xb), rw = Math.abs(xa - xb), ry = Math.min(ya, yb), rh = Math.abs(ya - yb);
      prState.marquee = { x: rx, y: ry, w: rw, h: rh };
      const c0 = prCellFloat(rx, m), c1 = prCellFloat(rx + rw, m);
      const midiHi = prMidiAt(ry, m), midiLo = prMidiAt(ry + rh, m);
      const inRect = (n) => n.midi >= midiLo && n.midi <= midiHi && n.start < c1 && n.start + n.len > c0;
      prState.sel = new Set([...drag.base, ...prLiveNotes(prState.notes).filter(inRect)]);
    }
    setCursor(dragCursor(drag));
    drawPianoroll();
  });

  prCanvas.addEventListener('pointerup', (e) => {
    if (drag && prState) {
      if (drag.kind === 'marquee') prState.marquee = null;
      else if (drag.kind !== 'audition') {
        prClipOverlaps(); // already clipped live on every frame; this settles the final position
        writePianorollCall();
      }
      prState._dragCols = null; // unfreeze the loop-drag column width
      prState._laneDrag = null; // the lane readout only follows an active drag
    }
    prPreviewOff();
    drag = null;
    try { prCanvas.releasePointerCapture(e.pointerId); } catch {}
    drawPianoroll();
  });

  prCanvas.addEventListener('dblclick', (e) => {
    if (!prState) return;
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    if (py >= m.laneTop) return; // the value lane edits values, never the notes themselves
    const cell = prCellAt(px, m);
    if (cell == null) return;
    const hit = prNoteAt(cell, prMidiAt(py, m));
    if (hit != null) { // double-click a note erases it
      prState.sel.delete(prState.notes[hit]);
      prState.notes.splice(hit, 1);
      prClipOverlaps(); // whatever it was covering comes back
      writePianorollCall();
      drawPianoroll();
    } else if (prTool === 'select' && cell < prState.len) { // double-click empty in the arrow tool draws a note
      const nt = { midi: prMidiAt(py, m), start: cell, len: 1, full: 1, vel: PR_DEFAULT_VEL, prob: 1, mute: false };
      prState.notes.push(nt);
      prState.sel = new Set([nt]);
      prClipOverlaps();
      writePianorollCall();
      drawPianoroll();
    }
  });

  prCanvas.addEventListener('wheel', (e) => {
    if (!prState) return;
    e.preventDefault();
    const m = prMetrics();
    const { px } = prCanvasPos(e);
    if (e.ctrlKey || e.metaKey) {
      prZoomBy(Math.exp(-e.deltaY * PR_ZOOM_WHEEL), px); // proportional, pinned to the pointer
      return;
    }
    // Horizontal component (a trackpad left/right swipe or a horizontal wheel), or shift+wheel,
    // pans time - the way to get around once zoomed in. The vertical component scrolls pitch.
    const panCells = e.deltaX + (e.shiftKey ? e.deltaY : 0);
    let changed = false;
    if (panCells) {
      prState.scrollCells += (panCells / 120) * Math.max(1, m.visibleCells * 0.2);
      changed = true;
    }
    if (e.deltaY && !e.shiftKey) {
      // pitch scrolls continuously (pitchTop is fractional), so it glides instead of stepping rows
      prState.pitchTop -= e.deltaY * PR_PITCH_WHEEL; // prMetrics clamps it to the ends of the axis
      changed = true;
    }
    if (changed) drawPianoroll();
  }, { passive: false });

  prCanvas.addEventListener('keydown', (e) => {
    if (!prState) return;
    const sel = [...prState.sel];
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      // Undo/redo for the roll, scoped to the canvas having focus - cmd-Z with the cursor in the
      // code is CodeMirror's, as it always was. Ctrl-Y is the Windows redo spelling.
      e.preventDefault();
      prHistoryStep(e.shiftKey ? 1 : -1);
    } else if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      prHistoryStep(1);
    } else if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      prState.sel = new Set(prLiveNotes(prState.notes));
      drawPianoroll();
    } else if (mod && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      prDuplicate();
    } else if (e.key === '0' && !mod && !e.altKey) {
      e.preventDefault();
      prToggleMute();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!sel.length) return;
      e.preventDefault();
      prState.notes = prState.notes.filter((n) => !prState.sel.has(n));
      prState.sel.clear();
      prClipOverlaps(); // the notes they were covering come back, at their drawn length
      writePianorollCall();
      drawPianoroll();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (prState.sel.size) { prState.sel.clear(); drawPianoroll(); } else closePianorollEditor();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!sel.length) return;
      e.preventDefault();
      // A plain arrow steps one LANE (a semitone, or one scale step when folded); shift is an
      // octave, which is 12 semitones either way.
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const m = prMetrics();
      prTouch(sel); // a nudged note lands on top, like a dragged one
      for (const n of sel) {
        n.midi = e.shiftKey
          ? Math.min(127, Math.max(0, n.midi + dir * 12))
          : prMidiOf(prPosOf(n.midi, m) + dir, m);
      }
      prScrollTo(sel);
      prPreviewNotes(sel);
      prClipOverlaps();
      writePianorollCall();
      drawPianoroll();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!sel.length) return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      prTouch(sel);
      if (e.shiftKey) {
        // Shift is Live's length nudge: the onset stays put and the END moves one cell - right
        // lengthens, left shortens back down to a single cell. It nudges the length you can SEE
        // (the clipped one), same as dragging the visible right edge does.
        const cols = prMetrics().cols;
        for (const n of sel) n.full = Math.max(1, Math.min(n.len + dir, cols - n.start));
      } else {
        for (const n of sel) n.start = Math.min(prState.len - 1, Math.max(0, n.start + dir));
      }
      prClipOverlaps();
      writePianorollCall();
      drawPianoroll();
    }
  });
  // keep the cursor in sync when the cmd/ctrl modifier is pressed/released over a note
  // Re-derive the cursor for wherever the pointer already is - the tool or the cmd modifier can
  // change what it should be without the mouse moving at all. The default → real two-step (with a
  // reflow between) forces the change to actually land: browsers hide the pointer while you type,
  // and only a genuine cursor change brings it back before the next mouse move.
  prRefreshCursor = (velMod = false) => {
    if (!prState || prPointer.px < 0 || drag) return;
    const next = prCursorFor(prPointer.px, prPointer.py, prMetrics(), velMod);
    prCanvas.style.cursor = 'default';
    void prCanvas.offsetHeight;
    prCanvas.style.cursor = next;
  };
  const refreshCursor = (e) => prRefreshCursor(e.metaKey || e.ctrlKey);
  prCanvas.addEventListener('keyup', (e) => { prPreviewOff(); refreshCursor(e); });
  prCanvas.addEventListener('keydown', refreshCursor);
  prCanvas.addEventListener('blur', prPreviewOff);
  prCanvas.addEventListener('pointerleave', () => { prPointer = { px: -1, py: -1 }; });
}

// The panel's own controls hand the keyboard straight back to the grid. Clicking `len` (or a
// toolbar button) moves focus into that widget, and every one of the roll's keys - cmd-A for all
// notes, the arrows, delete, B - lives on the canvas; without this, editing the loop length quietly
// turned cmd-A back into "select the whole buffer".
const prRefocus = () => { if (prState) prCanvas.focus({ preventScroll: true }); };

function initPianorollEditor() {
  // Opening is initWidgetHandles' job (double-click the name). Closing is the ✕, Escape, or the
  // call itself leaving the buffer - see syncPianorollFromCode.
  cm.on('change', syncPianorollFromCode); // hand edits to the open call flow back into the panel

  // grid (granularity) and len (loop length in cells) are independent - changing the grid just
  // reinterprets each cell as a coarser/finer note; it doesn't move notes or resize the loop.
  prGridSelect.addEventListener('change', () => {
    if (!prState) return;
    prState.grid = Math.max(1, Math.round(Number(prGridSelect.value) || 16));
    writePianorollCall();
    drawPianoroll();
    prRefocus();
  });
  prLenInput.addEventListener('change', () => {
    if (!prState) return;
    prState.len = Math.max(1, Math.round(Number(prLenInput.value) || prState.grid));
    prLenInput.value = prState.len;
    writePianorollCall();
    drawPianoroll();
    prRefocus();
  });

  const reflectTool = () => { prToolBtn.textContent = prTool === 'draw' ? '✏️' : '⬚'; prToolBtn.title = `tool: ${prTool} — click or press B to switch (draw = pencil, select = marquee)`; };
  const toggleTool = () => {
    prTool = prTool === 'draw' ? 'select' : 'draw';
    localStorage.setItem('poptartPianorollTool', prTool);
    reflectTool();
    prRefreshCursor(); // pencil ⇄ crosshair right away, without waiting for the pointer to move
  };
  reflectTool();
  // The button click, not toggleTool itself: B is also handled document-wide (below), and that
  // path must leave the caret wherever it was.
  prToolBtn.addEventListener('click', () => { toggleTool(); prRefocus(); });

  const reflectCmdMode = () => { prCmdModeBtn.textContent = prCmdMode; prCmdModeBtn.title = `the value lane and cmd-drag set ${prCmdMode === 'vel' ? 'velocity' : 'probability'} — click to switch`; };
  reflectCmdMode();
  prCmdModeBtn.addEventListener('click', () => {
    prCmdMode = prCmdMode === 'vel' ? 'prob' : 'vel';
    localStorage.setItem('poptartPianorollCmd', prCmdMode);
    reflectCmdMode();
    if (prState) drawPianoroll(); // the value lane shows the newly chosen channel
    prRefocus();
  });

  // Clicking the scale chip snaps every note in the roll into the key - the same nearest-tone
  // quantize `.scale()`/`.sc()` apply to a note pattern, so a drawn line and a written one land on
  // the same pitches. One history entry, so cmd-Z puts the out-of-key notes back.
  prScaleLabel.addEventListener('click', () => {
    if (!prState || !prScaleInfo()) return;
    prRefocus();
    const live = prLiveNotes(prState.notes);
    const snapped = live.map((nt) => notesMod.quantizeToScale(nt.midi, patchScale));
    const moved = snapped.filter((midi, i) => midi !== live[i].midi).length;
    if (!moved) { logLine(`every note is already in ${patchScale}`); return; }
    live.forEach((nt, i) => { nt.midi = snapped[i]; });
    prClipOverlaps(); // snapping can land two notes in one lane
    writePianorollCall();
    drawPianoroll();
    logLine(`snapped ${moved} note${moved === 1 ? '' : 's'} to ${patchScale}`);
  });

  // Fold: show only the global scale's lanes. Sticky like the tool and cmd mode, but it needs a
  // scale to fold to - without one the button says so rather than silently doing nothing.
  const reflectFold = () => {
    prFoldBtn.classList.toggle('active', prFold);
    prFoldBtn.title = prFold
      ? 'showing only the scale’s notes — click to show every semitone'
      : 'fold to the scale set by setscale() — click to show only its notes';
  };
  reflectFold();
  prFoldBtn.addEventListener('click', () => {
    if (!prFold && !prScaleInfo()) {
      logLine('fold needs a scale — put setscale("F minor") in the buffer', true);
      return;
    }
    prFold = !prFold;
    localStorage.setItem('poptartPianorollFold', prFold ? '1' : '0');
    reflectFold();
    if (prState) prSetFold(prFold);
    prRefocus();
  });

  const reflectPreview = () => prPreviewBtn.classList.toggle('active', prPreviewEnabled);
  reflectPreview();
  prPreviewBtn.addEventListener('click', () => {
    prPreviewEnabled = !prPreviewEnabled;
    localStorage.setItem('poptartPianorollPreview', prPreviewEnabled ? '1' : '0');
    if (!prPreviewEnabled) prPreviewOff();
    reflectPreview();
    prRefocus();
  });

  prToMiniBtn.addEventListener('click', () => {
    if (!prState) return;
    const range = prState.marker.find();
    if (!range) return;
    const indent = (cm.getLine(range.from.line).match(/^\s*/)?.[0]) ?? ''; // align continuation lines
    // Folded to the key, the roll is being drawn IN that key, so it's written out in it: scale
    // degrees plus a `.sc(octave)`, which re-keys with the setscale line instead of freezing the
    // pitches that happened to be under the pencil. Unfolded, the roll is chromatic and so is what
    // it converts to.
    const scale = prState.fold && prScaleInfo() ? patchScale : null;
    const expr = pianorollMod.pianoRollToMini(prLiveNotes(prState.notes), { grid: prState.grid, len: prState.len, indent, scale });
    // Degrees can only name notes that are IN the key, so anything out of it lands on its nearest
    // neighbour - a real pitch change, and the one thing about this rewrite that isn't lossless.
    // Counted before the close, which drops the notes.
    // Muted notes aren't written out at all, so they can't be moved by the rounding either.
    const off = scale ? prLiveNotes(prState.notes).filter((nt) => !nt.mute && notesMod.quantizeToScale(nt.midi, scale) !== nt.midi).length : 0;
    prSuppressCursor = true;
    cm.replaceRange(expr, range.from, range.to);
    closePianorollEditor(); // the pianoroll() call is gone now
    prSuppressCursor = false;
    prScheduleEval(); // the rewrite plays the same notes - keep the running track in step with it
    if (!scale) logLine('piano roll → mini-notation');
    else if (!off) logLine(`piano roll → mini-notation (degrees in ${scale})`);
    else logLine(`piano roll → mini-notation (degrees in ${scale}) - ${off} out-of-key note${off === 1 ? '' : 's'} moved to the nearest degree`, true);
  });

  prCloseBtn.addEventListener('click', () => closePianorollEditor());

  // Click anywhere off the panel - the code, the console, the toolbar - and the roll gets out of
  // the way: it's a big opaque thing parked over the buffer, and reaching for the code you were
  // writing is the same gesture as dismissing it. Capture phase, so a click that never bubbles
  // still counts. Reopening is unaffected: the double-click on the `pianoroll` name lands outside
  // the panel too, but its second mousedown reaches openWidgetAt, which opens the roll again.
  document.addEventListener('pointerdown', (e) => {
    if (prState && !prPanel.contains(e.target)) closePianorollEditor();
  }, true);

  // Panel-wide keys while it's open: Escape (when the code has focus - the canvas handles its own),
  // B toggles the tool, and cmd/ctrl +/- zoom the roll (overriding the browser's page zoom).
  //
  // Capture phase, and the code editor deliberately doesn't count as "typing": while the roll is
  // open B belongs to the roll, wherever focus happens to be. Otherwise B typed with focus still in
  // the editor (where it lands after clicking the pianoroll name) went into the buffer instead, and
  // the resulting edit moved the cursor off the name and closed the panel. Only real form fields -
  // the panel's own grid/len inputs - still swallow it.
  const typingInField = () => {
    const el = document.activeElement;
    if (!el || cm.getWrapperElement().contains(el)) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
  };
  document.addEventListener('keydown', (e) => {
    if (!prState) return;
    if (e.key === 'Escape' && document.activeElement !== prCanvas) { closePianorollEditor(); return; }
    if ((e.key === 'b' || e.key === 'B') && !typingInField() && !(e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation(); // don't let it reach the code editor as a keystroke
      toggleTool();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_')) {
      e.preventDefault();
      prZoomBy(e.key === '-' || e.key === '_' ? 1 / PR_BTN_ZOOM : PR_BTN_ZOOM);
    }
  }, true);

  initPianorollCanvas();
}

// ---------------------------------------------------------------------------------------------
// Live playback highlighting - light up the mini-notation atom currently sounding.
//
// The scheduler's timebase is wall-clock: cyclePos = Date.now()/1000 * cps (see
// Scheduler#start and OscEngine#getTime), and browser + server share the machine clock, so the
// client can compute the playing step locally with no polling. At eval time we find every
// mini-notation string literal in the evaluated code, parse it with the same parser the server
// uses, and pin a CodeMirror marker over it (markers track position through later edits). A
// ~30fps ticker then asks each parsed pattern which atoms are sounding at the current cycle
// position and marks their source ranges.
// ---------------------------------------------------------------------------------------------

// Authoritative clock state comes back from each /api/evaluate: cyclePos isn't simply
// t*cps once setbpm() has run, so the server sends its Transport's {cps, baseSec, baseCycle}
// and we mirror the same rebased formula. (A tempo *signal* keeps changing cps between evals;
// highlighting then drifts until the next eval - known, cosmetic.)
// Starts paused at cycle 0 - the server's clock only advances while something is playing.
let transport = { cps: 0.5, baseSec: 0, baseCycle: 0, paused: true };
let playing = false;
// Playback highlighting is driven by the step grid the SERVER computes from each active track's
// real evaluated Sig (see server.js highlightGrid) - the exact grid the scheduler plays, so every
// transform in the method chain (.fast/.slow/.when/degrade/…) is reflected without the browser
// re-guessing from source text. Each region: an anchor marker at the track's block (highlights are
// placed relative to it, so they survive edits until re-eval), the grid indexed by cycle, and the
// longest ring so lookback catches a stretched/held note still sounding from an earlier cycle.
let patternRegions = []; // { label, anchor, grid: Map<cycle, steps>, maxEnd, lastKey, marks: [] }
let gridFrom = 0; // first cycle covered by every region's grid
let gridTo = 0; // one past the last covered cycle (extended by /api/highlight top-ups)
let gridCount = 32; // window size the server ships (mirrored from the eval response)
let gridFetching = false; // a top-up request is in flight - don't stack another

function clearPatternRegions() {
  for (const r of patternRegions) {
    r.anchor.clear();
    for (const mk of r.marks) mk.clear();
  }
  patternRegions = [];
}

// Builds the per-track highlight regions from an /api/evaluate response: each active track carries
// its grid (sounding steps per cycle, atom spans block-relative) plus its block [start,end], which
// we anchor a marker to so highlights track edits until the next eval. No source-text parsing - the
// server already did the real evaluation.
function setupHighlighting(tracks, from, count) {
  clearPatternRegions();
  gridFrom = from;
  gridTo = from + count;
  gridCount = count;
  gridFetching = false;
  for (const t of tracks) {
    if (!t.active || !t.grid) continue;
    const anchor = cm.markText(cm.posFromIndex(t.start), cm.posFromIndex(t.end), {});
    const region = { label: t.label, anchor, grid: new Map(), maxEnd: 1, lastKey: '', marks: [] };
    ingestGrid(region, t.grid);
    patternRegions.push(region);
  }
}

// Folds a grid window ([{ cycle, steps }]) into a region, tracking the longest step end so the
// look-back in highlightTick reaches a note still ringing from an earlier cycle (clip/tie/echo).
function ingestGrid(region, grid) {
  for (const g of grid) {
    region.grid.set(g.cycle, g.steps);
    for (const s of g.steps) if (s.end > region.maxEnd) region.maxEnd = s.end;
  }
}

// Request the next grid window as the clock nears the end of what we hold - patterns that vary per
// cycle (<…>, r/i, degrade, choice) outrun the initial window. Coarse: one request per window, not
// per frame. Deterministic on the server, so the extension lines up seamlessly.
const GRID_PREFETCH = 8; // cycles of headroom before the covered end that triggers a top-up
function maybePrefetchGrid(cycle) {
  if (gridFetching || patternRegions.length === 0) return;
  if (cycle < gridTo - GRID_PREFETCH) return;
  gridFetching = true;
  const from = gridTo;
  api('GET', `/api/highlight?from=${from}&count=${gridCount}`)
    .then((res) => {
      const byLabel = new Map(res.tracks.map((t) => [t.label, t.grid]));
      // Drop cycles well behind the play head so a set-and-forget pattern doesn't grow the grid
      // forever; kept margin (2 windows) stays clear of the bounded look-back for ringing tails.
      const pruneBefore = res.gridFrom - gridCount * 2;
      for (const r of patternRegions) {
        const grid = byLabel.get(r.label);
        if (grid) ingestGrid(r, grid);
        for (const c of r.grid.keys()) if (c < pruneBefore) r.grid.delete(c);
      }
      gridFrom = Math.max(gridFrom, pruneBefore);
      gridTo = Math.max(gridTo, res.gridFrom + res.gridCount);
    })
    .catch(() => {})
    .finally(() => {
      gridFetching = false;
    });
}

// The transport mirror as a cycle position "now" - the same rebased formula the server uses.
// A paused transport is frozen at baseCycle (0 after a stop / at page load).
function currentCyclePos() {
  if (transport.paused) return transport.baseCycle;
  return transport.baseCycle + (Date.now() / 1000 - transport.baseSec) * transport.cps;
}

function highlightTick() {
  if (!playing || patternRegions.length === 0) return;
  const cyclePos = currentCyclePos();
  const cycle = Math.floor(cyclePos);
  maybePrefetchGrid(cycle);

  for (const r of patternRegions) {
    const range = r.anchor.find();
    if (!range) continue; // the block was deleted from the buffer

    // A step (start/end are cycle fractions) sounds at cyclePos when it falls in [cyc+start,
    // cyc+end). `end` may exceed 1 - a clip-stretched, held, or echoed note rings past its own
    // cycle - so look back far enough (bounded by the region's longest ring) to keep a tail from
    // an earlier cycle lit. Locations recur (chords, revisited alt picks), so dedupe by span.
    const locs = new Map();
    const lookback = Math.min(64, Math.ceil(r.maxEnd));
    for (let k = 0; k <= lookback; k++) {
      const cyc = cycle - k;
      if (cyc < gridFrom) break; // nothing loaded before the window start
      const steps = r.grid.get(cyc);
      if (!steps) continue;
      for (const s of steps) {
        if (cyclePos >= cyc + s.start && cyclePos < cyc + s.end) {
          for (const l of s.locs) locs.set(l[0] + '-' + l[1], l);
        }
      }
    }

    const key = [...locs.keys()].sort().join(',');
    if (key === r.lastKey) continue; // same atoms still sounding - don't churn marks
    r.lastKey = key;
    for (const mk of r.marks) mk.clear();
    const base = cm.indexFromPos(range.from);
    r.marks = [...locs.values()].map((loc) =>
      cm.markText(cm.posFromIndex(base + loc[0]), cm.posFromIndex(base + loc[1]), {
        className: 'cm-playing',
      })
    );
  }
}
setInterval(() => {
  highlightTick();
  updatePhraseViz();
  updateRecButton();
  updateRecordButton();
}, 33);

function stopHighlighting() {
  playing = false;
  updateTransportButtons();
  for (const r of patternRegions) {
    for (const mk of r.marks) mk.clear();
    r.marks = [];
    r.lastKey = '';
  }
}

// ---------------------------------------------------------------------------------------------
// Phrase position - four clock-face circles in the header, one per cycle of the 4-cycle
// phrase. The current cycle's circle fills around its circumference; completed cycles stay
// full rings; everything resets when the phrase (cycle % 4) wraps. Driven from the same
// transport mirror as playback highlighting, so it needs no polling.
// ---------------------------------------------------------------------------------------------

const PHRASE_CYCLES = 4;
const phraseViz = document.getElementById('phraseViz');
for (let i = 0; i < PHRASE_CYCLES; i++) {
  phraseViz.insertAdjacentHTML(
    'beforeend',
    '<svg class="phrase-c" viewBox="0 0 16 16"><circle class="ring" cx="8" cy="8" r="6"></circle><circle class="arc" cx="8" cy="8" r="6" pathLength="1"></circle></svg>',
  );
}
const phraseArcs = [...phraseViz.querySelectorAll('.arc')];

function updatePhraseViz() {
  const active = playing || recState != null;
  phraseViz.classList.toggle('rec', recState != null);
  const pos = currentCyclePos();
  const cycle = Math.floor(pos);
  const idx = ((cycle % PHRASE_CYCLES) + PHRASE_CYCLES) % PHRASE_CYCLES;
  const phase = pos - cycle;
  phraseArcs.forEach((arc, i) => {
    const p = !active ? 0 : i < idx ? 1 : i === idx ? phase : 0;
    arc.style.strokeDasharray = `${p} 1`;
  });
}

// ---------------------------------------------------------------------------------------------
// MIDI record - capture what's being played on a midikeys() route and write it back into the
// code as a `<...>*n`.as("note:vel:clip") pattern, replacing the kb()/midikeys() call. The
// server owns the recording window (/api/midiRecord/*): it arms at the next 4-cycle phrase
// boundary (the wait is the count-in - watch the circles), records for the chosen number of
// cycles at the chosen grid, and serves the converted pattern; this side polls for it, edits
// the buffer, and re-evaluates so the loop takes over from the live keys seamlessly.
// ---------------------------------------------------------------------------------------------

const recBtn = document.getElementById('recBtn');
const recOptsBtn = document.getElementById('recOptsBtn');
const recPanel = document.getElementById('recPanel');
const recCycles = document.getElementById('recCycles');
const recGrid = document.getElementById('recGrid');

let recState = null; // latest /api/midiRecord status while armed/recording, else null
let recPollTimer = null;

recOptsBtn.addEventListener('click', () => recPanel.classList.toggle('hidden'));
recBtn.addEventListener('click', () => (recState ? cancelMidiRecord(true) : startMidiRecord()));

async function startMidiRecord() {
  recPanel.classList.add('hidden');
  try {
    recState = await api('POST', '/api/midiRecord/start', {
      cycles: Number(recCycles.value),
      grid: Number(recGrid.value),
    });
    if (recState.transport) transport = recState.transport;
    recPollTimer = setInterval(pollMidiRecord, 300);
    logLine(
      `midi record armed: ${recState.cycles} cycle(s), quantize ${recGrid.selectedOptions[0].textContent} - recording starts when the phrase ends`,
    );
  } catch (e) {
    recState = null;
    logLine(e.message ?? String(e), true);
  }
}

async function cancelMidiRecord(log = false) {
  clearInterval(recPollTimer);
  recPollTimer = null;
  recState = null;
  try {
    await api('POST', '/api/midiRecord/cancel');
  } catch {
    // server may already be idle - nothing to clean up
  }
  if (log) logLine('midi record cancelled');
}

async function pollMidiRecord() {
  try {
    const s = await api('GET', '/api/midiRecord/status');
    if (s.transport) transport = s.transport;
    if (s.phase === 'done') {
      clearInterval(recPollTimer);
      recPollTimer = null;
      recState = null;
      api('POST', '/api/midiRecord/cancel').catch(() => {}); // ack: clear the served results
      applyRecording(s.results ?? []);
    } else if (s.phase === 'idle') {
      // server restarted / lost the recording
      clearInterval(recPollTimer);
      recPollTimer = null;
      recState = null;
      logLine('midi record: the server dropped the recording', true);
    } else {
      recState = s;
    }
  } catch {
    // transient fetch error - keep polling
  }
}

function updateRecButton() {
  if (!recState) {
    if (recBtn.textContent !== '● rec') recBtn.textContent = '● rec';
    recBtn.classList.remove('rec-armed', 'rec-live');
    return;
  }
  const pos = currentCyclePos();
  if (pos < recState.startCycle) {
    recBtn.textContent = `● in ${Math.max(0, recState.startCycle - pos).toFixed(1)}`;
    recBtn.classList.add('rec-armed');
    recBtn.classList.remove('rec-live');
  } else {
    recBtn.textContent = `● ${Math.min(recState.cycles, pos - recState.startCycle).toFixed(1)}/${recState.cycles}`;
    recBtn.classList.add('rec-live');
    recBtn.classList.remove('rec-armed');
  }
}

function applyRecording(results) {
  if (!results.length) {
    logLine('midi record: no notes were played during the recording window', true);
    return;
  }
  let applied = 0;
  for (const r of results) {
    if (r.error) {
      logLine(`midi record (${r.label}): ${r.error}`, true);
      continue;
    }
    const spec = r.noteless ? 'vel:clip' : 'note:vel:clip'; // tap() records note-less
    const replacement = '`' + r.pattern + '`.as("' + spec + '")';
    if (replaceKbCall(r.label, replacement)) {
      applied++;
      logLine(`midi record: wrote ${r.count} ${r.noteless ? 'hit' : 'note'}(s) into "${r.label}"`);
    } else {
      logLine(
        `midi record (${r.label}): no midikeys/kb/keyboard/tap call found to replace - recorded pattern: ${r.pattern.replace(/\n\s*/g, ' ')}`,
        true,
      );
    }
  }
  if (applied) evaluate(true);
}

// Finds the live-keys call in the labeled block and swaps the whole call expression for the
// recorded pattern. Handles the MIDI routes - `midikeys("device")(ch)` directly, or `kb(ch)`
// through a `const kb = midikeys(...)` binding - and the computer-keyboard sources `keyboard()`
// and `tap()` (called directly, no channel). First candidate in the block wins.
function replaceKbCall(label, replacement) {
  if (!labelsMod) return false;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === label);
  if (!block) return false;

  const spanFrom = (callStart, openParenIdx) => {
    const close = matchParen(code, openParenIdx);
    return close < 0 ? null : [callStart, close + 1];
  };
  const spans = [];

  // Computer-keyboard sources: `keyboard()` / `tap()` used directly (they return a signal, so no
  // trailing channel call like midikeys). Match the whole `keyboard(...)` / `tap(...)` call.
  const kbCall = /(?<![.\w$])(?:keyboard|tap)\s*\(/g;
  let km;
  while ((km = kbCall.exec(code))) {
    if (km.index < block.start || km.index >= block.end) continue;
    const span = spanFrom(km.index, km.index + km[0].length - 1);
    if (span) spans.push(span);
  }

  const direct = /\bmidikeys\s*\(/g;
  let m;
  while ((m = direct.exec(code))) {
    if (m.index < block.start || m.index >= block.end) continue;
    const close1 = matchParen(code, m.index + m[0].length - 1);
    if (close1 < 0) continue;
    let j = close1 + 1;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '(') continue; // a bare midikeys(...) definition, not a played route
    const span = spanFrom(m.index, j);
    if (span) spans.push(span);
  }

  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*midikeys\s*\(/g;
  const names = new Set([...code.matchAll(declRe)].map((d) => d[1]));
  for (const name of names) {
    const call = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    while ((m = call.exec(code))) {
      if (m.index < block.start || m.index >= block.end) continue;
      const span = spanFrom(m.index, m.index + m[0].length - 1);
      if (span) spans.push(span);
    }
  }
  if (!spans.length) return false;

  spans.sort((a, b) => a[0] - b[0]);
  const [from, to] = spans[0];
  cm.replaceRange(replacement, cm.posFromIndex(from), cm.posFromIndex(to));
  removeChainedScale(from + replacement.length);
  return true;
}

// Recorded notes are absolute MIDI (live scale-quantization already happened engine-side), so
// a .scale() chained directly onto the replaced call would wrongly remap them as degrees -
// walk the method chain that follows the replacement and drop the first .scale(...) in it.
function removeChainedScale(idx) {
  const code = cm.getValue();
  let i = idx;
  for (;;) {
    let j = i;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '.') return;
    let k = j + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(k));
    if (!m) return;
    let p = k + m[0].length;
    while (p < code.length && /\s/.test(code[p])) p++;
    if (code[p] !== '(') return;
    const close = matchParen(code, p);
    if (close < 0) return;
    if (m[0] === 'scale') {
      cm.replaceRange('', cm.posFromIndex(j), cm.posFromIndex(close + 1));
      logLine('midi record: dropped the chained .scale() - the recorded notes are already absolute');
      return;
    }
    i = close + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Track record - bounce one block's audio to a file and play it back with sr().
//
// Two ways in, one mechanism. `.record({ cycles })` in a chain is a handle: click the `record`
// name (same rule as lfo/pianoroll - its arguments stay ordinary code) and a panel opens showing
// that track's live level, with the length and name to record under. ctrl+b skips all of it and
// bounces whichever block the cursor is in. Either way the server owns the window
// (/api/trackRecord/*): it arms at the next phrase boundary, records exactly `cycles` cycles of
// that track's post-fader output, trims and files the result, and hands back a name.
//
// What comes back is written into the buffer the way a freeze reads: the source block is muted
// (`bass:` -> `_bass:`) and a new block with the SAME label goes in under it playing the bounce,
// so the track keeps its place in the mix and unmuting one line puts the original back. Note this
// does not free the plugin - it stays loaded in the track's slot, ready for that unmute.
// ---------------------------------------------------------------------------------------------

const recordPanel = document.getElementById('recordPanel');
const recordCanvas = document.getElementById('recordCanvas');
const recordLabelEl = document.getElementById('recordLabel');
const recordCycles = document.getElementById('recordCycles');
const recordName = document.getElementById('recordName');
const recordWrapTail = document.getElementById('recordWrapTail');
const recordGo = document.getElementById('recordGo');
const recordAgain = document.getElementById('recordAgain');
const recordStatus = document.getElementById('recordStatus');
const recordClose = document.getElementById('recordClose');

let recordState = null; // { marker, callStart, label, cycles, name, wrapTail } while a panel is open
let recordSuppressCursor = false;
let trackRecState = null; // latest /api/trackRecord status while armed/recording, else null
let trackRecPoll = null;
// Rolling meter history, newest last - what the panel draws while idle/armed. Each entry is
// { v: peak, rms, rec: true while it fell inside the recording window }, so the live view can
// show WHICH part of what you're watching is the take.
let recordScope = [];
let recordWave = null; // peaks of the finished bounce, drawn instead of the meter once there is one
let recordWaveRms = null; // matching rms per bucket - the body drawn inside the peak envelope
let recordWaveBands = null; // matching [low, mid, high] balance per bucket - what colours it
let recordWaveCycles = 0; // how many cycles that finished take spans, for its gridlines
// The engine meters 20x/sec and every reading is kept, so this is the last ~30 seconds of the
// track - long enough that a whole phrase plus its count-in is on screen at once.
const RECORD_SCOPE_LEN = 600;
const RECORD_EVAL_DEBOUNCE_MS = 150;
// Ceiling on the display gain a finished take is drawn with (see drawRecordScope). Past this a
// take is quiet enough that magnifying it further just draws the noise floor as a waveform.
const RECORD_MAX_NORM = 24;

// The .record(...) call containing idx, plus whether idx is on the *handle* that opens the panel -
// the `record` name itself. Same rule as lfo's and pianoroll's: the options are code you may want
// to edit by hand, so they are never a handle. (ctrl+b uses the containing call regardless of the
// handle, to pick up the options of whatever block the cursor is in.)
function findRecordCallAt(code, idx) {
  return findNamedCallAt(code, idx, /\.\s*record\s*\(/g, 'record');
}

// The options as the panel holds them. Deliberately forgiving: this reads code the user may be
// halfway through typing, so anything unparseable falls back to the default rather than throwing.
function parseRecordCall(inner) {
  const cycles = Math.max(1, Math.round(Number((/cycles\s*:\s*(\d+)/.exec(inner) ?? [])[1] ?? 4) || 4));
  const name = (/name\s*:\s*['"]([^'"]*)['"]/.exec(inner) ?? [])[1] ?? '';
  return { cycles, name, wrapTail: /wrapTail\s*:\s*true/.test(inner) };
}

function serializeRecordCall({ cycles, name, wrapTail }) {
  const parts = [`cycles: ${cycles}`];
  if (name) parts.push(`name: "${name}"`);
  if (wrapTail) parts.push('wrapTail: true');
  return `.record({ ${parts.join(', ')} })`;
}

// The label of the block a call lives in - the engine track the panel meters and bounces.
function blockLabelAt(idx) {
  if (!labelsMod) return null;
  return labelsMod.splitLabeledBlocks(cm.getValue()).find((b) => idx >= b.start && idx <= b.end)?.label ?? null;
}

function openRecordPanel(call) {
  const code = cm.getValue();
  const label = blockLabelAt(call.start);
  if (!label) return;
  showRecordPanel(label, parseRecordCall(code.slice(call.open + 1, call.close)), {
    marker: cm.markText(cm.posFromIndex(call.start), cm.posFromIndex(call.close + 1), {}),
    callStart: call.start,
  });
}

/**
 * Show the panel on `label`. `anchor` is the `.record(...)` call the panel writes its settings back
 * into - absent for a ctrl+b bounce, which has no call to write to. Without one the panel is
 * read-only about the code and exists to show the count-in, the meter, and the result: the visible
 * confirmation a hotkey otherwise wouldn't get.
 */
function showRecordPanel(label, opts, anchor = null) {
  if (recordState?.marker) recordState.marker.clear();
  if (recordState && recordState.label !== label) setRecordTap(recordState.label, false);
  recordState = { marker: null, callStart: null, ...anchor, label, ...opts };
  recordLabelEl.textContent = label;
  syncRecordControls();
  recordCycles.value = recordState.cycles;
  recordName.value = recordState.name;
  recordWrapTail.checked = recordState.wrapTail;
  showLiveMeter();
  recordPanel.classList.remove('hidden');
  setRecordTap(label, true);
  startRecordPoll();
  drawRecordScope();
}

// Put the canvas back on the live signal, dropping whatever finished take it was showing.
function showLiveMeter() {
  recordScope = [];
  recordWave = null;
  recordWaveRms = null;
  recordWaveBands = null;
  recordWaveCycles = 0;
  recordAgain.classList.add('hidden');
  setRecordStatus('');
  drawRecordScope();
}

function closeRecordPanel() {
  if (recordState?.marker) recordState.marker.clear();
  // A bounce in flight keeps its own tap and its own polling - closing the panel must not cancel
  // the recording, only stop metering for it.
  if (recordState && trackRecState?.label !== recordState.label) setRecordTap(recordState.label, false);
  recordState = null;
  recordPanel.classList.add('hidden');
  if (!trackRecState) stopRecordPoll();
}

function setRecordTap(label, on) {
  api('POST', '/api/trackRecord/tap', { label, on }).catch(() => {
    // engine down, or the track isn't up yet - the meter just stays flat
  });
}

// Writing the options back into the code is what makes the code the source of truth, exactly as
// the lfo and piano roll panels do it. Re-evaluated on a debounce so a bounce started right after
// a length change records the length that's in the buffer.
function writeRecordCall() {
  if (!recordState?.marker) return; // a ctrl+b panel has no call to write into
  const range = recordState.marker.find();
  if (!range) return;
  const text = serializeRecordCall(recordState);
  recordSuppressCursor = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    recordState.marker.clear(); // replaceRange collapses it - re-pin over the fresh text
    const startIdx = cm.indexFromPos(range.from);
    recordState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    recordState.callStart = startIdx;
  } finally {
    recordSuppressCursor = false; // never leave it latched: that wedges the panel shut for good
  }
  clearTimeout(recordEvalTimer);
  recordEvalTimer = setTimeout(() => { recordEvalTimer = null; evaluate(false); }, RECORD_EVAL_DEBOUNCE_MS);
}
let recordEvalTimer = null;

// Hand edits to the open call flow back into the panel, so tweaking `cycles:` in the code updates
// it instead of being silently reverted by the next click.
function syncRecordFromCode() {
  if (!recordState?.marker || recordSuppressCursor) return;
  const range = recordState.marker.find();
  // The call went out of the buffer under the panel (deleted, or edited into something that is no
  // longer a .record call) - there is nothing to write settings back into, so the panel goes too.
  if (!range) { closeRecordPanel(); return; }
  const text = cm.getRange(range.from, range.to);
  if (!/^\s*\.\s*record\s*\(/.test(text)) { closeRecordPanel(); return; }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now
  const parsed = parseRecordCall(text.slice(open + 1, close));
  recordState.callStart = cm.indexFromPos(range.from);
  Object.assign(recordState, parsed);
  recordCycles.value = parsed.cycles;
  recordName.value = parsed.name;
  recordWrapTail.checked = parsed.wrapTail;
}

// --- the bounce itself ---

async function startTrackRecord(label, { cycles, name, wrapTail } = {}) {
  if (trackRecState) return cancelTrackRecord(true);
  try {
    trackRecState = await api('POST', '/api/trackRecord/start', {
      label,
      cycles: cycles ?? (Number(recordCycles.value) || 4),
      name: name ?? '',
      wrapTail: !!wrapTail,
    });
    if (trackRecState.transport) transport = trackRecState.transport;
    showLiveMeter(); // watch the signal go in, not the last take
    startRecordPoll();
    logLine(`bounce armed on "${label}": ${trackRecState.cycles} cycle(s) - starts when the phrase ends`);
  } catch (e) {
    trackRecState = null;
    logLine(e.message ?? String(e), true);
  }
}

async function cancelTrackRecord(log = false) {
  trackRecState = null;
  if (!recordState) stopRecordPoll();
  try {
    await api('POST', '/api/trackRecord/cancel');
  } catch {
    // server may already be idle - nothing to clean up
  }
  if (log) logLine('bounce cancelled');
}

function startRecordPoll() {
  if (trackRecPoll) return;
  trackRecPoll = setInterval(pollTrackRecord, 100);
}

function stopRecordPoll() {
  clearInterval(trackRecPoll);
  trackRecPoll = null;
  recordScope = [];
}

async function pollTrackRecord() {
  let s;
  try {
    s = await api('GET', '/api/trackRecord/status');
  } catch {
    return; // transient fetch error - keep polling
  }
  if (s.transport) transport = s.transport;
  // The meter runs whether or not anything is armed - that's what makes an open panel show the
  // signal coming into it. `levels` covers every tapped track, so an idle panel meters too.
  if (recordState) {
    // Every reading the engine took since the last poll, not just the newest - the queue is what
    // keeps the live waveform at the engine's resolution instead of the poll's.
    const readings = s.levels?.[recordState.label] ?? [];
    for (const r of readings.length ? readings : [{ peak: 0, rms: 0 }]) {
      recordScope.push({
        v: r.peak ?? 0,
        rms: r.rms ?? 0,
        // Only what actually landed inside the window is the take - the count-in and everything
        // before it is just the track playing.
        rec: s.phase === 'recording',
      });
    }
    while (recordScope.length > RECORD_SCOPE_LEN) recordScope.shift();
    if (!recordWave) drawRecordScope();
  }
  if (s.phase === 'idle') {
    if (trackRecState) {
      trackRecState = null;
      logLine('bounce: the server dropped the recording', true);
      if (!recordState) stopRecordPoll();
    }
    return;
  }
  if (s.phase === 'done') {
    trackRecState = null;
    api('POST', '/api/trackRecord/cancel').catch(() => {}); // ack: clears the served result
    if (!recordState) stopRecordPoll();
    if (s.error) {
      setRecordStatus(`✕ ${s.error}`, 'bad');
      logLine(`bounce (${s.label}): ${s.error}`, true);
    } else if (s.result) {
      applyBounce(s.label, s.result);
    }
    return;
  }
  trackRecState = s;
  updateRecordButton();
}

// The settings are locked in the moment a bounce is armed - the window's length and where it
// starts are already decided by then, so an edit during the count-in would describe a take that
// isn't the one being made. Also inert when the panel has no `.record()` call to write back into
// (a ctrl+b panel), where a change would silently vanish. CSS greys them either way.
function syncRecordControls() {
  const locked = !recordState?.marker || !!trackRecState;
  for (const el of [recordCycles, recordName, recordWrapTail]) {
    if (el.disabled !== locked) el.disabled = locked;
  }
}

function updateRecordButton() {
  syncRecordControls();
  if (!trackRecState) {
    recordGo.textContent = '● bounce';
    recordGo.classList.remove('rec-armed', 'rec-live');
    return;
  }
  const pos = currentCyclePos();
  if (pos < trackRecState.startCycle) {
    recordGo.textContent = `● in ${Math.max(0, trackRecState.startCycle - pos).toFixed(1)}`;
    recordGo.classList.add('rec-armed');
    recordGo.classList.remove('rec-live');
  } else {
    recordGo.textContent = `● ${Math.min(trackRecState.cycles, pos - trackRecState.startCycle).toFixed(1)}/${trackRecState.cycles}`;
    recordGo.classList.add('rec-live');
    recordGo.classList.remove('rec-armed');
  }
}

// --- writing the result into the buffer ---

// Mute the block that was bounced and add one below it playing the recording. Both carry the same
// label on purpose: the bounce takes the original's place on that engine track. Only one of the
// two may be live at a time - two active blocks sharing a label would collide on one scheduler -
// which is exactly what the mute guarantees.
function applyBounce(label, result) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = labelsMod.splitLabeledBlocks(code).find((b) => b.label === label && !b.muted);
  if (!block) {
    logLine(`bounce: recorded "${result.name}" but couldn't find the "${label}" block to replace - play it with sr("${result.name}").slow(${result.cycles})`, true);
    return;
  }
  if (result.silent) {
    logLine(`bounce (${label}): recorded ${result.cycles} cycle(s) of silence - check the track wasn't muted or its output routed away`, true);
  }

  // The label lives at the very start of the block; muting is one character in front of it.
  const labelIdx = code.indexOf(`${label}:`, block.start);
  if (labelIdx < 0 || labelIdx > block.end) return;
  const blockEnd = trimmedBlockEnd(code, block);
  const indent = /^[^\S\n]*/.exec(code.slice(block.start))[0];
  const replacement = `\n${indent}${label}: sr("${result.name}").slow(${result.cycles})`;

  // End first, so inserting below doesn't shift the label's own offset out from under the mute.
  cm.replaceRange(replacement, cm.posFromIndex(blockEnd), cm.posFromIndex(blockEnd));
  cm.replaceRange('_', cm.posFromIndex(labelIdx), cm.posFromIndex(labelIdx));

  const summary = `saved as "${result.name}" · ${result.cycles} cycles · ${result.seconds.toFixed(2)}s`;
  setRecordStatus(`✓ ${summary}`, result.silent ? 'bad' : 'ok');
  logLine(`bounce: "${label}" ${summary} - muted the source and added sr("${result.name}").slow(${result.cycles})`);
  // Swap the panel to the finished take: what it captured is the thing you now want to look at,
  // and it stays there until you record again or reopen the panel.
  recordWave = result.peaks ?? null;
  recordWaveRms = result.rms ?? null;
  recordWaveBands = result.bands ?? null;
  recordWaveCycles = result.cycles;
  recordAgain.classList.remove('hidden');
  drawRecordScope();
  evaluate(true);
}

// The panel's one-line outcome. Empty clears it (the row collapses via :empty), so nothing
// permanent sits under the controls.
function setRecordStatus(text, kind) {
  recordStatus.textContent = text ?? '';
  recordStatus.classList.toggle('ok', kind === 'ok');
  recordStatus.classList.toggle('bad', kind === 'bad');
}

// Where the new block goes: after the bounced block's last line of actual content, not after the
// blank lines that happen to be filed with it (splitLabeledBlocks keeps trailing blanks with the
// block above so offsets stay aligned). Otherwise the bounce lands a paragraph away from what it
// replaces.
function trimmedBlockEnd(code, block) {
  let end = Math.min(block.end, code.length);
  while (end > block.start && /\s/.test(code[end - 1])) end--;
  return end;
}

// --- the meter / waveform canvas ---

// A theme colour at a given alpha. Canvas gradients don't take `color-mix`, and the theme's
// --accent may be a hex or an rgb(), so let the canvas itself normalize it and rebuild from the
// channels. Falls back to the colour as given if it normalized to something unexpected.
function rgbaFrom(ctx, color, alpha) {
  const prev = ctx.fillStyle;
  ctx.fillStyle = color;
  const norm = ctx.fillStyle;
  ctx.fillStyle = prev;
  if (/^#[0-9a-f]{6}$/i.test(norm)) {
    const n = parseInt(norm.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(norm);
  if (m) {
    const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return norm;
}

// A rekordbox-style mirrored envelope: one filled shape around the centre line rather than a
// picket fence of bars, with the loud part of the range shaded brighter, so the panel reads as a
// waveform at a glance. Drawn from a plain peak-per-bucket array either way - live (a scrolling
// meter history, newest at the right) or finished (the whole take, left to right).
function drawRecordScope() {
  const ctx = recordCanvas.getContext('2d');
  const { width: w, height: h } = recordCanvas;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#6cf';
  const hot = css.getPropertyValue('--err').trim() || accent;
  const dim = css.getPropertyValue('--border').trim() || '#444';
  const mid = h / 2;
  const maxAmp = mid - 6;
  ctx.clearRect(0, 0, w, h);

  // Once a bounce has finished the panel shows what it captured rather than what is playing now:
  // the whole take at a glance is the answer to "did that record what I meant?".
  const data = recordWave ?? recordScope;
  const live = !recordWave;

  // Cycle gridlines behind the wave - a bounce is a loop, so where the bars fall is the first
  // thing worth checking about it. Only for a finished take, whose x axis IS the cycle count.
  if (!live && recordWaveCycles > 1) {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    const cycles = recordWaveCycles;
    for (let c = 1; c < cycles; c++) {
      const x = Math.round((c / cycles) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, h - 6);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  if (!data.length) return;

  const clamp01 = (v) => Math.min(1, Math.max(0, v ?? 0));
  // Two envelopes: the peak (outer, translucent) and the rms body inside it. Peak alone saturates
  // on anything busy and reads as a solid block - the rms is where the dynamics actually show.
  const at = (i) => clamp01(live ? data[i]?.v : data[i]);
  const rmsAt = (i) => clamp01(live ? data[i]?.rms : recordWaveRms?.[i]);
  const colW = w / data.length;
  const x = (i) => i * colW;

  // A finished take is drawn NORMALIZED - its own loudest moment reaches the top of the panel -
  // with the true peak printed in the corner. A bounce that peaked at -18 dBFS is a perfectly good
  // take, and drawn to absolute scale it's a flat line two pixels tall that says nothing about
  // what's in it; the dB readout is what says how loud it actually was. The live meter is left
  // alone: that one IS a level meter, and a level meter that rescales itself tells you no level.
  const truePeak = live ? 1 : data.reduce((mx, v) => Math.max(mx, v ?? 0), 0);
  const norm = live || truePeak < 0.0005 ? 1 : Math.min(RECORD_MAX_NORM, 1 / truePeak);
  const ampOf = (v) => Math.min(1, v * norm) * maxAmp;

  // While live, shade the stretch that is actually being captured, so the part of what you're
  // watching that is the take is obvious - the panel shows the signal well before and after it.
  // ONE rect across the whole run, not one per column: translucent fills compound where they
  // overlap, which turned a flat wash into a picket fence of brighter seams.
  if (live) {
    const from = data.findIndex((d) => d?.rec);
    if (from >= 0) {
      let to = data.length - 1;
      while (to > from && !data[to]?.rec) to--;
      ctx.fillStyle = rgbaFrom(ctx, hot, 0.16);
      ctx.fillRect(x(from), 0, x(to + 1) - x(from), h);
    }
  }

  // One column per bucket, coloured by what's IN it rather than a flat accent - the reason a DJ
  // waveform is readable at a glance. A finished take colours by its low/mid/high energy balance;
  // a live meter has no spectrum, so it uses crest factor (peak against rms) instead, which
  // separates a transient from a sustained sound in much the same way.
  for (let i = 0; i < data.length; i++) {
    const [r, g, b] = live ? crestColor(data[i]) : bandColor(recordWaveBands?.[i]);
    const peakAmp = ampOf(at(i));
    const rmsAmp = Math.min(peakAmp, ampOf(rmsAt(i)));
    const cw = colW + 0.6; // a hair of overlap, so neighbouring columns leave no seam
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.32)`;
    ctx.fillRect(x(i), mid - peakAmp, cw, peakAmp * 2 || 1);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
    ctx.fillRect(x(i), mid - rmsAmp, cw, rmsAmp * 2 || 1);
  }

  // A crisp edge along the top and bottom of the peak envelope, so a quiet passage still reads as
  // a shape instead of fading out into the background.
  ctx.strokeStyle = rgbaFrom(ctx, accent, 0.55);
  ctx.lineWidth = 2;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const y = mid + sign * ampOf(at(i));
      if (i === 0) ctx.moveTo(x(i), y);
      else ctx.lineTo(x(i), y);
    }
    ctx.stroke();
  }

  // Anything at full scale is marked in the error colour - a bounce that clipped is worth seeing
  // before it goes into the code, not after. Against the TRUE value, not the normalized one:
  // "this hit 0 dBFS" is a fact about the file, not about how it's being drawn.
  ctx.fillStyle = hot;
  for (let i = 0; i < data.length; i++) {
    if (at(i) < 0.99) continue;
    ctx.fillRect(x(i), mid - maxAmp, Math.max(2, colW), maxAmp * 2);
  }

  // ...and the honest number for everything below full scale, since the shape above is scaled.
  if (!live && truePeak > 0) {
    const db = 20 * Math.log10(truePeak);
    ctx.fillStyle = rgbaFrom(ctx, accent, 0.75);
    ctx.font = '22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`peak ${db.toFixed(1)} dB${norm > 1.02 ? `  ×${norm.toFixed(1)}` : ''}`, w - 12, 10);
    ctx.textAlign = 'left';
  }

  // A live meter reads as "now" at the right edge; mark it so the scroll direction is obvious.
  if (live && data.length > 1) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w - 1, 8);
    ctx.lineTo(w - 1, h - 8);
    ctx.stroke();
  }
}

// The three colours a bucket is mixed from, by where its energy sits. Chosen to stay legible on
// both a light and a dark panel, and to read in the same order a DJ waveform does: deep for bass,
// through the middle, to bright for the top end.
const BAND_COLORS = [
  [74, 124, 245], // low
  [86, 200, 170], // mid
  [246, 205, 122], // high
];

function bandColor(balance) {
  if (!balance) return BAND_COLORS[1];
  // Weight by energy share, but lift the top end: a hat carries little energy next to a kick and
  // would otherwise never show its colour at all.
  const w = [balance[0] ?? 0, (balance[1] ?? 0) * 1.4, (balance[2] ?? 0) * 2.6];
  const total = w[0] + w[1] + w[2] || 1;
  return [0, 1, 2].map((c) =>
    Math.round((BAND_COLORS[0][c] * w[0] + BAND_COLORS[1][c] * w[1] + BAND_COLORS[2][c] * w[2]) / total),
  );
}

// Crest factor: peak well above rms means a transient (bright), peak near rms means something
// sustained (deep). Same visual axis as the band colours, from what a live meter can actually see.
function crestColor(point) {
  const peak = point?.v ?? 0;
  const rms = point?.rms ?? 0;
  if (peak <= 0.0005) return BAND_COLORS[0];
  const crest = rms > 0 ? Math.min(1, Math.max(0, (peak / rms - 1.4) / 4)) : 1;
  const lo = BAND_COLORS[0];
  const hi = BAND_COLORS[2];
  return [0, 1, 2].map((c) => Math.round(lo[c] + (hi[c] - lo[c]) * crest));
}

// --- wiring ---

function initRecordPanel() {
  // Opening is initWidgetHandles' job (double-click the name). Closing is the ✕ or the call itself
  // leaving the buffer - see syncRecordFromCode. A ctrl+b panel, which has no call at all, closes
  // only on the ✕.
  cm.on('change', syncRecordFromCode);

  const fromPanel = () => {
    if (!recordState) return;
    recordState.cycles = Math.max(1, Math.round(Number(recordCycles.value) || 4));
    recordState.name = recordName.value.trim();
    recordState.wrapTail = recordWrapTail.checked;
    writeRecordCall();
  };
  recordCycles.addEventListener('change', fromPanel);
  recordName.addEventListener('change', fromPanel);
  recordWrapTail.addEventListener('change', fromPanel);

  recordGo.addEventListener('click', () => {
    if (trackRecState) return cancelTrackRecord(true);
    if (!recordState) return;
    startTrackRecord(recordState.label, recordState);
  });
  // Back to the live signal without recording - for looking at the track again after a take.
  recordAgain.addEventListener('click', showLiveMeter);
  recordClose.addEventListener('click', closeRecordPanel);
}

// ctrl+b - bounce the block the cursor is in, with no .record() call needed. Uses that block's
// .record() options if it has them, so the hotkey and the panel agree on the length.
function bounceBlockAtCursor() {
  const code = cm.getValue();
  const idx = cm.indexFromPos(cm.getCursor());
  const label = blockLabelAt(idx);
  if (!label || label.startsWith('$')) {
    logLine('ctrl+b: put the cursor in a named block to bounce it', true);
    return;
  }
  if (trackRecState) return cancelTrackRecord(true);
  const call = findRecordCallAt(code, idx);
  const opts = call ? parseRecordCall(code.slice(call.open + 1, call.close)) : { cycles: 4, name: '', wrapTail: false };
  // Open the panel on the way in, so a hotkey bounce still shows its count-in, its meter, and -
  // the point of it - what actually got recorded when it lands.
  if (!recordState || recordState.label !== label) {
    showRecordPanel(label, opts, call ? { marker: cm.markText(cm.posFromIndex(call.start), cm.posFromIndex(call.close + 1), {}), callStart: call.start } : null);
  }
  startTrackRecord(label, opts);
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

// The last engine error we printed, so a failure that persists across several status refreshes
// doesn't reprint itself each time.
let lastEngineError = null;

async function refreshStatus() {
  const { loaded, error, scale } = await api('GET', '/api/status');
  setPatchScale(scale); // the prebake may have called setscale() before anything was evaluated
  // Two words, because this is a status indicator in the header and it has room for two words.
  // A boot failure's error is a diagnosis plus a tail of sclang's output - paragraphs of it - and
  // putting that in here turned the indicator into a wall of text and shoved the header around.
  // It goes to the console instead, which is where a message that long can actually be read.
  engineStatus.textContent = loaded ? 'engine ready' : 'engine down';
  engineStatus.className = `status ${loaded ? 'ok' : 'error'}`;
  engineStatus.title = loaded ? '' : 'the audio engine is not running - see the console for why';
  if (!loaded && error && error !== lastEngineError) logLine(`engine down: ${error}`, true);
  lastEngineError = loaded ? null : error;
  return loaded;
}

function renderTracks(result) {
  trackInfo.innerHTML = '';
  for (const t of result.tracks) {
    const head = document.createElement('div');
    head.className = 'track-head';
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.label;
    head.appendChild(name);
    if (t.muted) head.appendChild(badge('muted', 'badge-muted'));
    if (t.soloed) head.appendChild(badge('solo', 'badge-solo'));
    if (!t.active && !t.muted) head.appendChild(badge('off', 'badge-muted'));
    if (t.keyboard) {
      const b = badge(`⌨ ${t.keyboard}`, 'badge-solo');
      b.title = kbMode === 'normal'
        ? 'live from the computer keyboard - set the ⌨ dropdown up top to midi or both to play'
        : `live from the computer keyboard (${kbMode} mode)`;
      head.appendChild(b);
    }
    const confBtn = document.createElement('button');
    confBtn.className = 'small conf-btn';
    confBtn.textContent = 'conf';
    confBtn.title = "configure: capture knobs you touch in this track's plugin (ui) windows into .param(...) calls in the code";
    if (confSession && confSession.trackLabel === t.label) confBtn.classList.add('conf-active');
    confBtn.onclick = () => toggleConf(t.label, confBtn);
    head.appendChild(confBtn);
    trackInfo.appendChild(head);

    const chain = [t.instrument, ...t.fxChain];
    chain.forEach((plugin, slot) => {
      const row = document.createElement('div');
      row.className = 'chain-row';
      const name = document.createElement('span');
      name.textContent = `${slot}  ${plugin ?? '(no instrument)'}`;
      row.appendChild(name);
      if (plugin) {
        const uiBtn = document.createElement('button');
        uiBtn.className = 'small';
        uiBtn.textContent = 'ui';
        uiBtn.title = "open the plugin's own editor window (or double-click synth/fx in the code)";
        uiBtn.onclick = () => showPluginEditor(t.label, slot);
        row.appendChild(uiBtn);
      }
      trackInfo.appendChild(row);
    });
    if (t.paramNames.length) {
      const row = document.createElement('div');
      row.className = 'chain-params';
      row.textContent = `modulating: ${t.paramNames.join(', ')}`;
      trackInfo.appendChild(row);
    }
  }
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

// Reflect play state on the single Play/Stop toggle button (see the transport TODO): it reads
// "▶ play" when stopped and turns into "■ stop" once playing.
function updateTransportButtons() {
  playBtn.innerHTML = playing ? '■ stop' : '▶ play';
  playBtn.classList.toggle('is-playing', playing);
  playBtn.title = playing ? 'Cmd/Ctrl + .' : 'Cmd/Ctrl + Enter';
}

// The one code-evaluation path. `start: true` (Play) un-freezes the clock so playback (re)starts
// from cycle 0; `start: false` (Update) leaves the clock alone - a running performance is
// re-patched seamlessly, a stopped one just reloads the patterns without making sound. Either
// way the params panel, autocomplete, and highlighting regions refresh.
async function evaluate(start) {
  const code = cm.getValue();
  // The eval request goes out FIRST and everything else follows it. Nothing about recording this
  // state - the history entry, the autosave - may sit between the keystroke and the sound.
  const pending = api('POST', '/api/evaluate', { code, start });
  checkpointUrl(); // a state you played is a state worth finding again in browser history
  saveWip();       // ...and worth having on disk right now, not a debounce from now
  try {
    const result = await pending;
    transport = result.transport ?? { cps: result.cps ?? transport.cps, baseSec: 0, baseCycle: 0, paused: !start };
    setPatchScale(result.scale); // a setscale() in the buffer re-colours (and re-folds) the roll
    renderTracks(result);
    setupHighlighting(result.tracks, result.gridFrom ?? 0, result.gridCount ?? 32);
    setKeyboardRoutes(result.keyboardTracks ?? []);
    foldConfigBlobs();
    if (start) playing = true; // Update keeps the current play state; Play begins it
    const nActive = result.tracks.filter((t) => t.active).length;
    logLine(`${start ? 'playing' : 'updated'} (${nActive}/${result.tracks.length} pattern(s))`);
    loadChainParams();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
  updateTransportButtons();
}

// Play button: state-aware. Playing -> stop; stopped -> evaluate and start.
function togglePlay() {
  if (playing) doStop();
  else evaluate(true);
}

async function doStop() {
  if (recState) cancelMidiRecord(true);
  // Stopping the clock strands an armed bounce: its window is measured in cycles that will never
  // come round. The panel (and its meter) stays open.
  if (trackRecState) cancelTrackRecord(true);
  const result = await api('POST', '/api/stop');
  if (result.transport) transport = result.transport; // frozen at cycle 0
  stopHighlighting();
  updateTransportButtons();
  logLine('stopped');
  kbForgetHeld(); // the server released our held keys; drop our local view so keyup won't re-off
}

// ---------------------------------------------------------------------------------------------
// Computer-keyboard instrument (keyboard() / tap() tracks). The note source is *here*, in the
// browser (the engine can't read the typing keyboard like a MIDI device), so each eval tells us
// which tracks are keyboard targets and we POST every key edge to /api/keyNote - the server turns
// those into engine.noteOn/noteOff on the track. The #kbMode dropdown gates it: `off` types
// normally (no capture), `midi` plays notes and swallows the keystroke so it doesn't reach the
// editor, `both` does both at once. Held keys are tracked so switching mode, alt-tabbing, or a
// stop releases anything still down instead of leaving a note stuck on.
//
// Layout (à la Ableton/tracker typing keyboards): the home row a s d f g h j k l are the white
// keys and the row above (w e t y u o p) the black keys; z / x shift octave, c / v nudge
// velocity. A tap() track ignores pitch - any other key is a hit at the current velocity on a
// fixed note - so the whole keyboard is one velocity pad.
// ---------------------------------------------------------------------------------------------

const kbModeSelect = document.getElementById('kbMode');
const KB_SEMITONES = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
const KB_BASE_NOTE = 48; // MIDI note the home-row `a` plays at octave shift 0 (C, this package's c5 = 60)
const KB_TAP_NOTE = 24; // fixed pitch a tap() key strikes (C2 - the engine's default note, so a
// live tap and its .as("vel:clip") recording play the same pitch); only velocity/timing matter
const KB_OCT_MIN = -3;
const KB_OCT_MAX = 4;
const KB_CONTROL_KEYS = new Set(['z', 'x', 'c', 'v']); // octave -/+, velocity -/+ (never notes)

let kbMode = localStorage.getItem('poptart-kb-mode') || 'normal';
let kbRoutes = []; // [{ trackId, kind, note }] from the latest eval (note: fixed tap pitch, or null)
let kbOctave = 0; // octave shift in whole octaves (z/x)
let kbVelocity = 0.8; // 0.1..1 (c/v)
const kbHeldKeys = new Map(); // key char -> [{ trackId, note }] currently sounding, for keyup/release

// Set the computer-keyboard instrument mode ('normal' | 'midi' | 'both'), keeping the dropdown,
// persisted state, and held-note bookkeeping in sync. Also invoked by the ctrl+b hotkey.
function setKbMode(mode) {
  kbMode = mode;
  kbModeSelect.value = mode;
  localStorage.setItem('poptart-kb-mode', mode);
  if (mode === 'normal') kbReleaseAll();
  logLine(`computer keyboard: ${mode}${mode !== 'normal' && kbRoutes.length === 0 ? ' (no keyboard()/tap() track yet)' : ''}`);
}

kbModeSelect.value = kbMode;
kbModeSelect.addEventListener('change', () => setKbMode(kbModeSelect.value));

// Called from evaluate() with the eval response's keyboardTracks. Drops held notes for any track
// that is no longer a keyboard target, and nudges the user if they've written keyboard()/tap()
// but left the mode off.
function setKeyboardRoutes(routes) {
  const nextIds = new Set(routes.map((r) => r.trackId));
  for (const [key, held] of [...kbHeldKeys]) {
    const kept = held.filter((h) => nextIds.has(h.trackId));
    if (kept.length !== held.length) {
      for (const h of held) if (!nextIds.has(h.trackId)) kbSend(h.trackId, h.note, false);
      if (kept.length) kbHeldKeys.set(key, kept);
      else kbHeldKeys.delete(key);
    }
  }
  const gained = routes.length > 0 && kbRoutes.length === 0;
  kbRoutes = routes;
  if (gained && kbMode === 'normal') {
    logLine('keyboard()/tap() track ready - pick "⌨ midi" (or "both") up top to play it from your keyboard');
  }
}

function kbSend(trackId, note, isOn) {
  api('POST', '/api/keyNote', { trackId, note, vel: kbVelocity, isOn }).catch(() => {});
}

// Release every currently-held key (send note-offs and forget them). Used on mode change, window
// blur, and losing all keyboard tracks.
function kbReleaseAll() {
  for (const held of kbHeldKeys.values()) for (const { trackId, note } of held) kbSend(trackId, note, false);
  kbHeldKeys.clear();
}

// Forget held keys WITHOUT sending note-offs - for when the server already released them (stop).
function kbForgetHeld() {
  kbHeldKeys.clear();
}

function kbAdjustOctave(delta) {
  const next = Math.max(KB_OCT_MIN, Math.min(KB_OCT_MAX, kbOctave + delta));
  if (next !== kbOctave) {
    kbOctave = next;
    logLine(`keyboard octave ${kbOctave >= 0 ? '+' : ''}${kbOctave}`);
  }
}

function kbAdjustVelocity(delta) {
  const next = Math.max(0.1, Math.min(1, Math.round((kbVelocity + delta) * 100) / 100));
  if (next !== kbVelocity) {
    kbVelocity = next;
    logLine(`keyboard velocity ${kbVelocity.toFixed(2)}`);
  }
}

// Should this keydown be intercepted at all? Not when a non-editor text field has focus (so the
// file-name box, param search, etc. type normally) - the CodeMirror editor itself is fair game.
function kbShouldCapture() {
  const el = document.activeElement;
  if (!el) return true;
  if (el.closest && el.closest('.CodeMirror')) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return false;
  return true;
}

// A tap() track strikes on any single-character key that isn't a reserved control.
function kbIsTapKey(key) {
  return key.length === 1 && !KB_CONTROL_KEYS.has(key);
}

function onKbKeyDown(e) {
  if (kbMode === 'normal' || kbRoutes.length === 0) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // never swallow shortcuts (Cmd+Enter to eval, etc.)
  const key = e.key.toLowerCase();
  if (!kbShouldCapture()) return;

  // In midi mode we swallow every key we act on so it never reaches the editor; both mode lets
  // it through so it plays *and* types. Auto-repeat is dropped (a held key is one sustained note).
  const swallow = () => {
    if (kbMode === 'midi') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (KB_CONTROL_KEYS.has(key)) {
    if (!e.repeat) {
      if (key === 'z') kbAdjustOctave(-1);
      else if (key === 'x') kbAdjustOctave(1);
      else if (key === 'c') kbAdjustVelocity(-0.1);
      else if (key === 'v') kbAdjustVelocity(0.1);
    }
    swallow();
    return;
  }

  if (e.repeat || kbHeldKeys.has(key)) {
    // Already sounding (OS auto-repeat) - keep swallowing in midi mode, but don't retrigger.
    let anyMapped = false;
    for (const r of kbRoutes) anyMapped = anyMapped || (r.kind === 'tap' ? kbIsTapKey(key) : key in KB_SEMITONES);
    if (anyMapped) swallow();
    return;
  }

  const struck = [];
  for (const r of kbRoutes) {
    let note;
    if (r.kind === 'tap') {
      if (!kbIsTapKey(key)) continue;
      // .note("f3")/.n(...).scale(...) on the track sets the struck pitch (route.note); with none
      // set, fall back to the default pad note.
      note = typeof r.note === 'number' ? r.note : KB_TAP_NOTE;
    } else {
      if (!(key in KB_SEMITONES)) continue;
      // A fixed pitch from .note("f3")/.n(...).scale(...) replaces the played note: every piano key
      // strikes that one note (keyboard().note("f3")). With none set, the key's own pitch plays.
      note = typeof r.note === 'number' ? r.note : KB_BASE_NOTE + kbOctave * 12 + KB_SEMITONES[key];
    }
    kbSend(r.trackId, note, true);
    struck.push({ trackId: r.trackId, note });
  }
  if (struck.length) {
    kbHeldKeys.set(key, struck);
    swallow();
  }
}

// Key-up always releases whatever that key started, regardless of the current mode/focus, so a
// note can never get stuck (mode may have changed while the key was down).
function onKbKeyUp(e) {
  const key = e.key.toLowerCase();
  const held = kbHeldKeys.get(key);
  if (!held) return;
  kbHeldKeys.delete(key);
  for (const { trackId, note } of held) kbSend(trackId, note, false);
  if (kbMode === 'midi') {
    e.preventDefault();
    e.stopPropagation();
  }
}

// Capture phase so we beat CodeMirror to the key and can suppress typing in midi mode.
document.addEventListener('keydown', onKbKeyDown, true);
document.addEventListener('keyup', onKbKeyUp, true);
window.addEventListener('blur', kbReleaseAll); // alt-tab away -> don't leave notes ringing

// ---------------------------------------------------------------------------------------------
// Macros panel - a bank of knobs exposed to evaluated code as macro1..macroN (0..1 signals).
// The values live server-side in pattern-core's macro store (that's what the scheduler polls);
// these knobs are just the write side, streaming moves over POST /api/macros/set.
// ---------------------------------------------------------------------------------------------

const macroBank = document.getElementById('macroBank');

async function initMacros() {
  let macros;
  try {
    ({ macros } = await api('GET', '/api/macros'));
  } catch (e) {
    macroBank.textContent = `macros unavailable: ${e.message}`;
    return;
  }
  macroBank.innerHTML = '';
  for (const m of macros) macroBank.appendChild(macroKnob(m));
}

// One knob: vertical drag turns it (shift = fine), scroll nudges it, double-click resets to 0.
// Double-clicking the name opens an inline rename (empty = back to "Macro N").
function macroKnob(m) {
  const root = document.createElement('div');
  root.className = 'macro';

  const knob = document.createElement('div');
  knob.className = 'macro-knob';
  const num = document.createElement('span');
  num.className = 'macro-num';
  num.textContent = m.index;
  knob.appendChild(num);

  const nameEl = document.createElement('div');
  nameEl.className = 'macro-name';
  nameEl.title = 'double-click to rename';
  root.append(knob, nameEl);

  let value = m.value;
  let name = m.name;

  const paint = () => {
    knob.style.setProperty('--v', value);
    knob.title = `${name} = ${value.toFixed(2)}  ·  macro${m.index} in code  ·  double-click resets`;
    nameEl.textContent = name;
  };
  paint();

  // A drag streams values; keep at most one POST in flight and always land on the final one.
  let inFlight = false;
  let dirty = false;
  const push = async () => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    const sent = value;
    try {
      await api('POST', '/api/macros/set', { index: m.index, value: sent });
    } catch (e) {
      logLine(`macro ${m.index}: ${e.message}`, true);
    }
    inFlight = false;
    if (dirty) {
      dirty = false;
      if (value !== sent) push();
    }
  };

  const setValue = (v) => {
    value = Math.min(1, Math.max(0, v));
    paint();
    push();
  };

  knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startV = value;
    const onMove = (ev) => {
      const pxPerSweep = ev.shiftKey ? 1200 : 160; // px of vertical drag for the full 0..1 sweep
      setValue(startV + (startY - ev.clientY) / pxPerSweep);
    };
    const onUp = () => {
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      knob.removeEventListener('pointercancel', onUp);
    };
    knob.addEventListener('pointermove', onMove);
    knob.addEventListener('pointerup', onUp);
    knob.addEventListener('pointercancel', onUp);
  });

  knob.addEventListener('dblclick', () => setValue(0));

  knob.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setValue(value - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.02));
    },
    { passive: false },
  );

  nameEl.addEventListener('dblclick', () => {
    const input = document.createElement('input');
    input.className = 'macro-name-input';
    input.value = name;
    input.maxLength = 24;
    input.spellcheck = false;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      try {
        const res = await api('POST', '/api/macros/name', { index: m.index, name: input.value });
        name = res.name;
      } catch (e) {
        logLine(`macro ${m.index}: ${e.message}`, true);
      }
      paint();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') {
        done = true;
        paint();
      }
    });
    input.addEventListener('blur', commit);
  });

  return root;
}

// ---------------------------------------------------------------------------------------------
// Params panel (also feeds autocomplete via `chainSlots`)
// ---------------------------------------------------------------------------------------------

const MAX_PARAM_ROWS = 300;

function renderParams() {
  const query = paramSearch.value.trim().toLowerCase();
  paramList.innerHTML = '';

  const total = chainSlots.reduce((sum, s) => sum + s.params.length, 0);
  paramsCount.textContent = total ? `${total}` : '';
  if (!chainSlots.length) {
    paramList.textContent = 'evaluate a pattern to load its plugins’ parameters';
    return;
  }

  let shown = 0;
  let matched = 0;
  for (const slot of chainSlots) {
    // addr disambiguates reused names ("Frequency#95") so the copied string targets exactly the
    // clicked parameter; searching still matches on it (the base name is a substring of the addr).
    const matches = withParamAddrs(slot.params).filter((p) => !query || p.addr.toLowerCase().includes(query));
    matched += matches.length;

    const head = document.createElement('div');
    head.className = 'slot-head';
    const trackPrefix = slot.track ? `${slot.track} · ` : '';
    head.textContent = `${trackPrefix}${slot.slot} · ${slot.plugin} — ${slot.error ?? `${matches.length}${query ? ` of ${slot.params.length}` : ''} params`}`;
    paramList.appendChild(head);

    for (const p of matches) {
      if (shown >= MAX_PARAM_ROWS) break;
      const row = document.createElement('div');
      row.className = 'param-row';
      row.title = 'click to copy';
      const name = document.createElement('span');
      name.textContent = p.addr;
      row.appendChild(name);
      if (p.label) {
        const label = document.createElement('span');
        label.className = 'dim';
        label.textContent = p.label;
        row.appendChild(label);
      }
      row.onclick = () => copyText(p.addr, 'param');
      paramList.appendChild(row);
      shown++;
    }
  }

  if (matched > shown) {
    const more = document.createElement('div');
    more.className = 'more-note';
    more.textContent = `…${matched - shown} more — refine the filter to see them`;
    paramList.appendChild(more);
  }
}

async function loadChainParams() {
  paramList.textContent = 'loading params… (first load of a plugin can take a few seconds)';
  try {
    const { slots } = await api('GET', '/api/chainParams');
    chainSlots = slots;
    renderParams();
    for (const s of slots.filter((s) => s.error)) {
      logLine(`params for ${s.track} slot ${s.slot} (${s.plugin}): ${s.error}`, true);
    }
  } catch (e) {
    paramList.textContent = 'failed to load params';
    logLine(e.message ?? String(e), true);
  }
}

paramSearch.addEventListener('input', renderParams);

// ---------------------------------------------------------------------------------------------
// Plugin browser (also feeds autocomplete via `knownPlugins`)
// ---------------------------------------------------------------------------------------------

function renderPlugins(plugins) {
  knownPlugins = plugins;
  pluginList.innerHTML = '';
  if (!plugins.length) {
    pluginList.textContent = 'no plugins found';
    return;
  }
  for (const p of plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    row.title = 'click to copy';
    const name = document.createElement('span');
    name.textContent = p.name;
    row.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'dim';
    meta.textContent = `${p.format}${p.isInstrument ? ' · inst' : ''}`;
    row.appendChild(meta);
    row.onclick = () => copyText(p.name, 'plugin');
    pluginList.appendChild(row);
  }
}

async function doScan() {
  logLine('scanning for plugins…');
  try {
    const { plugins, crashed } = await api('POST', '/api/scanPlugins', { extraPaths: [] });
    renderPlugins(plugins);
    logLine(`found ${plugins.length} plugin(s)`);
    if (crashed.length) {
      logLine(`skipped ${crashed.length} plugin(s) that crashed the scanner: ${crashed.join(', ')}`, true);
    }
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The engine's boot-time VSTPlugin.search usually already knows the plugins - populate the
// browser (and .synth()/.fx() autocomplete) without requiring a manual rescan.
async function loadKnownPlugins() {
  try {
    const plugins = await api('GET', '/api/knownPlugins');
    if (plugins.length) {
      renderPlugins(plugins);
      logLine(`${plugins.length} plugin(s) known`);
    }
  } catch {
    // engine not up yet - the rescan button still works later
  }
}

// ---------------------------------------------------------------------------------------------
// Samples browser (sounds tab) - the packs under the samples root (folders of audio files; see
// osc-engine's samples.js). A file's position in its pack is its sampler index, so file rows
// copy `s("pack:idx")` and pack headers copy `s("pack")`. Reloaded every time the tab opens,
// so packs added on disk mid-session show up.
// ---------------------------------------------------------------------------------------------

const sampleSearch = document.getElementById('sampleSearch');
const sampleList = document.getElementById('sampleList');
const samplesCount = document.getElementById('samplesCount');

const MAX_SAMPLE_ROWS = 300;
let samplePacks = null; // null until the first load, then [{ name, files }]
let samplesRootDir = '';

// Sample preview (auditioning). Plays the actual file the sounds browser lists - fetched from
// /api/sampleAudio by the same pack/index that `s("pack:i")` uses - through Web Audio, so a
// click both copies the pattern and lets you hear what it plays. The AudioContext is created
// lazily on the first click (a user gesture, which browsers require to start audio), and each
// new preview stops the previous one so rapid clicking doesn't stack overlapping sounds.
let previewCtx = null;
let previewSource = null; // the currently-playing BufferSourceNode, if any
let previewRow = null; // the row element marked 'previewing', so we can clear it when it ends
let previewGen = 0; // bumped on every press, so a slow fetch/decode from an older press is dropped
let previewHeld = false; // true between pointerdown and release - hold-to-preview gate

// Release anywhere ends the audition, even if the pointer drifted off the row first. Also
// cancels a press that's released before its fetch/decode has started playing (see previewSample).
window.addEventListener('pointerup', () => { previewHeld = false; stopPreview(); });

function stopPreview() {
  if (previewSource) {
    try { previewSource.stop(); } catch {}
    previewSource = null;
  }
  if (previewRow) {
    previewRow.classList.remove('previewing');
    previewRow = null;
  }
}

async function previewSample(pack, i, row) {
  stopPreview();
  const gen = ++previewGen;
  previewHeld = true;
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {});
  try {
    const res = await fetch(`/api/sampleAudio?pack=${encodeURIComponent(pack)}&i=${i}`);
    if (!res.ok) throw new Error(`preview failed: ${res.status}`);
    const buf = await previewCtx.decodeAudioData(await res.arrayBuffer());
    // Drop this press if a newer one superseded it, or the button was already released.
    if (gen !== previewGen || !previewHeld) return;
    const src = previewCtx.createBufferSource();
    src.buffer = buf;
    src.connect(previewCtx.destination);
    src.onended = () => { if (src === previewSource) stopPreview(); };
    previewSource = src;
    previewRow = row;
    row?.classList.add('previewing');
    src.start();
  } catch (e) {
    if (gen === previewGen) { stopPreview(); logLine(e.message ?? String(e), true); }
  }
}

function renderSamples() {
  const query = sampleSearch.value.trim().toLowerCase();
  sampleList.innerHTML = '';
  if (!samplePacks?.length) {
    samplesCount.textContent = '';
    sampleList.textContent = samplePacks
      ? `no sample packs found - put folders of audio files in ${samplesRootDir}`
      : 'loading…';
    return;
  }

  samplesCount.textContent = `${samplePacks.reduce((sum, p) => sum + p.files.length, 0)}`;

  let shown = 0;
  let matched = 0;
  for (const pack of samplePacks) {
    const packMatches = pack.name.toLowerCase().includes(query);
    // Indexes must be positions in the full pack, not the filtered view - attach before filtering.
    const files = pack.files
      .map((name, i) => ({ name, i }))
      .filter((f) => !query || packMatches || f.name.toLowerCase().includes(query));
    if (!files.length) continue;
    matched += files.length;
    if (shown >= MAX_SAMPLE_ROWS) continue; // keep counting for the more-note, stop rendering

    const head = document.createElement('div');
    head.className = 'slot-head sample-pack-head';
    head.title = 'click to copy';
    head.textContent = `${pack.name} · ${pack.files.length}`;
    head.onclick = () => copyText(`s("${pack.name}")`, 'pack');
    sampleList.appendChild(head);

    for (const f of files) {
      if (shown >= MAX_SAMPLE_ROWS) break;
      const row = document.createElement('div');
      row.className = 'param-row sample-row';
      row.title = 'hold to preview · click copies';
      const name = document.createElement('span');
      name.textContent = f.name;
      row.appendChild(name);
      const idx = document.createElement('span');
      idx.className = 'dim';
      idx.textContent = `:${f.i}`;
      row.appendChild(idx);
      // Hold-to-preview: audition starts on press and stops on release (so a long sample
      // doesn't play to the end), while the plain click still copies the pattern.
      row.onpointerdown = (e) => {
        if (e.button !== 0) return; // left button only
        copyText(`s("${pack.name}:${f.i}")`, 'sample');
        previewSample(pack.name, f.i, row);
      };
      sampleList.appendChild(row);
      shown++;
    }
  }

  if (matched > shown) {
    const more = document.createElement('div');
    more.className = 'more-note';
    more.textContent = `…${matched - shown} more — refine the filter to see them`;
    sampleList.appendChild(more);
  }
  if (!matched) sampleList.textContent = 'no samples match';
}

async function loadSamples() {
  try {
    const { root, packs } = await api('GET', '/api/samples');
    samplesRootDir = root;
    samplePacks = packs;
  } catch (e) {
    samplePacks = [];
    logLine(e.message ?? String(e), true);
  }
  renderSamples();
}

sampleSearch.addEventListener('input', renderSamples);

// ---------------------------------------------------------------------------------------------
// Sidebar tabs (session | sounds | files | settings) + pattern file manager. Pattern files are
// whole editor buffers saved server-side (~/.poptart/patterns/<name>.js) via /api/patterns*:
// save the current buffer under a name, click a saved pattern to load it, rename/delete to
// organize.
// ---------------------------------------------------------------------------------------------

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sessionTab = document.getElementById('sessionTab');
const soundsTab = document.getElementById('soundsTab');
const filesTab = document.getElementById('filesTab');
const settingsTab = document.getElementById('settingsTab');
const audioDeviceSelect = document.getElementById('audioDeviceSelect');
const audioInputList = document.getElementById('audioInputList');
const audioInputLayoutNote = document.getElementById('audioInputLayout');
const audioInputApply = document.getElementById('audioInputApply');
const audioDeviceWarningEl = document.getElementById('audioDeviceWarning');
const fileSaveBtn = document.getElementById('fileSaveBtn');
const fileSaveAsBtn = document.getElementById('fileSaveAsBtn');
const fileExportBtn = document.getElementById('fileExportBtn');
const fileImportBtn = document.getElementById('fileImportBtn');
const fileImportInput = document.getElementById('fileImportInput');
const fileNewBtn = document.getElementById('fileNewBtn');
const fileList = document.getElementById('fileList');
const fileSearchInput = document.getElementById('fileSearchInput');
const wipList = document.getElementById('wipList');
const consoleFooter = document.getElementById('console');
const consoleToggle = document.getElementById('consoleToggle');

// Switch the sidebar to a named tab (also invoked by the ctrl+p hotkey, see the hotkeys section).
function activateTab(name) {
  for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === name);
  sessionTab.classList.toggle('hidden', name !== 'session');
  soundsTab.classList.toggle('hidden', name !== 'sounds');
  filesTab.classList.toggle('hidden', name !== 'files');
  settingsTab.classList.toggle('hidden', name !== 'settings');
  if (name === 'sounds') loadSamples();
  if (name === 'files') refreshPatternFiles();
  if (name === 'settings') { refreshAudioDevices(); refreshAudioInputs(); refreshSamplesDir(); refreshPreferVst3(); }
}

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}

// ---------------------------------------------------------------------------------------------
// Settings tab - audio output device. Devices come with channel counts (what .o(n) wraps
// against); changing the selection restarts the engine server-side, so playing tracks stop
// and the user re-evaluates.
// ---------------------------------------------------------------------------------------------

async function refreshAudioDevices() {
  try {
    const { devices, selected } = await api('GET', '/api/audioDevices');
    audioDeviceSelect.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    const sysDefault = devices.find((d) => d.isDefault);
    def.textContent = sysDefault ? `system default (${sysDefault.name})` : 'system default';
    audioDeviceSelect.appendChild(def);
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = `${d.name} · ${d.channels} ch`;
      audioDeviceSelect.appendChild(opt);
    }
    // A saved device that's since been unplugged falls back to "" - the server already plays
    // on the system default in that case.
    audioDeviceSelect.value = selected ?? '';
    if (audioDeviceSelect.value !== (selected ?? '')) audioDeviceSelect.value = '';
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

audioDeviceSelect.addEventListener('change', async () => {
  const device = audioDeviceSelect.value || null;
  const label = device ?? 'the system default';
  audioInputs = null; // a different device exposes different inputs - refetch on the next popup
  audioDeviceSelect.disabled = true;
  engineStatus.textContent = 'restarting engine…';
  engineStatus.className = 'status';
  logLine(`switching audio output to ${label} - restarting the engine…`);
  try {
    // The server rebuilds the combined device around the new output device on the way through, so
    // the input layout can change here too - and its warning is the one thing that says whether
    // playback actually landed where you asked.
    const { warning } = await api('POST', '/api/audioDevice', { device });
    stopHighlighting();
    playing = false;
    updateTransportButtons();
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    logLine(`audio output is now ${label} - re-evaluate (Cmd/Ctrl+Enter) to resume playback`);
    setAudioDeviceWarning(warning);
    refreshAudioInputs().catch(() => {});
  } catch (e) {
    logLine(e.message ?? String(e), true);
  } finally {
    audioDeviceSelect.disabled = false;
    refreshStatus().catch(() => {});
  }
});

// ---------------------------------------------------------------------------------------------
// Settings tab - extra audio INPUTS. SuperCollider opens exactly one audio device, so reaching
// several interfaces at once means combining them into one aggregate device, which poptart builds
// and maintains (drift-compensated, in a fixed order). Applying rebuilds that device and restarts
// the engine, so it's a deliberate button press, never automatic.
//
// The layout line under the list is what makes input("name", n) legible: it shows the channel
// ranges each interface actually occupies in the combined device.
// ---------------------------------------------------------------------------------------------

let audioInputSelection = new Set();
let audioInputSaved = '';

function renderAudioInputLayout(layout, activeName) {
  if (!layout?.length) {
    audioInputLayoutNote.textContent = activeName ? `${activeName} has no inputs` : '';
    return;
  }
  // Running channel offsets - exactly the arithmetic input("name", n) does server-side.
  let offset = 0;
  const parts = layout.map((d) => {
    const first = offset + 1;
    offset += d.inChannels;
    return d.inChannels === 1 ? `${d.name} ch ${first}` : `${d.name} ch ${first}–${offset}`;
  });
  audioInputLayoutNote.textContent = parts.join(' · ');
}

function syncAudioInputApply() {
  const current = [...audioInputSelection].sort().join(',');
  audioInputApply.disabled = current === audioInputSaved;
}

// The one place a degraded combined device is visible. `warning` is { message, detail }: the panel
// gets the one line that says what to press, the console gets the paragraph explaining it, and the
// row's tooltip carries it too for anyone who reads that instead of scrolling back.
//
// The console copy matters because this failure - an unplugged member, or a combined device that
// has lost the device you play through - sounds exactly like everything working, right down to the
// meters. Only on a change, though: this refreshes every time the settings tab opens, and a warning
// that reprints itself is one you stop reading.
let lastAudioDeviceWarning = '';
function setAudioDeviceWarning(warning) {
  const message = warning?.message ?? '';
  audioDeviceWarningEl.textContent = message;
  audioDeviceWarningEl.title = warning?.detail ?? '';
  if (message && message !== lastAudioDeviceWarning) logLine(warning.detail ?? message, true);
  lastAudioDeviceWarning = message;
}

async function refreshAudioInputs() {
  try {
    const { available, devices, selected, names, layout, active, warning } = await api('GET', '/api/audioInputs');
    audioInputSelection = new Set(selected);
    audioInputSaved = [...audioInputSelection].sort().join(',');
    audioInputList.innerHTML = '';
    setAudioDeviceWarning(warning);

    if (!available) {
      // No helper (non-macOS, or a checkout without the built binary): the booted device's own
      // inputs still work with absolute channel numbers, there just can't be more than one device.
      audioInputList.textContent = 'combining several input devices is unavailable on this system';
      audioInputApply.disabled = true;
      renderAudioInputLayout(layout, active);
      return;
    }
    if (!devices.length) {
      audioInputList.textContent = 'no input-capable devices found';
      audioInputApply.disabled = true;
      renderAudioInputLayout(layout, active);
      return;
    }

    const addRow = (uid, label, { title = '' } = {}) => {
      const row = document.createElement('label');
      row.className = 'check-row';
      if (title) row.title = title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = audioInputSelection.has(uid);
      box.addEventListener('change', () => {
        if (box.checked) audioInputSelection.add(uid); else audioInputSelection.delete(uid);
        syncAudioInputApply();
      });
      const text = document.createElement('span');
      text.textContent = label;
      row.append(box, text);
      audioInputList.appendChild(row);
    };

    // Selected devices that aren't connected go FIRST, named. They need a row at all because
    // otherwise they're invisible and unremovable - they stay in the selection with no checkbox
    // anywhere to turn them off - and they need to be at the top because the one time you want one
    // is the time you've decided to forget it, and hunting for it below a scroll is the whole
    // annoyance. The engine rebuilds around them on its own, so this is only ever a "forget it"
    // control, never a step you're required to take.
    for (const uid of selected.filter((u) => !devices.some((d) => d.uid === u))) {
      addRow(uid, `${names?.[uid] ?? uid} · not plugged in`, {
        title: `${uid}\n\nsaved, but not connected right now. The combined device is rebuilt without `
          + 'it automatically - untick and apply only if you want it forgotten.',
      });
    }

    for (const d of devices) addRow(d.uid, `${d.name} · ${d.inChannels} in`);
    renderAudioInputLayout(layout, active);
    syncAudioInputApply();
  } catch (e) {
    audioInputList.textContent = 'could not list input devices';
    logLine(e.message ?? String(e), true);
  }
}

audioInputApply.addEventListener('click', async () => {
  const uids = [...audioInputSelection];
  audioInputApply.disabled = true;
  engineStatus.textContent = 'restarting engine…';
  engineStatus.className = 'status';
  logLine(uids.length
    ? `combining ${uids.length} input device(s) with the output device - rebuilding the audio device and restarting the engine…`
    : 'removing the combined audio device - restarting the engine…');
  try {
    const { layout, warning } = await api('POST', '/api/audioInputs', { uids });
    stopHighlighting();
    playing = false;
    updateTransportButtons();
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    audioInputSaved = [...uids].sort().join(',');
    audioInputs = layout ?? null; // the input(" popup's channel ranges just changed
    renderAudioInputLayout(layout, null);
    setAudioDeviceWarning(warning);
    logLine('audio inputs updated - re-evaluate (Cmd/Ctrl+Enter) to resume playback');
    refreshAudioDevices().catch(() => {});
  } catch (e) {
    logLine(e.message ?? String(e), true);
  } finally {
    syncAudioInputApply();
    refreshStatus().catch(() => {});
  }
});

// Editor settings. The docs toggle governs both documentation tooltips - the panel beside the
// autocomplete popup and the ctrl-hover one (see the tooltips section above).
const docTooltipsToggle = document.getElementById('docTooltipsToggle');
docTooltipsToggle.checked = docTooltipsEnabled;
docTooltipsToggle.addEventListener('change', () => setDocTooltips(docTooltipsToggle.checked));

// Sample-library folder. The saved folder is what `s(...)` reads packs from; when
// POPTART_SAMPLES_DIR is set in the environment it overrides this, so the field goes read-only
// and says so.
const samplesDirInput = document.getElementById('samplesDirInput');
const samplesDirSave = document.getElementById('samplesDirSave');
const samplesDirReset = document.getElementById('samplesDirReset');
const samplesDirNote = document.getElementById('samplesDirNote');

async function refreshSamplesDir() {
  try {
    const { dir, envOverride } = await api('GET', '/api/samplesDir');
    samplesDirInput.value = dir;
    samplesDirInput.disabled = envOverride;
    samplesDirSave.disabled = envOverride;
    samplesDirReset.disabled = envOverride;
    samplesDirNote.textContent = envOverride
      ? 'set by POPTART_SAMPLES_DIR - unset it to edit here'
      : '';
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function saveSamplesDir(dir) {
  try {
    const res = await api('POST', '/api/samplesDir', { dir });
    samplesDirInput.value = res.dir;
    logLine(`sample library folder is now ${res.dir}`);
    loadSamples().catch(() => {}); // refresh the sounds browser against the new root
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

samplesDirSave.addEventListener('click', () => saveSamplesDir(samplesDirInput.value.trim() || null));
samplesDirReset.addEventListener('click', () => saveSamplesDir(null));
samplesDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveSamplesDir(samplesDirInput.value.trim() || null); }
});

// Prefer-VST3 toggle. The filter lives on the server's plugin-list endpoints, so applying a
// change is just re-fetching the list - no rescan.
const preferVst3Toggle = document.getElementById('preferVst3Toggle');

async function refreshPreferVst3() {
  try {
    const { enabled } = await api('GET', '/api/preferVst3');
    preferVst3Toggle.checked = enabled;
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

preferVst3Toggle.addEventListener('change', async () => {
  try {
    const { enabled } = await api('POST', '/api/preferVst3', { enabled: preferVst3Toggle.checked });
    logLine(`prefer VST3 over VST2: ${enabled ? 'on' : 'off'}`);
    loadKnownPlugins().catch(() => {}); // refresh the browser + autocomplete pool
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
});

// Folder picker - a server-side directory browser (the server and browser are the same machine,
// and browsers can't hand back a real filesystem path). Navigate into subfolders, up via ".."
// or the path field, and "use this folder" saves the current path as the sample library.
const dirPickerBackdrop = document.getElementById('dirPickerBackdrop');
const dirPickerPath = document.getElementById('dirPickerPath');
const dirPickerList = document.getElementById('dirPickerList');
const dirPickerNote = document.getElementById('dirPickerNote');
const dirPickerUse = document.getElementById('dirPickerUse');
const dirPickerClose = document.getElementById('dirPickerClose');
const samplesDirBrowse = document.getElementById('samplesDirBrowse');
let dirPickerCurrent = '';

async function browseTo(pathArg) {
  dirPickerNote.textContent = '';
  try {
    const { path, parent, dirs } = await api('GET', `/api/browseDir?path=${encodeURIComponent(pathArg ?? '')}`);
    dirPickerCurrent = path;
    dirPickerPath.value = path;
    dirPickerList.innerHTML = '';
    if (parent) {
      const up = document.createElement('div');
      up.className = 'dir-row dir-up';
      up.textContent = '↑ ..';
      up.addEventListener('click', () => browseTo(parent));
      dirPickerList.appendChild(up);
    }
    for (const name of dirs) {
      const row = document.createElement('div');
      row.className = 'dir-row';
      row.textContent = name;
      row.addEventListener('click', () => browseTo(`${path}/${name}`));
      dirPickerList.appendChild(row);
    }
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = 'no subfolders here';
      dirPickerList.appendChild(empty);
    }
  } catch (e) {
    dirPickerNote.textContent = e.message ?? String(e);
  }
}

function openDirPicker() {
  dirPickerBackdrop.classList.remove('hidden');
  browseTo(samplesDirInput.value.trim() || null);
}
function closeDirPicker() { dirPickerBackdrop.classList.add('hidden'); }

samplesDirBrowse.addEventListener('click', openDirPicker);
dirPickerClose.addEventListener('click', closeDirPicker);
dirPickerBackdrop.addEventListener('click', (e) => { if (e.target === dirPickerBackdrop) closeDirPicker(); });
dirPickerPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); browseTo(dirPickerPath.value.trim()); }
});
dirPickerUse.addEventListener('click', () => {
  samplesDirInput.value = dirPickerCurrent;
  closeDirPicker();
  saveSamplesDir(dirPickerCurrent || null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dirPickerBackdrop.classList.contains('hidden')) closeDirPicker();
});

// ---------------------------------------------------------------------------------------------
// Prebake editor - a modal CodeMirror over ~/.poptart/prebake.js (settings tab -> "edit
// prebake…"). Saving writes the file and re-runs it server-side, so edits apply without a
// restart; per-block errors come back and show in the footer. Its own CodeMirror is created
// lazily on first open (and refreshed then, since it's laid out while hidden).
// ---------------------------------------------------------------------------------------------

const prebakeBackdrop = document.getElementById('prebakeBackdrop');
const prebakeEditBtn = document.getElementById('prebakeEditBtn');
const prebakeSaveBtn = document.getElementById('prebakeSave');
const prebakeCloseBtn = document.getElementById('prebakeClose');
const prebakeNote = document.getElementById('prebakeNote');
const PREBAKE_HINT = 'saved to ~/.poptart/prebake.js · ⌘S / ⌘↵ to save';
let prebakeCM = null;

function ensurePrebakeCM() {
  if (!prebakeCM) {
    prebakeCM = CodeMirror.fromTextArea(document.getElementById('prebakeEditor'), {
      mode: { name: 'javascript' },
      theme: 'poptart',
      keyMap: 'sublime',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Cmd-Enter': savePrebake,
        'Ctrl-Enter': savePrebake,
        'Cmd-S': savePrebake,
        'Ctrl-S': savePrebake,
      },
    });
  }
  return prebakeCM;
}

function setPrebakeNote(text, isError = false) {
  prebakeNote.textContent = text;
  prebakeNote.classList.toggle('error', isError);
}

async function openPrebake() {
  const editor = ensurePrebakeCM();
  setPrebakeNote('loading…');
  try {
    const { code } = await api('GET', '/api/prebake');
    editor.setValue(code ?? '');
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
  prebakeBackdrop.classList.remove('hidden');
  editor.refresh(); // it was laid out while hidden - size it now that it's visible
  editor.focus();
  editor.setCursor(editor.lineCount(), 0);
  setPrebakeNote(PREBAKE_HINT);
}

function closePrebake() { prebakeBackdrop.classList.add('hidden'); }

async function savePrebake() {
  if (!prebakeCM) return;
  prebakeSaveBtn.disabled = true;
  setPrebakeNote('saving…');
  try {
    const code = prebakeCM.getValue();
    const { errors } = await api('POST', '/api/prebake', { code });
    // The server ran it for DSL defs; run it in the browser too so any hotkey()/editor calls
    // in the same file take effect immediately (see runUserPrebake).
    runUserPrebake(code);
    if (errors && errors.length) {
      setPrebakeNote(`saved, but: ${errors.join(' · ')}`, true);
      for (const msg of errors) logLine(`prebake ${msg}`, true);
    } else {
      setPrebakeNote(`saved & ran ✓ · ${PREBAKE_HINT}`);
      logLine('prebake saved & re-run');
    }
  } catch (e) {
    setPrebakeNote(e.message ?? String(e), true);
    logLine(e.message ?? String(e), true);
  } finally {
    prebakeSaveBtn.disabled = false;
  }
}

prebakeEditBtn.addEventListener('click', openPrebake);
prebakeSaveBtn.addEventListener('click', savePrebake);
prebakeCloseBtn.addEventListener('click', closePrebake);
prebakeBackdrop.addEventListener('click', (e) => { if (e.target === prebakeBackdrop) closePrebake(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !prebakeBackdrop.classList.contains('hidden')) closePrebake();
});

// One row: what the pattern calls itself on the first line, everything else dim underneath, and
// the actions revealed on hover. `label` is the @title / first block label / file name, worked
// out server-side (see displayLabel) so the list reads the way the pattern names itself.
function fileRow(entry, buttons) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.title = 'click to load into the editor';

  const main = document.createElement('span');
  main.className = 'file-main';

  const label = document.createElement('span');
  label.className = 'file-label';
  label.textContent = entry.label;
  main.appendChild(label);

  const bits = [];
  if (entry.kind === 'saved' && entry.name !== entry.label) bits.push(entry.name);
  if (entry.by) bits.push(`by ${entry.by}`);
  for (const t of entry.tags) bits.push(`#${t}`);
  bits.push(new Date(entry.mtime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = bits.join(' · ');
  main.appendChild(meta);
  row.appendChild(main);

  for (const [glyph, title, onClick] of buttons) {
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = glyph;
    btn.title = title;
    btn.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    row.appendChild(btn);
  }
  return row;
}

// Which row the buffer in the editor came from - the saved pattern it was last kept as, or, while
// it has no name of its own, the work-in-progress session recording it right now. Marking it is
// what makes `save` legible: the highlighted row is the file it will write to.
function markCurrentFileRow() {
  for (const row of document.querySelectorAll('.file-row.current')) row.classList.remove('current');
  const sel = currentSavedName
    ? `.file-row[data-name="${CSS.escape(currentSavedName)}"]`
    : `.file-row[data-wip="${CSS.escape(wipSessionId)}"]`;
  const row = document.querySelector(sel);
  if (!row) return;
  row.classList.add('current');
  row.title = currentSavedName
    ? 'the pattern open in the editor - save writes here'
    : 'this session is the buffer in the editor';
}

function renderSavedPatterns(patterns, searching) {
  fileList.innerHTML = '';
  if (!patterns.length) {
    fileList.textContent = searching
      ? 'no saved patterns match'
      : 'no saved patterns yet - hit save to keep the current buffer as one';
    return;
  }
  for (const p of patterns) {
    const row = fileRow(p, [
      ['✎', 'rename', () => renamePatternFile(p.name)],
      ['✕', 'delete', () => deletePatternFile(p.name)],
    ]);
    row.dataset.name = p.name;
    row.onclick = () => loadPatternFile(p.name);
    fileList.appendChild(row);
  }
}

// "2026-08" -> "August 2026", the heading each month's sessions collapse under.
function monthHeading(month) {
  const [y, m] = month.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

// Which months are expanded - remembered across re-renders (autosaving re-renders this list
// whenever a session's row changes), so an old month you opened doesn't snap shut under you.
// Null until the first render, which opens the newest month and leaves the rest collapsed.
let wipOpenMonths = null;

// Sessions grouped by the month they were played, newest month first, so a year of jamming
// doesn't bury the last week of it.
function renderWipPatterns(wip, searching) {
  wipList.innerHTML = '';
  if (!wip.length) {
    wipList.textContent = searching
      ? 'no sessions match'
      : 'nothing here yet - whatever you type is autosaved to this month';
    return;
  }
  const months = [...new Set(wip.map((w) => w.month))].sort().reverse();
  if (!wipOpenMonths) wipOpenMonths = new Set(months.slice(0, 1));
  for (const month of months) {
    const group = document.createElement('details');
    group.className = 'wip-month';
    group.open = searching || wipOpenMonths.has(month); // a search never hides its own results
    const summary = document.createElement('summary');
    summary.textContent = monthHeading(month);
    // Recorded from the click rather than the toggle event, so opening every month to show
    // search results isn't mistaken for the user having opened them.
    summary.addEventListener('click', () => {
      if (group.open) wipOpenMonths.delete(month);
      else wipOpenMonths.add(month);
    });
    group.appendChild(summary);
    for (const w of wip.filter((x) => x.month === month)) {
      const row = fileRow(w, [
        ['⤓', 'keep this session as a named pattern', () => keepWipFile(w)],
        ['✕', 'delete this session', () => deleteWipFile(w)],
      ]);
      row.dataset.wip = w.id;
      row.onclick = () => loadWipFile(w);
      group.appendChild(row);
    }
    wipList.appendChild(group);
  }
}

async function refreshPatternFiles() {
  const q = fileSearchInput.value.trim();
  try {
    const { patterns, wip } = await api('GET', `/api/patterns?q=${encodeURIComponent(q)}`);
    renderSavedPatterns(patterns, !!q);
    renderWipPatterns(wip ?? [], !!q);
    markCurrentFileRow();
  } catch (e) {
    fileList.textContent = 'failed to list patterns';
    logLine(e.message ?? String(e), true);
  }
}

let fileSearchTimer = null;
fileSearchInput.addEventListener('input', () => {
  clearTimeout(fileSearchTimer);
  fileSearchTimer = setTimeout(refreshPatternFiles, 200);
});

// ------------------------------------------------------------------------------ naming a pattern
//
// The one dialog that puts a name on a buffer - "save as", and the two list actions that also
// have to name a file (keep a session, rename a pattern). It knows what's already in the folder,
// so a collision is something you're told about *while typing it*, on the button you're about to
// press, rather than after the fact: saving over an existing pattern says so and reads "overwrite",
// and renaming onto one is refused outright (the server won't clobber on a rename either).

const nameDialogBackdrop = document.getElementById('nameDialogBackdrop');
const nameDialogTitle = document.getElementById('nameDialogTitle');
const nameDialogInput = document.getElementById('nameDialogInput');
const nameDialogNote = document.getElementById('nameDialogNote');
const nameDialogConfirm = document.getElementById('nameDialogConfirm');

let nameDialogResolve = null;
let nameDialogState = { names: new Set(), allow: null, blockExisting: false, confirmLabel: 'save' };

// patternNameProblem comes from pattern-meta.js - the same rule the server rejects on, so a bad
// name is a disabled button with a reason on it rather than a failed request.
function updateNameDialogState() {
  const name = nameDialogInput.value.trim();
  const { names, allow, blockExisting, confirmLabel } = nameDialogState;
  const problem = patternNameProblem(name);
  const collides = !problem && name !== allow && names.has(name);
  nameDialogNote.textContent = problem
    || (collides
      ? (blockExisting ? `"${name}" already exists` : `"${name}" already exists - saving replaces it`)
      : '');
  nameDialogNote.classList.toggle('warn', !problem && collides && !blockExisting);
  nameDialogConfirm.disabled = !!problem || (collides && blockExisting);
  nameDialogConfirm.textContent = collides && !blockExisting ? 'overwrite' : confirmLabel;
}

function closeNameDialog(result) {
  if (!nameDialogResolve) return;
  const done = nameDialogResolve;
  nameDialogResolve = null;
  nameDialogBackdrop.classList.add('hidden');
  done(result);
}

// Resolves to a name, or null if the user backed out.
async function askPatternName({ title, value = '', confirmLabel = 'save', allow = null, blockExisting = false }) {
  let resolveThis;
  const answer = new Promise((resolve) => { resolveThis = resolve; });
  // Registered before the round trip below, so a second opener arriving mid-fetch resolves this
  // one instead of leaving its caller waiting on a dialog it no longer owns.
  closeNameDialog(null);
  nameDialogResolve = resolveThis;
  let names = new Set();
  try {
    const { patterns } = await api('GET', '/api/patterns?q=');
    names = new Set(patterns.map((p) => p.name));
  } catch {
    // no live collision warning this time - the save itself still works, and rename still refuses
    // to clobber server-side
  }
  if (nameDialogResolve !== resolveThis) return answer; // superseded, and already resolved null
  nameDialogState = { names, allow, blockExisting, confirmLabel };
  nameDialogTitle.textContent = title;
  nameDialogInput.value = value;
  nameDialogBackdrop.classList.remove('hidden');
  updateNameDialogState();
  nameDialogInput.focus();
  nameDialogInput.select();
  return answer;
}

nameDialogInput.addEventListener('input', updateNameDialogState);
// On the dialog rather than the input, so Enter and Escape still work once focus has tabbed onto
// one of the buttons.
nameDialogBackdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !nameDialogConfirm.disabled) closeNameDialog(nameDialogInput.value.trim());
  else if (e.key === 'Escape') closeNameDialog(null);
  e.stopPropagation(); // the editor's hotkeys have no business firing from inside a dialog
});
nameDialogConfirm.addEventListener('click', () => closeNameDialog(nameDialogInput.value.trim()));
document.getElementById('nameDialogClose').addEventListener('click', () => closeNameDialog(null));
nameDialogBackdrop.addEventListener('click', (e) => {
  if (e.target === nameDialogBackdrop) closeNameDialog(null);
});

// ----------------------------------------------------------------------------- saving and loading

// A name to offer when the buffer has never been saved: what an import came in as, else the
// pattern's own @title / first block label, slugged into a file name.
let saveNameHint = null;

function suggestedPatternName() {
  const code = cm.getValue();
  const label = saveNameHint
    || displayLabel({ title: parseMeta(code).title, code, borrowBlockLabel: true, fallback: '' });
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// A save is otherwise silent - Cmd+S writes a file that is usually on a tab you aren't looking at,
// and the console line confirming it may be collapsed. So pulse both the row it wrote to and the
// buffer it wrote: between them, one of the two is on screen whatever the sidebar is doing.
function flashSaved() {
  for (const el of [document.getElementById('saveFlash'), document.querySelector('.file-row.current')]) {
    if (!el) continue;
    el.classList.remove('saved-flash');
    void el.offsetWidth; // restart the animation rather than ignore a second save mid-pulse
    el.classList.add('saved-flash');
    el.addEventListener('animationend', () => el.classList.remove('saved-flash'), { once: true });
  }
}

async function writePatternFile(name) {
  try {
    await settlePluginState(); // a saved pattern must name the states it actually sounds like
    await api('POST', '/api/patterns/save', { name, code: cm.getValue() });
    saveNameHint = null;
    setCurrentSavedName(name); // this buffer is that file now - later saves go straight here
    checkpointUrl(); // findable in browser history under the name you just gave it
    logLine(`saved pattern "${name}"`);
    await refreshPatternFiles(); // re-rendering the list would blow away a flash started before it
    flashSaved();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// Keep the buffer where it already lives. Silent by design: overwriting the pattern you have open
// is what saving *is*, and a confirm on every one would only teach you to click through the
// dialog that matters (naming a save onto some *other* pattern - see savePatternFileAs).
async function savePatternFile() {
  if (!currentSavedName) return savePatternFileAs();
  await writePatternFile(currentSavedName);
}

async function savePatternFileAs() {
  const name = await askPatternName({
    title: 'save pattern as',
    value: currentSavedName || suggestedPatternName(),
    allow: currentSavedName,
  });
  if (name) await writePatternFile(name);
}

// Put `code` in the editor as the thing now being worked on: the outgoing buffer gets its own
// autosave file to sit in, and the incoming one becomes a history checkpoint. `name` is the saved
// pattern this code came out of, or null when it came from anywhere else - a session, an imported
// file - which leaves the buffer nameless until the user saves it under one.
async function openInEditor(code, name) {
  await rollWipSession();
  cm.setValue(code);
  foldConfigBlobs();
  saveNameHint = null;
  setCurrentSavedName(name);
  checkpointUrl();
}

async function loadPatternFile(name) {
  try {
    const { code } = await api('POST', '/api/patterns/load', { name });
    await openInEditor(code, name);
    logLine(`loaded pattern "${name}" - Cmd/Ctrl+Enter to play it`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function loadWipFile(entry) {
  try {
    const { code } = await api('POST', '/api/patterns/wip/load', { id: entry.id });
    await openInEditor(code, null); // an unnamed session stays unnamed until you keep it
    logLine(`loaded session "${entry.label}" - hit save to keep it under a name`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// Promote a session to a named pattern. The session file stays put - this copies out of the
// scratch pile rather than moving, so nothing is lost if the name was a mistake.
async function keepWipFile(entry) {
  const name = await askPatternName({
    title: 'keep this session as',
    value: entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    confirmLabel: 'keep',
  });
  if (!name) return;
  try {
    const { code } = await api('POST', '/api/patterns/wip/load', { id: entry.id });
    await api('POST', '/api/patterns/save', { name, code });
    // Keeping the session you're playing right now is the same act as saving the buffer under a
    // name, so the editor comes away pointed at that pattern. Keeping any *other* session only
    // files it away and leaves the buffer where it was.
    if (entry.id === wipSessionId && !currentSavedName) setCurrentSavedName(name);
    logLine(`kept session "${entry.label}" as pattern "${name}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function deleteWipFile(entry) {
  if (!confirm(`delete the session "${entry.label}"?`)) return;
  try {
    await api('POST', '/api/patterns/wip/delete', { id: entry.id });
    logLine(`deleted session "${entry.label}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function renamePatternFile(name) {
  const to = await askPatternName({
    title: `rename "${name}"`,
    value: name,
    confirmLabel: 'rename',
    allow: name,
    blockExisting: true, // renaming never overwrites - the server refuses it too
  });
  if (!to || to === name) return;
  try {
    await api('POST', '/api/patterns/rename', { from: name, to });
    if (currentSavedName === name) setCurrentSavedName(to); // the open pattern followed its file
    logLine(`renamed pattern "${name}" to "${to}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

async function deletePatternFile(name) {
  if (!confirm(`delete pattern "${name}"?`)) return;
  try {
    await api('POST', '/api/patterns/delete', { name });
    // Deleting the pattern you have open cuts the buffer loose rather than leaving save pointed at
    // a file that isn't there - the code is still in the editor, it just needs a name again.
    if (currentSavedName === name) setCurrentSavedName(null);
    logLine(`deleted pattern "${name}"`);
    refreshPatternFiles();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// Start a fresh buffer. Clears the editor and cuts it loose from whatever file was open (so the
// next save asks for a name rather than overwriting the last pattern). No confirm needed: the
// buffer being cleared was autosaved to its own work-in-progress file on the way out.
async function newPatternFile() {
  const had = cm.getValue().trim();
  await rollWipSession();
  cm.setValue('');
  saveNameHint = null;
  setCurrentSavedName(null);
  logLine(had
    ? 'new pattern - the previous buffer is under "work in progress" below'
    : 'new pattern - write it, then hit save to keep it under a name');
  cm.focus();
}

fileSaveBtn.addEventListener('click', savePatternFile);
fileSaveAsBtn.addEventListener('click', savePatternFileAs);
fileExportBtn.addEventListener('click', exportPatch);
fileImportBtn.addEventListener('click', () => fileImportInput.click());
fileImportInput.addEventListener('change', () => {
  importPatch(fileImportInput.files?.[0]);
  fileImportInput.value = ''; // so re-picking the same file fires 'change' again
});
fileNewBtn.addEventListener('click', newPatternFile);

// ---------------------------------------------------------------------------------------------
// MIDI file import - drop a .mid anywhere on the window and it becomes lanes in the buffer.
//
// The file is read in the browser and written out as DRAWN ROLLS, one per lane:
//
//   bass: pianoroll("36,0,4 47,9,3,0.5", { grid: 8, len: 16 })
//
// A roll rather than mini-notation because it's the form that stays editable - double-click the
// `pianoroll` name and the notes are there on a grid to drag, retime and audition - and because
// nothing is given up by landing here: the roll's own →♪ writes the mini-notation whenever it's
// wanted, in scale degrees if the roll is folded to the key, which is the same rewrite an import
// straight to text used to do in one shot.
//
// One lane per (track, channel) the file plays, named after the file's own track names where it
// has them. The dialog settles the two things the file can't say: which grid to snap the rhythm to
// (auto-detected per lane - see midifile.mjs's pickGrid) and what KEY the music is in. The key is
// guessed from the notes and only ever offered - taking it writes the buffer's `setscale(...)`, so
// the rolls open coloured and foldable in that key and convert to degrees later; out-of-key notes
// are counted first, since that count is how good the guess looks.
//
// Nothing is evaluated by the import: the new lanes have no instrument on them yet, so they start
// playing at the next Cmd/Ctrl+Enter, once there's a .synth() on the end.
// ---------------------------------------------------------------------------------------------

const midiImportBackdrop = document.getElementById('midiImportBackdrop');
const midiImportSummary = document.getElementById('midiImportSummary');
const midiImportGridSel = document.getElementById('midiImportGrid');
const midiImportKeyBox = document.getElementById('midiImportSetKey');
const midiImportKeyBoxRow = midiImportKeyBox.closest('.midi-import-row');
const midiImportKeyRow = document.getElementById('midiImportKeyRow');
const midiImportKeyInput = document.getElementById('midiImportKey');
const midiImportKeyList = document.getElementById('midiImportKeys');
const midiImportNote = document.getElementById('midiImportNote');
const midiImportGo = document.getElementById('midiImportGo');
const fileDropOverlay = document.getElementById('fileDropOverlay');

// value -> label. The values are cells per cycle (a cycle is 4 beats, so 4 = quarter notes);
// 'auto' lets each lane keep its own detected grid, and 0 is the recorder's unquantized fallback -
// a roll's cells are whole numbers, so "off" means the fine 1/96 grid that keeps the feel.
const MIDI_IMPORT_GRIDS = [
  ['auto', 'auto'],
  ['4', '4 · quarters'],
  ['8', '8 · eighths'],
  ['12', '12 · eighth triplets'],
  ['16', '16 · sixteenths'],
  ['24', '24 · sixteenth triplets'],
  ['32', '32 · thirty-seconds'],
  ['0', 'off · keep the timing'],
];

// The fraction of out-of-key notes below which the guessed key is offered pre-ticked. A key the
// file mostly doesn't sit in is a bad guess, and setscale is global - see the dialog's footer.
const MIDI_IMPORT_SCALE_FIT = 0.05;

let midiImportState = null; // { file, midifile, parsed, guess, existing } while the dialog is open
let midiImportModsPromise = null;

// midifile.mjs isn't part of the startup import - nothing needs it until a file is dropped.
function midiImportMods() {
  if (!midiImportModsPromise) midiImportModsPromise = import('/pattern-core/midifile.mjs');
  return midiImportModsPromise;
}

const MIDI_FILE_RE = /\.midi?$/i;
const MIDI_MIME_RE = /^audio\/(x-)?midi$/i;

const dragHasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

const midiFileIn = (dt) =>
  Array.from(dt?.files ?? []).find((f) => MIDI_FILE_RE.test(f.name) || MIDI_MIME_RE.test(f.type)) ?? null;

// dragenter/dragleave fire once per element the pointer crosses, so the overlay is refcounted -
// toggling it directly makes it flicker every time the drag passes over a child.
let fileDragDepth = 0;

function endFileDrag() {
  fileDragDepth = 0;
  fileDropOverlay.classList.add('hidden');
}

document.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  fileDragDepth++;
  fileDropOverlay.classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  if (dragHasFiles(e) && --fileDragDepth <= 0) endFileDrag();
});
document.addEventListener('dragend', endFileDrag); // a drag abandoned mid-flight leaves no leave
document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); // a drop target that never says so leaves the browser to open the file
  e.dataTransfer.dropEffect = 'copy';
}, true);
document.addEventListener('drop', (e) => {
  endFileDrag();
  const file = midiFileIn(e.dataTransfer);
  if (!file) {
    // Not ours: CodeMirror inserts a dropped text file itself, so leave drops on the editor to it.
    // Elsewhere, swallow the drop rather than letting the browser navigate away from the patch.
    if (!cm.getWrapperElement().contains(e.target)) e.preventDefault();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  openMidiImport(file);
}, true);

const midiErr = (e) => String(e?.message ?? e).replace(/^\[[\w-]+\]\s*/, '');

async function openMidiImport(file) {
  let midifile;
  let parsed;
  try {
    midifile = await midiImportMods();
    parsed = midifile.midiFileToLanes(await file.arrayBuffer());
  } catch (e) {
    logLine(`midi import (${file.name}): ${midiErr(e)}`, true);
    return;
  }

  const pitched = parsed.lanes.filter((l) => !l.drums).flatMap((l) => l.events);
  midiImportState = {
    file,
    midifile,
    parsed,
    guess: midifile.detectKey(pitched),
    existing: bufferSetscale(),
  };

  const { bpm, timeSig, cycles, noteCount, lanes } = parsed;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = [
    file.name,
    plural(noteCount, 'note'),
    plural(lanes.length, 'lane'),
    plural(cycles, 'cycle'),
    `${Math.round(bpm)} bpm`,
  ];
  if (timeSig.num !== 4 || timeSig.den !== 4) {
    summary.push(`${timeSig.num}/${timeSig.den} — a cycle is 4 beats, so its bars land off the grid`);
  }
  if (midiImportState.guess) summary.push(`sounds like ${midiImportState.guess.scale}`);
  midiImportSummary.textContent = summary.join(' · ');

  if (!midiImportGridSel.options.length) {
    for (const [value, label] of MIDI_IMPORT_GRIDS) {
      midiImportGridSel.appendChild(new Option(label, value));
    }
  }
  midiImportGridSel.value = 'auto';

  // The field shows what was DETECTED, best fit first. It deliberately does not default to the key
  // the buffer is already in: that made every import after the first suggest the first import's
  // key forever, whatever the new file actually was. The buffer's key is still offered in the list
  // (and reflectMidiImportKey warns that picking something else re-keys the patch).
  const suggestions = [];
  for (const name of [...(midiImportState.guess?.ranked ?? []).slice(0, 6).map((r) => r.scale), midiImportState.existing?.key]) {
    if (name && !suggestions.includes(name)) suggestions.push(name);
  }
  midiImportKeyList.innerHTML = '';
  for (const name of suggestions) midiImportKeyList.appendChild(new Option(name, name));
  midiImportKeyInput.value = midiImportState.guess?.scale ?? midiImportState.existing?.key ?? '';

  // Pre-ticked only when the guess fits well AND the buffer has no key of its own: setscale is
  // global, so re-keying a patch that already says what key it's in is never something to do by
  // default. It stays one click away, with the warning in the footer.
  const fit = midiImportOffKey(midiImportKeyInput.value);
  const canScale = !!(pitched.length && suggestions.length && notesMod);
  midiImportKeyBox.disabled = !canScale;
  midiImportKeyBox.checked =
    canScale && !midiImportState.existing && !!fit && !fit.bad && fit.off <= fit.total * MIDI_IMPORT_SCALE_FIT;
  midiImportKeyBoxRow.classList.toggle('disabled', !canScale);

  reflectMidiImportKey();
  midiImportBackdrop.classList.remove('hidden');
  midiImportGo.focus();
}

function closeMidiImport() {
  midiImportBackdrop.classList.add('hidden');
  midiImportState = null;
}

/**
 * The `setscale("…")` call the buffer already carries, or null. The LAST one wins (the server
 * hoists it - see its evaluate route), so that's the one reported and the one an import edits.
 */
function bufferSetscale() {
  const code = cm.getValue();
  const re = /^[^\S\n]*setscale\s*\(\s*(['"])([^'"]*)\1\s*\)/gm;
  let last = null;
  let m;
  while ((m = re.exec(code))) last = { key: m[2], from: m.index, to: m.index + m[0].length };
  return last;
}

/** How many of the file's pitched notes fall outside `keyName`, or `{ bad: true }` if it isn't one. */
function midiImportOffKey(keyName) {
  if (!midiImportState || !notesMod) return null;
  const name = String(keyName ?? '').trim();
  try {
    notesMod.parseScaleName(name);
  } catch {
    return { bad: true };
  }
  let off = 0;
  let total = 0;
  for (const lane of midiImportState.parsed.lanes) {
    if (lane.drums) continue; // percussion "pitches" are drum slots - no key to be in or out of
    for (const ev of lane.events) {
      total++;
      if (notesMod.quantizeToScale(ev.note, name) !== ev.note) off++;
    }
  }
  return { off, total };
}

// Grey the key row out when the key is being left alone, and say what taking it would mean. The
// notes themselves are unaffected either way - a roll holds pitches - so what's reported is how
// well the key fits them, and whether it moves a patch that was already in another one.
function reflectMidiImportKey() {
  const on = midiImportKeyBox.checked && !midiImportKeyBox.disabled;
  midiImportKeyRow.classList.toggle('disabled', !on);
  midiImportNote.textContent = '';
  if (!on) return;
  const key = midiImportKeyInput.value.trim();
  const fit = midiImportOffKey(key);
  if (!fit) return;
  if (fit.bad) {
    midiImportNote.textContent = `"${key}" isn't a scale name`;
  } else if (midiImportState?.existing && midiImportState.existing.key !== key) {
    // setscale is global and hoisted, so taking another key moves the whole patch.
    midiImportNote.textContent = `the buffer is in ${midiImportState.existing.key} — this re-keys all of it`;
  } else if (fit.off) {
    midiImportNote.textContent = `${fit.off} of ${fit.total} notes aren't in this key`;
  }
}

midiImportKeyBox.addEventListener('change', reflectMidiImportKey);
midiImportKeyInput.addEventListener('input', reflectMidiImportKey);
midiImportGo.addEventListener('click', runMidiImport);
midiImportKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runMidiImport(); }
});
document.getElementById('midiImportClose').addEventListener('click', closeMidiImport);
midiImportBackdrop.addEventListener('click', (e) => { if (e.target === midiImportBackdrop) closeMidiImport(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !midiImportBackdrop.classList.contains('hidden')) closeMidiImport();
});

/** A MIDI track name -> a label the buffer can carry, unique against `taken` (which it joins). */
function midiLaneLabel(name, taken) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_$]+/g, '_')
    .replace(/^[^a-z$]+/, '') // a leading digit is invalid; a leading _ would mute the lane
    .replace(/_+$/, '');
  if (!base) return '$'; // anonymous: the server numbers these $1, $2, … by position
  let label = base;
  for (let n = 2; taken.has(label); n++) label = `${base}${n}`;
  taken.add(label);
  return label;
}

function runMidiImport() {
  const st = midiImportState;
  if (!st) return;
  const takeKey = midiImportKeyBox.checked && !midiImportKeyBox.disabled;
  const key = midiImportKeyInput.value.trim();
  if (takeKey && midiImportOffKey(key)?.bad) {
    reflectMidiImportKey(); // the footer already says why the key doesn't parse
    return;
  }

  const chosen = midiImportGridSel.value;
  const taken = new Set(labelsMod ? labelsMod.splitLabeledBlocks(cm.getValue()).map((b) => b.label) : []);
  const lines = [];
  const names = [];
  let unquantized = 0;
  try {
    const { entries } = st.midifile.midiLanesToPianoroll(st.parsed, {
      grid: chosen === 'auto' ? 'auto' : Number(chosen),
    });
    for (const entry of entries) {
      const label = midiLaneLabel(entry.name, taken);
      names.push(label);
      lines.push(`${label}: ${entry.code}`);
      // Only worth saying when the grid was left to the detector - asking for "off" is asking for
      // exactly this.
      if (!entry.quantized && chosen === 'auto') unquantized++;
    }
  } catch (e) {
    midiImportNote.textContent = midiErr(e);
    return;
  }

  // The key line, if the buffer doesn't already say it. setscale is hoisted and global, so a
  // second one would silently re-key every other lane - the existing call is edited instead.
  // Re-read rather than trusting what the dialog opened on: the buffer is editable behind it.
  const existing = bufferSetscale();
  let reKeyed = null;
  if (takeKey && existing && existing.key !== key) {
    cm.replaceRange(`setscale("${key}")`, cm.posFromIndex(existing.from), cm.posFromIndex(existing.to));
    reKeyed = existing.key;
  } else if (takeKey && !existing) {
    lines.unshift(`setscale("${key}")`);
  }

  const code = cm.getValue();
  const at = cm.posFromIndex(code.length);
  // Exactly one blank line between the buffer and the import, counting whatever newlines the
  // buffer already ends with.
  const trailing = /\n*$/.exec(code)[0].length;
  const gap = code.trim() ? '\n'.repeat(Math.max(0, 2 - trailing)) : '';
  const text = gap + lines.join('\n\n') + '\n';
  cm.replaceRange(text, at, at);
  // Park the cursor on the end of the last lane rather than the blank line under it - that's
  // where the `.synth("…")` it still needs goes.
  const caret = cm.posFromIndex(code.length + text.replace(/\n+$/, '').length);
  cm.setCursor(caret);
  cm.scrollIntoView(caret, 80);
  cm.focus();

  closeMidiImport();
  logLine(
    `midi import: ${st.file.name} → ${names.length} piano roll${names.length === 1 ? '' : 's'} (${names.join(', ')})` +
      `${takeKey ? ` in ${key}` : ''} - double-click a pianoroll name to edit or convert it, and add a` +
      ' .synth() then Cmd/Ctrl+Enter to play',
  );
  if (unquantized) {
    logLine(
      `midi import: ${unquantized} lane${unquantized === 1 ? '' : 's'} sat on no grid, so ` +
        `${unquantized === 1 ? 'it was' : 'they were'} drawn on fine cells to keep the timing`,
    );
  }
  if (reKeyed) logLine(`midi import: re-keyed the buffer from ${reKeyed} to ${key} (setscale is global)`, true);
}

// ---------------------------------------------------------------------------------------------
// Minimizable sidebar + console - collapsed state persists per browser.
// ---------------------------------------------------------------------------------------------

function initCollapsible(el, toggleBtn, storageKey, labels) {
  const apply = (collapsed) => {
    el.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? labels.collapsed : labels.open;
    localStorage.setItem(storageKey, collapsed ? '1' : '');
  };
  toggleBtn.addEventListener('click', () => apply(!el.classList.contains('collapsed')));
  apply(!!localStorage.getItem(storageKey));
  return apply; // so callers (e.g. the ctrl+p hotkey) can drive the collapse programmatically
}

const setSidebarCollapsed = initCollapsible(sidebar, sidebarToggle, 'poptart-sidebar-collapsed', { open: '»', collapsed: '«' });
initCollapsible(consoleFooter, consoleToggle, 'poptart-console-collapsed', { open: '▾', collapsed: '▴' });

// ---------------------------------------------------------------------------------------------
// Themes: presets are palette blocks in style.css (`:root[data-theme="…"]`); the theme editor
// lets you build a "custom" theme on top of whichever preset is active - every color is a CSS
// variable, so edits are just inline overrides on <html>, persisted to localStorage (and
// re-applied pre-paint by index.html).
// ---------------------------------------------------------------------------------------------

const PRESET_THEMES = ['poptart', 'blueberry', 'matcha', 'paper', 'glossing'];
const CUSTOM_KEY = 'poptart-custom-theme';
const CUSTOM_BASE_KEY = 'poptart-custom-base';
const SAVED_KEY = 'poptart-saved-themes';

const THEME_VARS = [
  ['--bg', 'background'],
  ['--bg-raised', 'raised bg'],
  ['--bg-panel', 'panel bg'],
  ['--border', 'border'],
  ['--text', 'text'],
  ['--text-dim', 'dim text'],
  ['--accent', 'accent'],
  ['--ok', 'ok / ready'],
  ['--err', 'error'],
  ['--warn', 'warning'],
  ['--selection', 'selection'],
  ['--linenumber', 'line numbers'],
  ['--syn-string', 'syntax: strings'],
  ['--syn-number', 'syntax: numbers'],
  ['--syn-keyword', 'syntax: keywords'],
  ['--syn-variable', 'syntax: variables'],
  ['--syn-property', 'syntax: properties'],
  ['--syn-comment', 'syntax: comments'],
];

const themeSelect = document.getElementById('themeSelect');
const themeEditBtn = document.getElementById('themeEditBtn');
const themePanel = document.getElementById('themePanel');
const themeVarsEl = document.getElementById('themeVars');
const themeResetBtn = document.getElementById('themeReset');
const themeCloseBtn = document.getElementById('themeClose');
const themeNameInput = document.getElementById('themeNameInput');
const themeSaveBtn = document.getElementById('themeSaveBtn');

function savedCustomTheme() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY)) ?? null;
  } catch {
    return null;
  }
}

// Named themes the user has saved: { name: { base: presetName, vars: { '--x': '#..' } } }.
function savedThemes() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeSavedThemes(map) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(map));
}

function rebuildThemeOptions() {
  themeSelect.innerHTML = '';
  for (const t of PRESET_THEMES) themeSelect.add(new Option(t, t));
  for (const name of Object.keys(savedThemes()).sort()) themeSelect.add(new Option(name, name));
  // The unsaved working draft sits last, flagged so it reads as ephemeral.
  if (savedCustomTheme()) themeSelect.add(new Option('custom (unsaved)', 'custom'));
}

function applyTheme(name) {
  const root = document.documentElement;
  // Clear any custom inline overrides first, then re-apply for draft or saved themes.
  for (const [v] of THEME_VARS) root.style.removeProperty(v);
  const saved = savedThemes();
  if (name === 'custom') {
    const custom = savedCustomTheme() ?? {};
    root.dataset.theme = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
    for (const [v, value] of Object.entries(custom)) root.style.setProperty(v, value);
  } else if (saved[name]) {
    root.dataset.theme = saved[name].base ?? 'poptart';
    for (const [v, value] of Object.entries(saved[name].vars ?? {})) root.style.setProperty(v, value);
  } else {
    root.dataset.theme = name;
  }
  localStorage.setItem('poptart-theme', name);
  themeSelect.value = name;
  updateThemeControls();
  if (!themePanel.classList.contains('hidden')) populateThemeInputs();
}

// The reset button doubles as discard (unsaved draft) / delete (saved theme); save is only
// meaningful when there's a draft to name.
function updateThemeControls() {
  const cur = themeSelect.value;
  const isDraft = cur === 'custom';
  const isSaved = !!savedThemes()[cur];
  themeSaveBtn.disabled = !isDraft;
  themeNameInput.disabled = !isDraft;
  if (isDraft) {
    themeResetBtn.hidden = false;
    themeResetBtn.textContent = 'discard';
    themeResetBtn.title = 'discard unsaved edits and go back to the base theme';
  } else if (isSaved) {
    themeResetBtn.hidden = false;
    themeResetBtn.textContent = 'delete';
    themeResetBtn.title = 'delete this saved theme';
  } else {
    themeResetBtn.hidden = true;
  }
}

// Computed styles come back as rgb(r, g, b); <input type="color"> wants #rrggbb.
function cssColorToHex(color) {
  const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color.trim());
  if (!m) return color.trim(); // already hex (inline overrides are stored as hex)
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function populateThemeInputs() {
  const computed = getComputedStyle(document.documentElement);
  themeVarsEl.innerHTML = '';
  for (const [varName, label] of THEME_VARS) {
    const row = document.createElement('label');
    row.className = 'theme-var-row';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = cssColorToHex(computed.getPropertyValue(varName));
    input.addEventListener('input', () => setCustomVar(varName, input.value));
    row.append(span, input);
    themeVarsEl.appendChild(row);
  }
}

function setCustomVar(varName, value) {
  // First edit forks the current preset into the custom theme: snapshot every variable so the
  // custom theme is complete and stable even if the base preset later changes.
  let custom = savedCustomTheme();
  if (!custom || themeSelect.value !== 'custom') {
    const computed = getComputedStyle(document.documentElement);
    custom = Object.fromEntries(THEME_VARS.map(([v]) => [v, cssColorToHex(computed.getPropertyValue(v))]));
    localStorage.setItem(CUSTOM_BASE_KEY, document.documentElement.dataset.theme ?? 'poptart');
  }
  custom[varName] = value;
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  rebuildThemeOptions();
  localStorage.setItem('poptart-theme', 'custom');
  themeSelect.value = 'custom';
  document.documentElement.style.setProperty(varName, value);
  // Make sure all snapshot values are applied (first edit only sets one inline var otherwise).
  for (const [v, val] of Object.entries(custom)) document.documentElement.style.setProperty(v, val);
  updateThemeControls();
}

// Promote the current colors into a named theme, then clear the working draft.
function saveTheme() {
  const name = themeNameInput.value.trim();
  if (!name) return;
  if (PRESET_THEMES.includes(name) || name === 'custom') {
    logLine(`"${name}" is a reserved name — pick another`, true);
    return;
  }
  const computed = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(THEME_VARS.map(([v]) => [v, cssColorToHex(computed.getPropertyValue(v))]));
  const base = document.documentElement.dataset.theme ?? 'poptart';
  const map = savedThemes();
  const existed = !!map[name];
  map[name] = { base, vars };
  writeSavedThemes(map);
  localStorage.removeItem(CUSTOM_KEY);
  localStorage.removeItem(CUSTOM_BASE_KEY);
  themeNameInput.value = '';
  rebuildThemeOptions();
  applyTheme(name);
  logLine(existed ? `updated theme "${name}"` : `saved theme "${name}"`);
}

themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
themeEditBtn.addEventListener('click', () => {
  themePanel.classList.toggle('hidden');
  if (!themePanel.classList.contains('hidden')) {
    populateThemeInputs();
    updateThemeControls();
  }
});
themeCloseBtn.addEventListener('click', () => themePanel.classList.add('hidden'));
themeSaveBtn.addEventListener('click', saveTheme);
themeNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveTheme(); }
});
themeResetBtn.addEventListener('click', () => {
  const cur = themeSelect.value;
  if (cur === 'custom') {
    // Discard the unsaved draft, returning to whichever theme it forked from.
    localStorage.removeItem(CUSTOM_KEY);
    const base = localStorage.getItem(CUSTOM_BASE_KEY) ?? 'poptart';
    localStorage.removeItem(CUSTOM_BASE_KEY);
    rebuildThemeOptions();
    applyTheme(PRESET_THEMES.includes(base) || savedThemes()[base] ? base : 'poptart');
  } else if (savedThemes()[cur]) {
    // Delete this saved theme, falling back to its base preset.
    const map = savedThemes();
    const base = map[cur].base ?? 'poptart';
    delete map[cur];
    writeSavedThemes(map);
    rebuildThemeOptions();
    applyTheme(PRESET_THEMES.includes(base) ? base : 'poptart');
    logLine(`deleted theme "${cur}"`);
  }
});

rebuildThemeOptions();
{
  const saved = localStorage.getItem('poptart-theme') ?? 'poptart';
  const valid = saved === 'custom'
    ? !!savedCustomTheme()
    : PRESET_THEMES.includes(saved) || !!savedThemes()[saved];
  themeSelect.value = valid ? saved : 'poptart';
  updateThemeControls();
  // index.html already applied the theme pre-paint; this just syncs the picker.
}

// ---------------------------------------------------------------------------------------------

playBtn.addEventListener('click', togglePlay);
updateBtn.addEventListener('click', () => evaluate(false));
scanBtn.addEventListener('click', doScan);

refreshStatus().then((loaded) => {
  if (loaded) loadKnownPlugins();
});
initMacros();

// ---------------------------------------------------------------------------------------------
// Hotkeys - a small dispatcher plus a userland API. Built-in transport/UI chords are registered
// here; everything else is meant to live in the user's prebake, which the browser runs through
// runUserPrebake() (the same file the server runs for DSL defs - browser-only calls like
// hotkey()/editor no-op on the server, DSL builders no-op here). See the `hotkey`, `editor`, and
// the util helpers handed to that sandbox below.
//
// Matching is on event.code (physical key position), so a chord fires regardless of which
// character Shift/AltGr would produce - `cmd+shift+.` matches the `.` key even though the event's
// .key is `>`. Combos are strings like 'cmd+shift+0', 'ctrl+p', 'mod+enter' (mod = cmd on macOS,
// ctrl elsewhere). Modifiers: cmd/meta, ctrl, alt/option, shift, mod.
// ---------------------------------------------------------------------------------------------

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
  const spec = { meta: false, ctrl: false, shift: false, alt: false, mod: false, code: null, key: null };
  for (const raw of String(combo).toLowerCase().split('+')) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === 'cmd' || tok === 'meta' || tok === 'command' || tok === 'win' || tok === 'super') spec.meta = true;
    else if (tok === 'ctrl' || tok === 'control') spec.ctrl = true;
    else if (tok === 'shift') spec.shift = true;
    else if (tok === 'alt' || tok === 'option' || tok === 'opt') spec.alt = true;
    else if (tok === 'mod') spec.mod = true;
    else { spec.code = keyTokenToCode(tok); spec.key = tok; }
  }
  return spec;
}

function specMatches(spec, e) {
  const wantMeta = spec.meta || (spec.mod && IS_MAC);
  const wantCtrl = spec.ctrl || (spec.mod && !IS_MAC);
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== spec.alt) return false;
  if (e.shiftKey !== spec.shift) return false;
  if (spec.code) return e.code === spec.code;
  return spec.key != null && e.key.toLowerCase() === spec.key;
}

const builtinHotkeys = []; // app chords - persist for the session
let userHotkeys = []; // registered from the prebake - cleared and rebuilt on every prebake run

function addHotkey(list, combo, handler, label) {
  list.push({ spec: comboToSpec(combo), handler, combo, label });
}

async function runHotkey(hk, e) {
  try {
    await hk.handler(e);
  } catch (err) {
    logLine(`hotkey ${hk.combo}: ${err.message ?? err}`, true);
  }
}

// A blocking modal (prebake editor, folder picker, midi import) is open - don't let chords reach
// through it.
function anyModalOpen() {
  return [prebakeBackdrop, dirPickerBackdrop, midiImportBackdrop].some((el) => !el.classList.contains('hidden'));
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.repeat || anyModalOpen()) return;
    for (const hk of builtinHotkeys) {
      if (specMatches(hk.spec, e)) { e.preventDefault(); e.stopPropagation(); runHotkey(hk, e); return; }
    }
    for (const hk of userHotkeys) {
      if (specMatches(hk.spec, e)) { e.preventDefault(); e.stopPropagation(); runHotkey(hk, e); return; }
    }
  },
  true, // capture, so we beat CodeMirror and can suppress the keystroke
);

// --- built-in chords (Ctrl-based: free on macOS where Cmd owns the browser shortcuts) ---

// ctrl+p - minimize/restore the RHS panel, keeping whatever tab was open.
addHotkey(builtinHotkeys, 'ctrl+p', () => {
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}, 'toggle sidebar');

// ctrl+r - arm/stop MIDI recording (mirrors the ● rec button).
addHotkey(builtinHotkeys, 'ctrl+r', () => (recState ? cancelMidiRecord(true) : startMidiRecord()), 'toggle record');

// ctrl+b - bounce the block the cursor is in to audio (mirrors the record panel's button).
addHotkey(builtinHotkeys, 'ctrl+b', () => bounceBlockAtCursor(), 'bounce block to audio');

// ctrl+m - toggle the keyboard/tap instrument between off and midi.
addHotkey(builtinHotkeys, 'ctrl+m', () => setKbMode(kbMode === 'normal' ? 'midi' : 'normal'), 'toggle midi keyboard');

// ---------------------------------------------------------------------------------------------
// Userland API + sandbox. runUserPrebake() executes the prebake source in a function scope where
// the DSL builder names are chainable no-ops (so `const kick = s("bd*4")` doesn't throw here) and
// hotkey()/editor/util helpers are real. This is what lets a single prebake file carry both DSL
// setup (meaningful on the server) and hotkeys/UI code (meaningful in the browser).
// ---------------------------------------------------------------------------------------------

// A chainable no-op: any property access returns a function that returns the same stub, and
// calling it returns the stub too - so arbitrary builder/method chains evaluate without error.
function makeChainStub() {
  const stub = new Proxy(function () {}, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : () => stub),
    apply: () => stub,
  });
  return stub;
}

// editor: a thin, offset-based facade over the main CodeMirror instance, close to Strudel's `repl`
// so ports read the same. Offsets are character indices into the whole document.
const editor = {
  get cm() { return cm; },
  get code() { return cm.getValue(); },
  getCode() { return cm.getValue(); },
  setCode(str) { cm.setValue(str); },
  appendCode(str) {
    const end = cm.posFromIndex(cm.getValue().length);
    cm.replaceRange(str, end);
  },
  insertCode(str, at) {
    const pos = at == null ? cm.getCursor() : cm.posFromIndex(at);
    cm.replaceRange(str, pos);
  },
  replaceCode(str, from, to) {
    cm.replaceRange(str, cm.posFromIndex(from), cm.posFromIndex(to));
  },
  sliceCode(from, to) {
    return cm.getRange(cm.posFromIndex(from), cm.posFromIndex(to));
  },
  getCursorLocation() { return cm.indexFromPos(cm.getCursor()); },
  setCursorLocation(at) { cm.setCursor(cm.posFromIndex(at)); cm.focus(); },
  // { from, to, text } as character offsets; from === to when nothing is selected.
  getSelection() {
    const from = cm.indexFromPos(cm.getCursor('from'));
    const to = cm.indexFromPos(cm.getCursor('to'));
    return { from, to, text: cm.getRange(cm.posFromIndex(from), cm.posFromIndex(to)) };
  },
  focus() { cm.focus(); },
};

// Euclidean rhythm (Bjorklund): `pulses` hits spread as evenly as possible over `steps`,
// returned as a boolean array. Standard livecoding helper the ported hotkeys lean on.
function bjorklund(pulses, steps) {
  pulses = Math.max(0, Math.min(Math.floor(pulses), Math.floor(steps)));
  steps = Math.max(0, Math.floor(steps));
  if (steps === 0) return [];
  if (pulses === 0) return new Array(steps).fill(false);
  let groups = [];
  for (let i = 0; i < pulses; i++) groups.push([true]);
  let remainders = [];
  for (let i = 0; i < steps - pulses; i++) remainders.push([false]);
  while (remainders.length > 1) {
    const n = Math.min(groups.length, remainders.length);
    const nextGroups = [], nextRemainders = [];
    for (let i = 0; i < n; i++) nextGroups.push(groups[i].concat(remainders[i]));
    if (groups.length > n) for (let i = n; i < groups.length; i++) nextRemainders.push(groups[i]);
    else for (let i = n; i < remainders.length; i++) nextRemainders.push(remainders[i]);
    groups = nextGroups;
    remainders = nextRemainders;
  }
  return groups.concat(remainders).flat();
}

// Rotate an array by n (positive = left). Negative and out-of-range n wrap.
function rotate(arr, n) {
  const len = arr.length;
  if (!len) return arr.slice();
  const k = ((n % len) + len) % len;
  return arr.slice(k).concat(arr.slice(0, k));
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// The DSL builder names to stub in the browser sandbox (real on the server). Sourced from the
// same BUILDERS list the autocomplete uses, so new builders are covered automatically.
const PREBAKE_STUB_NAMES = [...new Set(BUILDERS)];

// Names/values handed to every prebake run. Order must stay paired.
function prebakeScope() {
  const names = [];
  const values = [];
  const api = {
    hotkey: (combo, handler) => addHotkey(userHotkeys, combo, handler, 'user'),
    editor,
    repl: editor, // alias so Strudel-style ports read unchanged
    prompt: (msg, def) => Promise.resolve(window.prompt(msg, def == null ? '' : String(def))),
    alert: (msg) => window.alert(msg),
    log: (msg) => logLine(String(msg)),
    bjorklund,
    rotate,
    clamp,
    // Pure music-theory helpers, real here exactly as in patterns/setup (see server.js). Called
    // through notesMod so they track the loaded module; hotkey handlers run well after load, and
    // the startup prebake waits on coreReady, so notesMod is always ready by call time.
    noteToMidi: (name) => notesMod.noteToMidi(name),
    degreeToMidi: (degree, scaleName) => notesMod.degreeToMidi(degree, scaleName),
    parseScaleName: (scaleName) => notesMod.parseScaleName(scaleName),
  };
  for (const [n, v] of Object.entries(api)) { names.push(n); values.push(v); }
  // Each remaining builder is a chainable Proxy: callable (so `s("bd*4")` works), tolerant of
  // property sets (so `Signal.prototype.foo = …` doesn't throw), and every access/call returns a
  // stub. Names the api above already provides for real (the music-theory helpers, which are
  // builders too) keep the real one - and must not be pushed twice, since a duplicate parameter
  // name is a SyntaxError in the strict-mode function the sandbox compiles.
  for (const n of PREBAKE_STUB_NAMES) {
    if (n in api) continue;
    names.push(n);
    values.push(makeChainStub());
  }
  return { names, values };
}

// Clear any hotkeys a previous prebake run registered, then execute `code` in the sandbox. Errors
// are logged, not thrown - a broken prebake must never take the editor down. Called at startup and
// again whenever the prebake is saved.
function runUserPrebake(code) {
  userHotkeys = [];
  if (!code || !code.trim()) return;
  const { names, values } = prebakeScope();
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=poptart-prebake.js`);
    fn(...values);
  } catch (err) {
    logLine(`prebake (browser): ${err.message ?? err}`, true);
  }
}

// Load and run the prebake once at startup for its hotkeys/UI side. A missing file is fine. Wait
// on coreReady first so a top-level noteToMidi()/etc. in the prebake sees the loaded notes module.
coreReady
  .then(() => api('GET', '/api/prebake'))
  .then(({ code }) => runUserPrebake(code))
  .catch(() => {});
