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
let mixctlMod = null; // mixctl.mjs - the mixer's gain/pan trim reads and code edits
// Resolves once pattern-core is loaded (or failed) - the startup prebake waits on it so a
// top-level noteToMidi()/etc. call in the prebake never races the import.
const coreReady = Promise.all([
  import('/pattern-core/mini.mjs'),
  import('/pattern-core/labels.mjs'),
  import('/pattern-core/shape.mjs'),
  import('/pattern-core/pianoroll.mjs'),
  import('/pattern-core/notes.mjs'),
  import('/pattern-core/mixctl.mjs'),
])
  .then(([m, l, s, pr, nt, mx]) => {
    miniMod = m;
    labelsMod = l;
    shapeMod = s;
    pianorollMod = pr;
    notesMod = nt;
    mixctlMod = mx;
    initLfoEditor();
    initPianorollEditor();
    initRecordPanel();
    initPresetPanel();
    initWidgetHandles(); // double-click a call's name to open its editor (needs all of the above)
    updateMutedDim();
    // Which spans are DATA (rather than roll ids) is a question only pianoroll.mjs can answer, so
    // the folds made before it landed have to be dropped and worked out again - re-running
    // foldConfigBlobs alone would find every span already marked and leave the wrong chips up.
    refoldAll();
  })
  .catch((e) => logLine(`pattern-core import failed (no live highlighting / lfo editor): ${e.message}`, true));

// ---------------------------------------------------------------------------------------------
// The definition registries live UP HERE, against every instinct about grouping, because the
// session restore below folds the buffer before this file's top level has run past a few hundred
// lines - and a `const` read inside its own temporal dead zone throws rather than reading
// undefined. Everything they close over is a hoisted function or is read lazily inside a
// callback, so nothing here depends on the rest of the file having been reached yet.
// ---------------------------------------------------------------------------------------------

// The piano roll's drawn notes.
const rollDefs = makeDefRegistry({
  kind: 'roll',
  section: 'pianorolls',
  defCall: '_roll',
  useCall: 'pianoroll',
  legacyCall: 'roll',
  emptyBody: '""',
  isData: (str) => (pianorollMod ? pianorollMod.looksLikeNoteString(str) : null),
  library: () => prPrebakeRolls,
  libraryNote: 'prebake',
  panel: {
    current: () => prState?.rollId ?? null,
    open: (id, carry) => openRollById(id, carry),
    close: () => closePianorollEditor(),
    carry: () => prCarry(),
    sourceCall: (refs) => sourceCallAmong(refs, prState?.source),
    setCurrent: (from, to) => {
      if (prState?.rollId === from) {
        prState.rollId = to;
        prState.idLiteral = JSON.stringify(to);
      }
    },
    syncHead: () => prSyncRollHead(),
    scheduleEval: () => prScheduleEval(),
  },
});

// The LFO's drawn shapes. Its "library" is the built-in presets plus prebake's, which is why a
// buffer that defines its own `pluck` shadows the one that ships - the same buffer-first rule the
// roll registry uses.
const shapeDefs = makeDefRegistry({
  kind: 'shape',
  section: 'lfos',
  defCall: '_shape',
  useCall: 'lfo',
  legacyCall: 'shape',
  emptyBody: '"0,0 0.5,1 1,0"',
  isData: (str) => (shapeMod ? shapeMod.looksLikeShapeData(str) : null),
  library: () => [...Object.keys(shapeMod?.SHAPE_PRESETS ?? {}), ...prPrebakeShapes],
  libraryNote: 'preset',
  panel: {
    current: () => lfoState?.shapeId ?? null,
    open: (id, carry) => openShapeById(id, carry ?? {}),
    close: () => closeLfoEditor(),
    carry: () => lfoCarry(), // the call it is looking through - a shape has no view state of its own
    sourceCall: () => null, // a rename here is always a plain rename, never a fork
    setCurrent: (from, to) => {
      if (lfoState?.shapeId === from) {
        lfoState.shapeId = to;
        lfoState.idLiteral = JSON.stringify(to);
      }
    },
    syncHead: () => lfoSyncHead(),
    scheduleEval: () => lfoScheduleEval(),
  },
});

// Captured plugin state under a name, so `.preset("<init growl>")` can swap a plugin between
// whole programs as it plays. Unlike a roll or a shape there is nothing to DRAW - a preset is made
// by playing it and turning the plugin's own knobs, and auto-pin files what you touched into
// whichever name was sounding (see writePluginState) - so its panel is the picker and nothing
// else. Its argument is always names, never data, which is the one thing that needs saying here.
const presetDefs = makeDefRegistry({
  kind: 'preset',
  section: 'presets',
  defCall: '_preset',
  useCall: 'preset',
  // plugin, state. The plugin is known before anything is captured - it is whatever the slot this
  // preset was named on holds - so a new definition is written already owned rather than as an
  // ownerless placeholder that two different plugins could each go on to claim.
  emptyBody: (sc) => `${JSON.stringify(sc ?? '')}, ""`,
  isData: () => false,
  library: () => prPrebakePresets,
  libraryNote: 'prebake',
  // A preset's names are unique per PLUGIN, not per buffer (see makeDefRegistry's scope): the
  // definition says which plugin it was captured from, and a call belongs to whichever plugin its
  // slot holds - the same last-in-chain rule Sig#preset itself uses.
  scope: {
    ofDef: (code, def) => presetDefParts(code, def).plugin,
    ofCall: (code, call) => presetTargetAt(code, call.start)?.plugin ?? '',
  },
  panel: {
    current: () => presetState?.id ?? null,
    scope: () => presetState?.scope ?? null,
    open: (id) => openPresetById(id, presetCarry()),
    close: () => closePresetPanel(),
    carry: () => presetCarry(),
    sourceCall: (refs) => sourceCallAmong(refs, presetState?.source),
    setCurrent: (from, to) => {
      if (presetState?.id !== from) return;
      presetState.id = to;
      presetHold(to); // the slot is held on a name, and the name just changed
    },
    syncHead: () => presetSyncHead(),
    scheduleEval: () => presetScheduleEval(),
  },
});

// Every registry, for the passes that have to run over all of them (folding, auto-naming).
const DEF_REGISTRIES = [rollDefs, shapeDefs, presetDefs];

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
  // With the console collapsed, a refusal is silent - you press a button, nothing happens, and the
  // line saying why is behind a panel you aren't looking at. So pulse the buffer red: not the
  // message, just the fact that there IS one, and somewhere to go for it. Open, the line is already
  // on screen (newest first, at the top) and a flash would be noise on top of it.
  if (isError && document.documentElement.hasAttribute('data-console-collapsed')) {
    pulse(document.getElementById('saveFlash'), 'error-flash');
  }
}

/**
 * One pulse of `cls` over `el`, restarting the animation rather than ignoring a second pulse that
 * lands mid-flight (a reflow between remove and add is what makes the browser run it again).
 */
function pulse(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
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
    'Cmd-Enter': () => evaluate(true, { byHand: true }),
    'Ctrl-Enter': () => evaluate(true, { byHand: true }),
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
// Show the editor pane: CodeMirror is up and the buffer this URL opens with is in it. Called from
// every exit of the boot handler below (index.html sets the flag, style.css hides the pane while
// it's there) and, as a backstop, on a timer - a request that never comes back must not leave the
// editor invisible.
const editorReady = () => delete document.documentElement.dataset.booting;
setTimeout(editorReady, 2000);

// Transport and save hotkeys work no matter what has focus (params search, plugin list, …). When
// the editor has focus CodeMirror handles these first and preventDefaults, so no double-fire.
// A dialog on screen owns the keyboard, though - not least because Cmd+S inside the prebake editor
// means "save the prebake".
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
  if (document.querySelector('.dir-picker-backdrop:not(.hidden)')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    evaluate(true, { byHand: true });
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

// How a patch is shared: as a file. Captured plugin states are filled back in on the way out (the
// buffer only carries handles into this machine's store - see blobs.js), so the file is the whole
// patch and nothing else: just what the patterns folder holds, and the other end can import it or
// drop it straight into ~/.poptart/patterns.
async function exportPatch() {
  await settlePluginState(); // the file has to carry the sound as it is right now
  const buffer = cm.getValue();
  if (!buffer.trim()) {
    logLine('nothing to export - the buffer is empty', true);
    return;
  }
  let code = buffer;
  try {
    const filled = await api('POST', '/api/blobs/hydrate', { code: buffer });
    code = filled.code;
    // A patch with holes in it still exports - the missing ones are named in the file, so the
    // sounds come back if their store ever does - but it must not go out looking complete.
    if (filled.missing?.length) {
      logLine(`export: ${filled.missing.length} captured plugin state(s) are not in this machine's store - the file names them but doesn't carry them`, true);
    }
  } catch (e) {
    logLine(`could not read this patch's captured plugin states (${e.message ?? e}) - not exporting a patch without them`, true);
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
    // Its captured plugin states go into this machine's store on the way in, so what lands in the
    // editor is the patch and handles, not megabytes of base64 (see blobs.js). A file that has
    // none - or a server too old to know the route - imports exactly as it stands.
    const light = await api('POST', '/api/blobs/dehydrate', { code: text }).catch(() => null);
    // Deliberately not opened *as* a saved pattern: nothing of that name is in the folder yet, and
    // save must never write to a file the user hasn't been shown. The file name is only a
    // suggestion for when they do save it.
    await openInEditor(light?.code ?? text, null);
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
  forgetExpandedFolds();
  refoldAll();
  lastCheckpointCode = code;
  updateDocTitle(code);
}

// Opening the app: a reload of this tab keeps whatever was in the buffer, otherwise the hash
// decides (a shared link, a history entry, or nothing - the default snippet).
//
// Deferred by a microtask rather than run where it stands: restoring a buffer folds it, and folding
// reads declarations from all over this file. Top-level code runs as the file is being evaluated,
// so anything declared below here is still in its temporal dead zone - and a `const` read there
// throws rather than reading undefined. A microtask drains as soon as evaluation finishes, which is
// still before the first paint, so nothing flashes; it just happens after everything exists.
queueMicrotask(async () => {
  try {
    await openingBuffer();
  } finally {
    editorReady();
  }
});

// The buffer this tab opens with. Everything that can put code in the editor before the user sees
// it happens in here, so the pane can be held blank until it returns.
async function openingBuffer() {
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
}

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

// A chip the player opened by hand stays open. Folds are otherwise re-derived from the buffer
// after every write, so a note drawn into a roll would slam its own definitions block shut again -
// which is what "expand it and keep working" used to do. The choice isn't in the text, so it is
// remembered here, by what the fold is OF rather than where it is: an edit moves the offsets.
const expandedFolds = new Set();

// A buffer being swapped out wholesale takes its folds - and the choices made about them - with
// it. Whatever the next patch holds, nobody has opened any of it yet.
function forgetExpandedFolds() {
  expandedFolds.clear();
}

// Every fold this file makes is re-derivable from the buffer, so switching one off is "drop them
// all and work them out again" rather than a hunt for the marks that have to go. This is also the
// only form that is safe to run over a buffer that already has folds: foldConfigBlobs alone is
// additive, and an edit that half-clears a mark can leave it laying a second widget beside the
// first - a chip and the text it was standing in for, both on screen.
function refoldAll() {
  cm.operation(() => {
    for (const mk of cm.getAllMarks()) if (mk.poptartFold) mk.clear();
    foldConfigBlobs();
  });
}

// Spans of the definition runs the player has opened, rebuilt at the top of each foldConfigBlobs
// pass. Opening a run is a request to READ it, so the folds that would otherwise chip what is
// inside one - a roll's note string, a preset's captured program - stand down within it. While the
// run is folded they never come up: its own chip already covers them.
let openDefRunSpans = [];

function foldSpan(fromIdx, toIdx, label, title, key = null) {
  if (key !== null && expandedFolds.has(key)) return; // opened by hand - leave it open
  if (openDefRunSpans.some(([a, b]) => fromIdx >= a && toIdx <= b)) return; // inside one that was
  const from = cm.posFromIndex(fromIdx);
  const to = cm.posFromIndex(toIdx);
  if (cm.findMarks(from, to).some((mk) => mk.poptartFold)) return; // already folded
  const widget = document.createElement('span');
  widget.className = 'cm-config-fold';
  widget.textContent = label;
  widget.title = title;
  const mk = cm.markText(from, to, { replacedWith: widget, atomic: true });
  mk.poptartFold = true;
  widget.onclick = () => {
    if (key !== null) expandedFolds.add(key);
    mk.clear();
  };
}

function foldConfigBlobs() {
  const code = cm.getValue();
  let m;
  // Runs first, so every pass below knows where they are: a folded one covers its contents with a
  // single chip that they find already marked and leave alone, and an opened one holds them off
  // entirely (see openDefRunSpans).
  openDefRunSpans = [];
  for (const reg of DEF_REGISTRIES) foldDefRuns(code, reg);
  // Captured plugin state written out in full - a patch pasted in from outside, or a definition
  // typed by hand. What the editor writes is a handle into the store (see blobs.js), which is
  // short and stays on screen; this is for the ones that aren't.
  const stateRe = /\{\s*state:\s*"[A-Za-z0-9+/=]+"\s*\}/g;
  while ((m = stateRe.exec(code))) {
    const kb = Math.max(1, Math.round(m[0].length / 1024));
    foldSpan(m.index, m.index + m[0].length, `{◆ ${kb}kb}`, 'captured plugin state — click to expand', `state@${m.index}`);
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
    // pianoroll("<0 chorus>") names rolls, and lfo("<pluck swell>") names shapes - those names ARE
    // the code to read, the whole point of the named form. Only drawn data folds. Until the module
    // that can tell them apart has loaded, nothing folds rather than the wrong thing; coreReady
    // refolds once it can.
    if (m[1] === 'pianoroll' && (!pianorollMod || rollDefs.isIdString(str.slice(1, -1)))) continue;
    if (m[1] === 'lfo' && !shapeMod?.looksLikeShapeData(str.slice(1, -1))) continue;
    const start = m.index + m[0].length - str.length;
    // Keyed by where the CALL starts: drawing into a roll rewrites what is inside it and leaves
    // its own offset alone, which is exactly the run of edits this has to hold across.
    foldSpan(start, start + str.length, '"⋯"', DATA_ARG_TITLES[m[1]], `data@${m.index}`);
  }
  // The same blob one call along, as a named preset's third argument. This is for the definitions
  // no run covers - one that chains, or shares its line with code - since inside a folded run the
  // run's own chip stands in for the lot. The id and the plugin stay visible: they are what the
  // definition is FOR, and only the program folds.
  const presetStateRe = /\b_preset\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|-?[\d.]+)\s*,\s*(?:"[^"\n]*"|'[^'\n]*')\s*,\s*("[A-Za-z0-9+/=]+")/g;
  while ((m = presetStateRe.exec(code))) {
    const str = m[1];
    const start = m.index + m[0].length - str.length;
    const kb = Math.max(1, Math.round(str.length / 1024));
    foldSpan(start, start + str.length, `"◆ ${kb}kb"`, 'captured plugin state — click to expand', `preset@${m.index}`);
  }
  // _roll(id, "notes", …) - the same note data, one argument further along. The id stays visible:
  // it is the name the patterns say, and the whole point of a definitions block is reading it.
  // The underscore is optional so a patch old enough to still say `roll(` folds too; the lookbehind
  // is what keeps `pianoroll(` (handled above, where names are told from data) out of it.
  const rollArgRe = /(?<![\w$])_?roll\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|[^,()\n]*?)\s*,\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((m = rollArgRe.exec(code))) {
    const str = m[1];
    if (str.length <= 2) continue;
    const start = m.index + m[0].length - str.length;
    foldSpan(start, start + str.length, '"⋯"', DATA_ARG_TITLES.pianoroll, `rollarg@${m.index}`);
  }
}

// How many ids a chip's tooltip spells out before it starts counting instead.
const ROLL_CHIP_IDS = 6;

// A run of consecutive definitions is a library rather than music: it plays nothing (the server
// drops every definition sig) and what it holds is editor-written data that no one - least of all
// an audience - wants to read. So it folds to one chip naming the KIND it holds - the names are in
// its tooltip, since a chip reading `⋯ pianorolls` says what the line is far better than a list of
// ids does - and is worked on from its own editor panel instead.
//
// It folds rather than HIDES, which it used to. CodeMirror renders a collapsed multi-line mark as
// one visual line and there is no way down from there to none - so hiding a run never removed it
// from the buffer so much as disguised it as a blank line, which is precisely the line a tidy
// player selects and deletes, losing the roll with it. A chip you can see is safer than a gap you
// can't, and it costs one line at the bottom of the buffer, below everything that is played.
function foldDefRuns(code, reg) {
  for (const run of reg.runs(code)) {
    const ids = run.map((d) => d.id);
    const from = run[0].start;
    const to = run[run.length - 1].close + 1;
    // Keyed by the names it holds, not its offset: the block sits at the bottom of the buffer, so
    // anything typed above it moves it, and an offset key would forget the moment you typed.
    const key = `defs:${reg.kind}:${ids.join(',')}`;
    if (expandedFolds.has(key)) {
      openDefRunSpans.push([from, to]);
      continue; // opened to be read - and everything in it is part of what there is to read
    }
    const shown =
      ids.length > ROLL_CHIP_IDS
        ? [...ids.slice(0, ROLL_CHIP_IDS), `+${ids.length - ROLL_CHIP_IDS} more`]
        : ids;
    foldSpan(
      from,
      to,
      `⋯ ${reg.section}`,
      `${reg.section}: ${shown.join(', ')} — click to expand`,
      key
    );
  }
}

// The span a run occupies once its scaffolding is counted in: back over a `rolls:` label to the
// start of the line, and forward over the rest of the last line, its newline and any blank lines
// after it - so folding the run closes the hole up rather than leaving an empty line behind. Either
// end stays put if real code shares the line, which can only lose the chip a little precision.
function runLineRange(code, run) {
  const first = run[0];
  const lineStart = code.lastIndexOf('\n', first.start - 1) + 1;
  const head = code.slice(lineStart, first.start);
  let from = /^\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?$/.test(head) ? lineStart : first.start;
  const end = run[run.length - 1].close + 1;
  const tail = /^[ \t;]*(?:\r?\n[ \t]*)*(?:\r?\n|$)/.exec(code.slice(end));
  const to = tail ? end + tail[0].length : end;
  // `rolls:` alone on the line above is the block's own scaffolding, so it goes with the block -
  // but only when the run reaches the end of a line, since a label left standing over code that
  // is still on screen would be worse than one that is merely dull.
  const wholeLines = tail && (tail[0].includes('\n') || to >= code.length);
  if (wholeLines && from === lineStart && lineStart > 0) {
    const prevStart = code.lastIndexOf('\n', lineStart - 2) + 1;
    if (/^\s*[A-Za-z_$][\w$]*\s*:\s*$/.test(code.slice(prevStart, lineStart - 1))) from = prevStart;
  }
  return [from, to];
}

// Undo and redo put the text back but not the marks an edit cleared along the way, so a cmd-Z can
// leave a definitions block sitting on screen. Re-derive the folds whenever one lands - which is
// rare, unlike the per-keystroke changes this deliberately ignores.
cm.on('changes', (_, changes) => {
  if (changes.some((c) => c.origin === 'undo' || c.origin === 'redo')) refoldAll();
});

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
// Auto-pin: `synth("Serum 2")` with no state of its own means "however the plugin defaults", but
// the moment you touch anything in the plugin's own window that stops being true. The server
// notices the edit, captures the state (debounced - see captureDirtyPlugins), and we file it under
// a NAME - a `_preset(...)` definition, with a `.preset("name")` on the chain right after the
// plugin it came from. So the code always describes what you're hearing.
//
// A named preset is the only way a captured state enters a patch. `synth("X", { state })` is still
// READ, so patches written before this sound exactly as they did, but nothing writes one any more:
// one way for a sound to be stored, and patterning it is then just naming a second one
// (.preset("<a b>")) rather than a different kind of thing. A slot that still carries a legacy
// `{ state }` sheds it the first time it is captured into - the preset replaces it.
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

// A slot driven by a .preset(...) pattern: the state goes into the DEFINITION of whichever preset
// was sounding when the knob moved, not into the slot's `{ state }` argument - which the next swap
// would overwrite anyway. This is the whole authoring loop for presets: name two in a pattern, play,
// and shape each one by ear while it is the one you can hear.
// Returns how the capture was filed, for the freeze on the slot it came from (see syncHeldPresets):
// 'eval' - written, and an evaluation is on its way to put it where the scheduler reads it;
// 'already' - the code said it word for word, so it is already there; null - nowhere to write it.
function writePresetState(trackLabel, slot, state, plugin, preset) {
  const code = cm.getValue();
  // Scoped to the plugin the state came OUT of: several presets in this buffer may be called
  // `disco`, and the one being captured into is this plugin's (see makeDefRegistry's scope). An
  // uncaptured placeholder matches too, and this capture is what gives it its owner.
  const def = presetDefs.findDef(code, preset, plugin ?? null);
  const body = `${JSON.stringify(plugin ?? '')}, ${JSON.stringify(state)}`;
  if (!def) {
    // A pattern names this preset but nothing defines it - its definition deleted, or the name
    // typed in and not yet evaluated (materialize writes them at eval time). Write one rather than
    // drop the program on the floor: a captured sound is the one thing here that can't be redone.
    const [from, to, text] = presetDefs.defsEdit(code, [preset], () => body);
    cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to), '+autopin');
    refoldAll();
    logLine(`captured ${plugin ?? 'plugin'} into preset "${preset}" (which had no definition)`);
    presetScheduleEval();
    return 'eval';
  }
  const [, idEnd] = defIdLiteralRange(code, def);
  const replacement = `, ${body}`;
  const from = cm.posFromIndex(idEnd);
  const to = cm.posFromIndex(def.close);
  // Identical text means the plugin came back exactly as the code already describes it - a gesture
  // that landed back where it started, or a capture racing an edit elsewhere. Writing it anyway
  // would spend an undo step, a change event and a megabyte-scale buffer edit on nothing.
  if (cm.getRange(from, to) === replacement) return 'already';
  cm.replaceRange(replacement, from, to, '+autopin'); // one merged undo step, as in createPresetForSlot
  refoldAll();
  logLine(`captured ${plugin ?? 'plugin'} into preset "${preset}"`);
  presetScheduleEval();
  return 'eval';
}

// The `.preset(...)` call driving one chain slot, if the buffer already has one. Found by asking
// every preset call in the block which slot it aims at (Sig#preset's own rule) rather than by
// assuming it sits immediately after its synth()/.fx() - a .param() may well be in between.
function presetCallForSlot(code, trackLabel, slot) {
  for (const call of presetDefs.idCalls(code)) {
    const target = presetTargetAt(code, call.start);
    if (target && target.label === trackLabel && target.slot === slot) return call;
  }
  return null;
}

function writePluginState(trackLabel, slot, state, plugin, preset) {
  if (!labelsMod) return null;
  const code = cm.getValue();
  // Which preset this belongs in, most reliable first: the one the server says was loaded when the
  // knob moved (a hold, or whatever the pattern had reached), then whatever the buffer's own
  // .preset(...) for this slot names. The second is what covers a capture landing before the eval
  // that would have told the server about a preset this function itself just wrote.
  const named = preset ?? idsNamedIn(presetCallForSlot(code, trackLabel, slot)?.str ?? '')[0] ?? null;
  if (named) return writePresetState(trackLabel, slot, state, plugin, named);
  return createPresetForSlot(code, trackLabel, slot, plugin, state);
}

// Nothing names this slot's sound yet, so auto-pin gives it a name: a definition holding the
// program, and a `.preset("name")` on the chain right after the plugin it came from. Any legacy
// `{ state }` on that call goes at the same time - the preset replaces it, and leaving both would
// be two descriptions of one sound, the pinned one silently ignored (see Scheduler#setPattern).
function createPresetForSlot(code, trackLabel, slot, plugin, state) {
  const block = blockForTrack(code, trackLabel);
  const call = block && findChainCall(code, block.start, block.end, slot);
  if (!call) {
    // The call was renamed or deleted between the gesture and the capture. Nothing to write to;
    // the next edit in that plugin captures again.
    logLine(`auto-pin: no ${slot === 0 ? 'synth(...)' : '.fx(...)'} call for track "${trackLabel}" slot ${slot} - state not written`, true);
    return null;
  }
  // A slot is a position, and positions move: reorder two .fx(...) calls between the gesture and
  // the capture and slot 2 is a different plugin than the one this state came out of. Writing it
  // there would put a reverb's program in a chorus's call - the state is only ever written against
  // a call naming the plugin it was captured from.
  if (plugin && call.plugin !== plugin) {
    logLine(`auto-pin: "${trackLabel}" slot ${slot} is ${call.plugin || 'something else'} now, not ${plugin} - state not written (re-touch the plugin to capture it again)`, true);
    return null;
  }
  // Named after the track, since that is what you call the sound out loud. No slot number: a preset
  // belongs to its plugin (see makeDefRegistry's scope), so every slot in a chain can have one
  // called `lead` and each means the one on that plugin. The suffix is only the fallback for a name
  // already taken ON THIS PLUGIN - the same plugin twice in one chain.
  const rows = presetDefs.allIds(plugin ?? null);
  const id = freshDefId(trackLabel, (name) => rows.some((r) => r.id === name), 'preset');
  // A name taken by something outside the buffer gets a word, for the same reason it does when a
  // roll or shape is auto-named: the suffix is otherwise unexplained (see libraryBumpNote). `own`
  // is what tells the buffer's own definitions from the prebake's.
  const wantedId = preferredDefId(trackLabel, 'preset');
  const fromLibrary = rows.find((r) => r.id === wantedId && !r.own);
  if (fromLibrary) libraryBumpNote('preset', wantedId, id, fromLibrary.note ?? 'prebake');
  const edits = [
    [call.closeParen + 1, call.closeParen + 1, `.preset(${JSON.stringify(id)})`],
    presetDefs.defsEdit(code, [id], () => `${JSON.stringify(plugin ?? '')}, ${JSON.stringify(state)}`),
  ];
  // The legacy `{ state }` argument, if this call still carries one.
  if (call.afterFirstArg < call.closeParen) edits.push([call.afterFirstArg, call.closeParen, '']);
  // One `+`-prefixed origin so CodeMirror merges consecutive writes into a single undo step (same
  // trick as the copy-line edits): a knob drag can't bury your last real edit under a run of them.
  cm.operation(() => {
    for (const [from, to, text] of [...edits].sort((a, b) => b[0] - a[0])) {
      cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to), '+autopin');
    }
  });
  refoldAll();
  logLine(`captured ${plugin ?? 'plugin'} into new preset "${id}"`);
  presetScheduleEval();
  return 'eval';
}

// ---------------------------------------------------------------------------------------------
// Legacy `{ state }` arguments. `synth("Serum 2", { state: "@f658c5f18010" })` is how a captured
// sound used to be written: the program pinned onto the call itself. It still plays (see
// Sig#synth), but it is a second way of saying what a preset says, and one nothing else can see -
// no panel lists it, no pattern can swap it, and a capture into that slot would leave the two
// describing one sound. So an evaluation converts each one on its way through: the state goes into
// a `_preset(...)` definition named after the track, and the call gets `.preset("name")` where the
// argument was. Same sound, now under a name - the rewrite auto-pin makes when it first captures
// into such a slot (see createPresetForSlot), done up front rather than waiting for a knob to move.
// ---------------------------------------------------------------------------------------------

// The first synth()/.fx() call in the buffer still carrying a `{ state }` second argument, as
// { label, slot, plugin, state, afterFirstArg, closeParen }, or null. One at a time: every
// conversion moves the offsets below it, so the caller converts and looks again.
function findLegacyStateCall(code) {
  const isCode = codeOnly(code);
  for (const block of labelsMod.splitLabeledBlocks(code)) {
    const re = /\b(synth|fx)\s*\(/g;
    re.lastIndex = block.start;
    let m;
    let fxSeen = 0; // live .fx() calls so far in this block: the slot numbering Sig#fx gives them
    while ((m = re.exec(code)) && m.index < block.end) {
      if (!isCode(m.index)) continue; // a commented-out call is a sound you are not hearing - leave it
      const slot = m[1] === 'synth' ? 0 : ++fxSeen;
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      if (close < 0 || close > block.end) break;
      const lit = firstStringLiteral(code, open + 1, close);
      if (!lit) continue;
      const head = /^\s*,\s*\{\s*["']?state["']?\s*:\s*(?=["'])/.exec(code.slice(lit.end, close));
      if (!head) continue;
      const stateLit = firstStringLiteral(code, lit.end + head[0].length, close);
      if (!stateLit || !/^\s*,?\s*\}\s*$/.test(code.slice(stateLit.end, close))) continue; // not the simple shape
      if (!stateLit.content) continue; // `{ state: "" }` pins nothing, and says nothing worth naming
      return { label: block.label, slot, plugin: lit.content, state: stateLit.content, afterFirstArg: lit.end, closeParen: close };
    }
  }
  return null;
}

function convertLegacyStates() {
  if (!labelsMod) return;
  const converted = [];
  for (let guard = 0; guard < 64; guard++) { // a bound, not a budget: a buffer has a handful of these
    const code = cm.getValue();
    const call = findLegacyStateCall(code);
    if (!call) break;
    const { label, slot, plugin, state } = call;
    // Named after the track, like an auto-pinned capture (see createPresetForSlot) - and unique
    // within the PLUGIN, since a preset belongs to the plugin it came from.
    const rows = presetDefs.allIds(plugin);
    const id = freshDefId(label, (name) => rows.some((r) => r.id === name), 'preset');
    const wantedId = preferredDefId(label, 'preset');
    const fromLibrary = rows.find((r) => r.id === wantedId && !r.own);
    if (fromLibrary) libraryBumpNote('preset', wantedId, id, fromLibrary.note ?? 'prebake');
    // A slot a .preset(...) pattern already drives is already in the current form, and the pinned
    // state under it is the one the scheduler ignores (see Sig#synth) - so the program is FILED
    // under a name, where the picker can offer it, but nothing is chained on: the pattern that is
    // there goes on saying what the slot plays.
    const driven = !!presetCallForSlot(code, label, slot);
    const edits = [
      [call.afterFirstArg, call.closeParen, ''],
      presetDefs.defsEdit(code, [id], () => `${JSON.stringify(plugin)}, ${JSON.stringify(state)}`),
    ];
    if (!driven) edits.push([call.closeParen + 1, call.closeParen + 1, `.preset(${JSON.stringify(id)})`]);
    cm.operation(() => {
      for (const [from, to, text] of edits.sort((a, b) => b[0] - a[0])) {
        cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to), '+legacyState');
      }
    });
    converted.push(`"${label}" ${slot === 0 ? 'synth' : `fx slot ${slot}`} → preset "${id}"${driven ? ' (filed only: that slot is already driven by .preset(…))' : ''}`);
  }
  if (!converted.length) return;
  refoldAll();
  logLine(`converted legacy { state } into presets: ${converted.join('; ')}`);
}

// Deliberately does NOT re-evaluate: the state is already live in the plugin (it came from
// there), so an eval would only push it back and make the plugin reload what it already has.
let pinsPending = 0; // slots the server is holding uncaptured, so we mention it once, not per poll

// ---------------------------------------------------------------------------------------------
// Hand editing. A plugin whose own window you are turning knobs in holds a sound the code doesn't
// have yet, so the server freezes that slot's whole-program pushes - `.preset("<a b>")` stops
// swapping it - until the sound is described where the scheduler reads it (see the server's
// hand-editing section).
//
// The two ends of it are gestures, not states: opening a plugin's own window (the `ui` button, or
// a double-click on the `synth`/`fx` name) takes that slot by hand, and a click anywhere in the
// code hands every held slot back. Which is how it reads in use - you are either shaping a sound in
// the plugin or writing code, and the click that returns you to the code is the one that says so.
//
// Inferring the end of it instead (the browser regaining focus, an idle timer) was tried first and
// is what made this feel random: a plugin window that opens behind the browser never takes the
// focus away, so holds ended a second after they started, mid-knob-turn.
//
// A hold is never silent: while one is on, the preset it is holding is marked in the code (see
// syncHeldPresets), so "why has this stopped swapping" is answered on screen rather than from
// memory - and the answer is one click away from being undone.
// ---------------------------------------------------------------------------------------------

// Hold changes go out in the order they were made. A double-click on `synth` fires a plain click
// first (which hands the held slots back) and then the double-click (which takes this one), and two
// requests in flight at once could otherwise land the wrong way round - leaving the slot you just
// opened a window on unheld.
let handOps = Promise.resolve();
function queueHandOp(send) {
  handOps = handOps.then(send, send);
  return handOps;
}

// A release the server hasn't confirmed yet. The poll that answers while one is in flight was
// computed before it arrived and still says those slots are held; taking its word would flash the
// marks back on for half a second under the click that just cleared them.
let releasesInFlight = 0;

/**
 * Back in the code: every slot being held by hand goes back to its pattern. Fires on any click in
 * the buffer, so it costs nothing to be wrong about - the next double-click on a plugin name (or
 * its `ui` button) takes its slot again.
 */
function releaseSlotsHeldByHand() {
  if (!heldSlots.some((h) => h.why === 'hand')) return;
  // Drawn as released at once rather than on the next poll: the click and the yellow going out are
  // one gesture. A request that fails puts the marks back on the poll after it.
  releasesInFlight += 1;
  syncHeldPresets(heldSlots);
  queueHandOp(() => api('POST', '/api/releaseEditors', {}).catch(() => {}).finally(() => {
    releasesInFlight -= 1;
  }));
}

cm.getWrapperElement().addEventListener('mousedown', releaseSlotsHeldByHand, true);

// A held slot is a place where the code says one thing and the plugin is doing another, so it is
// drawn ON the code: the preset name that is really loaded gets a held mark, and the playback
// highlighter is told to leave that call alone - it would otherwise go on lighting `a`, `b`, `a`
// while the plugin sat on one of them, which is the highlighter's one promise broken.
//
// Both kinds of hold are drawn the same way, because they are the same fact on screen: the preset
// panel holding a slot it is editing, and a plugin window held open on one.
let heldSlots = []; // [{ trackId, slot, preset, why }] as of the last poll
let heldMarks = []; // the marks drawn for them
let heldRanges = []; // document spans the playback highlighter must not light
let heldPainted = ''; // the holds + buffer generation last drawn, so an unchanged poll costs nothing

function heldTitle(h) {
  const name = h.preset ? `"${h.preset}"` : 'this preset';
  if (h.why === 'panel') return `playing ${name} while the preset panel is open on it`;
  if (h.why === 'hand') return `playing ${name} while you work in its plugin - click anywhere in the code and the pattern swaps it again`;
  return `playing ${name} until what you just changed in the plugin is written into the code`;
}

function syncHeldPresets(holds) {
  // While a release is in flight, what the server says about by-hand holds is out of date by
  // construction - it answered before the click reached it (see releaseSlotsHeldByHand).
  heldSlots = releasesInFlight ? holds.filter((h) => h.why !== 'hand') : holds;
  // Nothing held means nothing to redraw, however much the buffer changes - which matters, because
  // this runs twice a second and typing changes the buffer generation on every keystroke.
  const sig = heldSlots.length
    ? `${heldSlots.map((h) => `${h.trackId}|${h.slot}|${h.preset ?? ''}|${h.why}`).sort().join(',')}@${cm.changeGeneration()}`
    : '';
  if (sig === heldPainted) return; // nothing held has moved, and neither has the buffer
  heldPainted = sig;
  paintHeldPresets();
}

function paintHeldPresets() {
  const before = heldRanges.join(';');
  for (const mk of heldMarks) mk.clear();
  heldMarks = [];
  heldRanges = [];
  const code = heldSlots.length && labelsMod ? cm.getValue() : '';
  for (const h of heldSlots) {
    const call = presetCallForSlot(code, h.trackId, h.slot);
    if (!call) continue;
    // The whole name string is what the highlighter must leave alone: every name in `<a b>` is one
    // this slot is not playing right now, including the one it is (its light would be a lie about
    // the pattern rather than about the sound).
    heldRanges.push([call.from, call.to]);
    let from = call.from;
    let to = call.to;
    const m = h.preset ? idWordRe(h.preset).exec(call.str) : null;
    if (m) {
      from = call.from + m.index;
      to = from + m[0].length;
    }
    heldMarks.push(cm.markText(cm.posFromIndex(from), cm.posFromIndex(to), {
      className: 'cm-held',
      title: heldTitle(h),
    }));
  }
  // Only when what the highlighter may light actually moved: its dedupe is what keeps it from
  // churning marks 30 times a second, and resetting that on every keystroke would undo it.
  if (heldRanges.join(';') !== before) for (const r of patternRegions) r.lastKey = '';
}

/** Whether a document span sits inside a held `.preset(...)` name (see paintHeldPresets). */
function inHeldRange(from, to) {
  return heldRanges.some(([a, b]) => from >= a && to <= b);
}

// Captures written into the buffer whose slot is still frozen until the sound is where the
// scheduler reads it. A preset's program only gets there through an evaluation, so those wait for
// one; a capture the code already described word for word is there already. Each carries the
// server's sequence number, so committing one can never release a knob turned after it.
let commitQueue = []; // report on the next poll
let commitOnEval = []; // ...once the evaluation carrying them has come back

async function pollPluginEdits({ flush = false } = {}) {
  // The preset panel's hold is renewed here rather than on a timer of its own - the server treats
  // it as a lease, so a tab that closes with the panel open releases the slot instead of leaving it
  // frozen on one preset (see /api/presetHold).
  const hold = presetState?.held ? { ...presetState.held, trackId: presetState.held.label, preset: presetState.id } : null;
  // The mixer's drag lease renews here too. It can't ride its own value posts: a finger resting
  // motionless on a fader emits no pointermove, and the server would give the control back mid-mix.
  const channelHold = mixerHold?.value == null ? null : { trackId: mixerHold.label, name: mixerHold.name, value: mixerHold.value };
  const committed = [...commitQueue];
  const { edits, logs, pending, holds } = await api('POST', '/api/pluginEdits', {
    flush,
    hold,
    channelHold,
    committed,
  });
  // What is held right now, drawn on the code. Every poll, so a hold taken or dropped between two
  // evaluations shows up within half a second instead of waiting for one.
  syncHeldPresets(holds ?? []);
  // Only what the server has now heard - a request that failed leaves them queued for the next poll
  // rather than leaving a slot frozen until it times out.
  commitQueue = commitQueue.filter((c) => !committed.includes(c));
  for (const e of edits ?? []) {
    const filed = writePluginState(e.trackId, e.slot, e.state, e.plugin, e.preset);
    const commit = { trackId: e.trackId, slot: e.slot, seq: e.seq };
    if (filed === 'already') commitQueue.push(commit);
    else if (filed === 'eval') commitOnEval.push(commit);
    // Written nowhere (no call left to write into): the freeze times out server-side, and the next
    // touch of that plugin captures again.
  }
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

// The block a track label names, for a write aimed at the TRACK - conf's .param(), auto-pin's
// preset, a keyboard() swap. A muted copy (`pluck_: …`) and a playing one (`pluck: …`) carry the
// same label, and the engine only knows the one that is playing: the gesture came out of ITS
// plugin, so that is the block the write belongs in. The muted one is only the fallback when
// nothing by that name plays (a capture landing just after the track was muted).
function blockForTrack(code, label) {
  const blocks = labelsMod.splitLabeledBlocks(code);
  return blocks.find((b) => b.label === label && !b.muted) ?? blocks.find((b) => b.label === label) ?? null;
}

function upsertParam(trackLabel, slot, name, value) {
  if (!labelsMod) return;
  const code = cm.getValue();
  const block = blockForTrack(code, trackLabel);
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

// The session a reload comes back to. A refresh is the same person still working on the same
// buffer, so it continues the file it was already writing rather than opening another one - what
// changes it is opening a DIFFERENT buffer, which either adopts that buffer's own session or mints
// a fresh one (see rollWipSession). Minting one per page load is what left 620 session files in a
// month, and each one pins the captured plugin states it mentions for as long as it exists (see
// blobs.js).
const WIP_SESSION_KEY = 'poptart.wipSession';
let wipSessionId = sessionStorage.getItem(WIP_SESSION_KEY) || newWipSessionId();
sessionStorage.setItem(WIP_SESSION_KEY, wipSessionId);
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

// Leaving the current buffer behind (＋ new, or loading another pattern): flush it, then point the
// autosave somewhere else. Without the flush, clearing the editor would blank - and so delete -
// the very file that was holding the work.
//
// `id` is a session being REOPENED, which the buffer then goes on being: its file keeps recording
// it, so it stays one session however many times it is put down and picked up again. Without an
// id (a saved pattern, an import, a history entry) a fresh session file is minted to hold it.
async function rollWipSession(id = null) {
  // The buffer is about to be replaced, so this is the last chance for a held plugin edit to
  // reach the session file it belongs to.
  await settlePluginState();
  await saveWip();
  wipSessionId = id ?? newWipSessionId(wipSessionId);
  sessionStorage.setItem(WIP_SESSION_KEY, wipSessionId);
  wipLastSent = null;
  wipListedRow = null; // whatever this session's row says, the list hasn't heard it from us yet
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

// Sample packs for s(". Unlike se(", the string is mini-notation holding many tokens
// (`s("bd*4, ~ hh")`), so only the word under the cursor is completed and the rest is left
// alone. A ":" in that word switches the popup to the pack's files, whose positions ARE the
// sampler indexes - so the filenames stay visible while you pick a number.
async function fetchSamplePacks() {
  if (!samplePacks) await loadSamples(); // shares the sounds tab's cache; it swallows its own errors
  return samplePacks ?? [];
}

function samplePackHints(cur, typed) {
  // Everything up to the last mini-notation separator (space, `[`, `<`, `,`, `*`, …) is
  // structure the completion must not eat; the trailing word is what's being named.
  const token = typed.match(/[A-Za-z0-9_.:#-]*$/)[0];
  const colon = token.indexOf(':');

  return fetchSamplePacks().then((packs) => {
    if (colon < 0) {
      const pool = packs.map((p) => ({ key: p.name, count: p.files.length }));
      let matches = rankedMatches(pool, token, 40);
      // The name has to be a pack that exists, so an unmatched word is better answered with the
      // whole library than with silence.
      if (matches.length === 0) matches = pool.slice(0, 40);
      return hintResult(cur, token, matches.map((item) => ({
        text: item.key,
        displayText: `${item.key} · ${item.count}`,
      })));
    }

    const packName = token.slice(0, colon);
    const partial = token.slice(colon + 1);
    const pack = packs.find((p) => p.name.toLowerCase() === packName.toLowerCase());
    if (!pack) return hintResult(cur, token, []);
    // Digits (or nothing yet) pick by index; anything else is the user naming the file they
    // want, which is exactly what the index is hard to remember.
    const byIndex = partial === '' || /^\d+$/.test(partial);
    const pool = pack.files.map((name, i) => ({ key: `${pack.name}:${i}`, name, i }));
    const matches = (byIndex
      ? rankedMatches(pool.map((f) => ({ ...f, key: String(f.i) })), partial, 40)
      : pool.filter((f) => f.name.toLowerCase().includes(partial.toLowerCase())).slice(0, 40));
    return hintResult(cur, token, matches.map((item) => ({
      text: `${pack.name}:${item.i}`,
      displayText: `${pack.name}:${item.i} · ${item.name}`,
    })));
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

  // Inside s(" → sample packs (and their files after a ":"). `s` is both a builder and a chain
  // method (`n("0").s("clap")`), so a leading dot is allowed where se(/sr( forbid it.
  m = before.match(/(?<![\w$])\.?s\s*\(\s*["']([^"']*)$/);
  if (m) return samplePackHints(cur, m[1]);

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
    // An empty lfo() has neither a shape nor a name yet. Give it both, then open whatever it
    // became - a bookmark carries the handle's position across the rewrite, since a definitions
    // block inserted above moves every offset below it along. Same dance as pianoroll's.
    if (!code.slice(lfo.open + 1, lfo.close).trim()) {
      const at = cm.setBookmark(cm.posFromIndex(idx));
      const named = shapeDefs.materialize();
      const back = at.find();
      at.clear();
      if (named && back) return openWidgetAt(cm.getValue(), cm.indexFromPos(back));
    }
    // lfo("<pluck swell>") NAMES shapes rather than drawing them, so open the definition instead:
    // writing breakpoints back into this call would serialize them over the names.
    if (shapeDefs.isIdCall(code.slice(lfo.open + 1, lfo.close))) {
      openShapeFromIdCall(lfo, code);
      return true;
    }
    if (!lfoState || lfo.start !== lfoState.callStart) openLfoEditor(lfo);
    return true;
  }
  const roll = pianorollMod && findPianorollCallAt(code, idx);
  if (roll?.onName) {
    // An empty pianoroll() has neither notes nor a name yet. Give it both, then open whatever it
    // became - a bookmark carries the handle's position across the rewrite, since a definitions
    // block inserted above moves every offset below it along.
    if (!code.slice(roll.open + 1, roll.close).trim()) {
      const at = cm.setBookmark(cm.posFromIndex(idx));
      const named = rollDefs.materialize();
      const back = at.find();
      at.clear();
      if (named && back) return openWidgetAt(cm.getValue(), cm.indexFromPos(back));
    }
    // pianoroll("<0 chorus>") NAMES rolls rather than drawing them: the notes live in the roll(...)
    // definitions, so open whichever one is playing and follow the call from there. Writing notes
    // back into this call would serialize them over the ids, which is why it is never opened
    // directly.
    if (rollDefs.isIdCall(code.slice(roll.open + 1, roll.close))) {
      openRollFromIdCall(roll, code);
      return true;
    }
    if (!prState || roll.start !== prState.callStart) openPianorollEditor(roll);
    // Opening the roll on purpose hands it the keyboard: cmd-A, the arrows and delete belong to
    // the notes now, not to the code buffer.
    prCanvas.focus({ preventScroll: true });
    return true;
  }
  const preset = findPresetCallAt(code, idx);
  if (preset?.onName) {
    // An empty .preset() has no name yet. Give it one, then open whatever it became - a bookmark
    // carries the handle's position across the rewrite, since a definitions block inserted above
    // moves every offset below it along. Same dance as the roll's and the shape's.
    if (!code.slice(preset.open + 1, preset.close).trim()) {
      const at = cm.setBookmark(cm.posFromIndex(idx));
      const named = presetDefs.materialize();
      const back = at.find();
      at.clear();
      if (named && back) return openWidgetAt(cm.getValue(), cm.indexFromPos(back));
    }
    openPresetFromCall(preset, code);
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

/**
 * Open a plugin's own editor window - the engine owns it, so this is a request, not a panel. It is
 * also what takes the slot by hand: from here its program is yours to change, and the pattern stops
 * swapping it until you click back in the code (see the hand-editing sections here and in
 * server.js). Opening one already open is a fine thing to do - it brings the window back to the
 * front, and takes the slot again if a click in the code had handed it back.
 */
function showPluginEditor(trackId, slot) {
  queueHandOp(() => api('POST', '/api/showEditor', { trackId, slot })
    .catch((e) => logLine(e.message, true))
    // Ops are serialized, so by the time this one is answered any release before it has landed:
    // the server's view of what is held by hand is current again, and the mark can come back.
    .finally(() => { releasesInFlight = 0; }));
  // Only worth saying where a pattern would otherwise be swapping this slot's whole program - and
  // the marked name in the code says the rest.
  if (labelsMod && presetCallForSlot(cm.getValue(), trackId, slot)) {
    logLine(`${trackId} slot ${slot}: holding its preset while you work in the plugin - click in the code to hand it back`);
  }
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
const lfoTitle = document.getElementById('lfoTitle');
const lfoPickWrap = document.getElementById('lfoPickWrap');
const lfoName = document.getElementById('lfoName');
const lfoPickBtn = document.getElementById('lfoPickBtn');
const lfoUseBtn = document.getElementById('lfoUseBtn');
const lfoLockBtn = document.getElementById('lfoLock');
const lfoPickBox = document.getElementById('lfoPicker');
const lfoSearch = document.getElementById('lfoSearch');
const lfoPickList = document.getElementById('lfoPickList');
const lfoRateWrap = document.getElementById('lfoRateWrap');
const lfoModeWrap = document.getElementById('lfoModeWrap');

let lfoState = null; // { marker, callStart, points, rate, mode, shapeId, idLiteral }
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
  // rate: 2 is cycles (one pass per cycle at 1); rate: "0.5hz" is free-running - the same two
  // spellings the builder takes, see parseRate in signal.mjs.
  const rateM = /rate\s*:\s*(?:["']([^"']*)["']|([\d.]+))/.exec(inner);
  const rateText = String(rateM ? rateM[1] ?? rateM[2] : '1');
  const rateHz = /hz\s*$/i.test(rateText);
  const rate = Number(rateText.replace(/hz\s*$/i, '')) || 1;
  const mode = (/mode\s*:\s*["'](\w+)["']/.exec(inner) ?? [])[1] ?? 'free';
  let points = null;
  try {
    if (shapeMatch?.[2]?.trim()) points = shapeMod.parseShapePoints(shapeMatch[2]);
  } catch {
    // unparseable shape string - fall back to the default below
  }
  if (!points) points = shapeMod.parseShapePoints('0,0 0.5,1 1,0');
  return { points, rate, rateHz, mode: ['free', 'retrigger', 'envelope'].includes(mode) ? mode : 'free' };
}

// The options an lfo() call carries - the half that belongs to the CALL rather than to the shape.
function lfoCfgText({ rate, rateHz, mode }) {
  const r = rateHz ? `"${rate}hz"` : String(rate);
  return mode === 'free' ? `{ rate: ${r} }` : `{ rate: ${r}, mode: '${mode}' }`;
}

function serializeLfoCall(state) {
  const pts = shapeMod.serializeShapePoints(state.points);
  // A definition holds the shape and nothing else: rate and mode are how one lfo() PLAYS a shape,
  // and two calls naming the same shape are free to play it at different rates.
  if (state.idLiteral) return `_shape(${state.idLiteral}, "${pts}")`;
  return `lfo("${pts}", ${lfoCfgText(state)})`;
}

/**
 * The lfo() this panel was opened through, split into the two halves the panel edits separately:
 * `shape` is the first argument exactly as written (a name, a pattern of them, or drawn points),
 * `opts` is the rest, and `idRange` is where the first STRING sits in the document. Null when the
 * panel was opened from the picker and has no call behind it.
 */
function lfoCallParts() {
  const range = lfoState?.callSource?.find();
  if (!range) return null;
  const text = cm.getRange(range.from, range.to);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const [shape, opts] = splitFirstArg(text.slice(open + 1, close));
  // Read off the call's own text rather than the buffer's: the follow loop asks for this every
  // frame, and cm.getValue() rebuilds the whole document each time it is called.
  const rel = idStringRange({ open, close }, text);
  const start = cm.indexFromPos(range.from);
  return { range, shape, opts: opts.trim(), idRange: rel && [start + rel[0], start + rel[1]] };
}

/** Rewrites that call whole, keeping the marker over it so the panel goes on following it. */
function writeLfoSourceCall(range, text) {
  lfoSuppressCursor = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    lfoState.callSource.clear();
    const startIdx = cm.indexFromPos(range.from);
    lfoState.callSource = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
  } finally {
    lfoSuppressCursor = false;
  }
}

// Rate and mode for a shape opened THROUGH an lfo() call go back into that call, since that is
// where they live. Opened from the picker there is no call to write to, and the panel hides them.
function writeLfoOptions() {
  const parts = lfoCallParts();
  if (!parts) return;
  writeLfoSourceCall(parts.range, `lfo(${parts.shape}, ${lfoCfgText(lfoState)})`);
  refoldAll(); // rate/mode rewrite the call too, taking the shape's fold with it - see writeLfoCall
  lfoScheduleEval();
}

/** The shape the call this panel came from names right now, or null (no call, or drawn points). */
function lfoSourceShapeId() {
  const parts = lfoCallParts();
  return parts ? idLiteralValue(parts.shape) : null;
}

/**
 * Puts `id` into the lfo(...) the panel was opened through, in place of whatever it plays now -
 * the modulator's half of what presetUseInCall does for a plugin preset, and the other half of what
 * the picker is for: opening a row EDITS that shape, this plays it here. Reached from the row's →
 * and from the head's, which sends whatever is on screen - the gesture for having drawn a shape,
 * liked it, and wanting the call you came from to play THAT one.
 *
 * The whole first argument goes, pattern and all, which is why the line says what it replaced: it
 * is one undo away, but only if you can see that it happened.
 */
function lfoUseInCall(id) {
  const parts = lfoCallParts();
  if (!parts || idLiteralValue(parts.shape) === id) return;
  writeLfoSourceCall(parts.range, `lfo(${JSON.stringify(id)}${parts.opts ? `, ${parts.opts}` : ''})`);
  refoldAll();
  lfoHead.closePicker(); // sending one is the end of a browse - hand the canvas back
  logLine(`lfo(${parts.shape}) now plays "${id}"`);
  // Following it is only possible into a definition this buffer holds. A built-in preset plays
  // perfectly well from the call - shapeNamed resolves it - but there is nothing of ours to put
  // under the editor, and writing a definition just to have something to show would be forking one
  // nobody asked for. Sending a name never forks; opening one does (see forkShapePreset).
  if (shapeDefs.defsInBuffer().some((d) => d.id === id)) openShapeById(id, lfoCarry());
  else lfoSyncHead();
  lfoScheduleEval();
}

/**
 * What the shape panel carries across a switch: the call it is looking THROUGH, and the rate and
 * mode that belong to it. A shape has no view state of its own, unlike a roll's pitch window.
 *
 * Carrying the call is what makes the picker a place to browse from - pick your way through four
 * shapes and the → still knows which lfo() you started at. Carrying its options is what keeps the
 * rate box honest while you do: rate and mode live on the CALL, so re-reading them from the
 * definition being opened (which has none) would show a shape playing at 2 as playing at 1.
 */
function lfoCarry() {
  const parts = lfoCallParts();
  if (!parts) return {};
  const { rate, rateHz, mode } = parseLfoCall(parts.opts);
  return { callSource: lfoState.callSource, options: { rate, rateHz, mode } };
}

// ---------------------------------------------------------------------------------------------
// Following the playing shape. lfo("<pluck swell>") swaps shapes on the beat, and the panel rides
// along: the shape under the editor is the one you can hear, until you lock it. The piano roll's
// follow, pointed at the shape names - the same lit-span read (see activeIdIn), the same lock, the
// same pinning gesture when you reach into the picker.
//
// Landing on a shape this buffer hasn't got forks it in (see forkShapePreset), which is the whole
// of what "editing a built-in" means here. That writes a line of code from a playback loop, which
// wants stating plainly - but it is a line per preset ever played, into a block that is folded, and
// once written the follow finds a definition like any other. The alternative was a read-only panel
// for library shapes, which is a lot of machinery to avoid eight lines of `_shape(...)`.
// ---------------------------------------------------------------------------------------------

let lfoFollowLocked = localStorage.getItem('poptartLfoLock') === '1';

// One frame's worth of following: swap the shape under the editor when the call it was opened from
// moves on to another one. Locked, stopped, or already showing it - nothing to do.
function lfoFollowPlayingShape() {
  if (lfoFollowLocked || !playing || !lfoState?.callSource) return;
  // Renaming or browsing is a conversation about ONE shape, and a drag is a gesture aimed at the
  // one under the pointer; swapping any of them out mid-way would land on the wrong shape.
  if (document.activeElement === lfoName || lfoHead.isOpen() || lfoDrag) return;
  // The id STRING, not the whole call: a patterned rate ("<1 2>") is lit on the same grid, and
  // reading the call whole would take its atom for a shape name.
  const range = lfoCallParts()?.idRange;
  if (!range) return;
  const id = activeIdIn(range[0], range[1]);
  if (id == null || id === lfoState.shapeId) return;
  // Only into something there is a shape to show for. A name that is neither ours nor a preset -
  // prebake's, whose points the editor never sees - would fail to open every frame for as long as
  // it sounds, and say so on the console every time. Asking first is also self-correcting: define
  // that name later and the follow picks it straight up.
  if (!shapeMod?.SHAPE_PRESETS?.[id] && !shapeDefs.defsInBuffer().some((d) => d.id === id)) return;
  openShapeById(id, lfoCarry());
}

function lfoSetFollowLock(locked) {
  lfoFollowLocked = !!locked;
  localStorage.setItem('poptartLfoLock', lfoFollowLocked ? '1' : '0');
  lfoSyncHead();
}

/** Whichever of the two the current state should write to. */
function writeLfoRateMode() {
  if (lfoState?.idLiteral) writeLfoOptions();
  else writeLfoCall();
}

function openLfoEditor(call) {
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (lfoState?.marker) lfoState.marker.clear();
  // The call marker outlives a switch only while it is being carried INTO the new state (lfoCarry).
  // Any other one is the panel's last look at some other call, and dropping the reference without
  // clearing it would leave the mark behind in the document for good.
  if (lfoState?.callSource && lfoState.callSource !== call.callSource) lfoState.callSource.clear();
  // A shape(...) definition is an lfo() with a name in front of it - drop the name and the rest
  // reads identically, exactly as a roll(...) reads as a pianoroll().
  lfoState = {
    marker: cm.markText(from, to, {}),
    callStart: call.start,
    // Set when this is a shape(...) definition: the name it is filed under, and the literal to
    // write back. Null for an inline lfo(...), which is the whole of its own modulator.
    shapeId: call.id ?? null,
    idLiteral: call.idLiteral ?? null,
    // The lfo() a definition was opened THROUGH, if any: rate and mode belong to it, not to the
    // shape, so that is where the panel's rate control writes. Null when opened from the picker.
    callSource: call.callSource ?? null,
    ...parseLfoCall(call.idLiteral ? splitFirstArg(inner)[1] : inner),
    ...(call.options ?? {}),
  };
  lfoRate.value = lfoState.rate;
  lfoMode.value = lfoState.mode;
  lfoPreset.value = '';
  lfoSyncHead();
  if (!lfoRaf) lfoRaf = requestAnimationFrame(lfoPlayheadLoop); // sweep the playhead while it runs
  lfoPanel.classList.remove('hidden');
  drawLfoShape();
}

/**
 * Puts shape `id`'s definition under the editor. A built-in preset is copied into the buffer first
 * (see forkShapePreset); false (and a line) for anything else this buffer hasn't got.
 */
function openShapeById(id, from = {}) {
  const name = String(id);
  const def = shapeDefs.defsInBuffer().find((d) => d.id === name);
  if (!def) {
    if (shapeMod?.SHAPE_PRESETS?.[name]) return forkShapePreset(name, from);
    logLine(
      shapeDefs.allIds().some((r) => r.id === name)
        ? `shape "${id}" is defined in prebake.js - open it there to edit its points`
        : `no shape(${JSON.stringify(name)}, …) in this buffer to open`,
      true
    );
    return false;
  }
  openLfoEditor({ ...def, ...from });
  return true;
}

/**
 * A built-in preset has no definition anywhere to put under the editor - `pluck` is a line of data
 * in shape.mjs, not something this buffer wrote - so editing one can only mean starting FROM it.
 * Write its points into the buffer under the same name and open that: the shadowing rule (buffer
 * first, presets after - see shapeNamed) then hands every lfo("<pluck>") already playing the copy
 * on screen, curve for curve identical until a point is moved. Which is exactly what the line this
 * replaces used to ask people to go and do by hand.
 *
 * Prebake's shapes are library entries too, but their data isn't ours to copy - the editor only
 * ever learns their names - so those still say where to go and edit them.
 */
function forkShapePreset(id, from = {}) {
  const data = shapeMod?.SHAPE_PRESETS?.[id];
  if (data == null) return false;
  const [start, end, text] = shapeDefs.defsEdit(cm.getValue(), [id], () => JSON.stringify(data));
  cm.replaceRange(text, cm.posFromIndex(start), cm.posFromIndex(end));
  refoldAll(); // the new definition starts life hidden, like every other one
  const def = shapeDefs.defsInBuffer().find((d) => d.id === id);
  if (!def) return false; // can't happen; never open a panel over a definition that isn't there
  logLine(`shape "${id}" was a built-in preset - copied into this buffer, where it now shadows it`);
  openLfoEditor({ ...def, ...from });
  lfoScheduleEval();
  return true;
}

// lfo("<pluck swell>") NAMES shapes rather than drawing them: the breakpoints live in the
// _shape(...) definitions, so open the one you can HEAR - read off the playback highlighter's lit
// spans, exactly as the roll and preset panels do. The shape names are on that grid like any other
// atom: the transpile wraps them in mini() for the purpose, and the server ships their steps with
// the track's own (see patternSigs). Stopped, it opens the first one named.
function openShapeFromIdCall(call, code) {
  const range = idStringRange(call, code);
  const id = range
    && (activeIdIn(range[0], range[1]) ?? (code.slice(range[0], range[1]).match(/[\w$]+/) ?? [])[0]);
  if (id == null) return false;
  // Marked so the panel's rate/mode controls can write back into this call while a definition of
  // its own is on screen (see writeLfoOptions).
  const callSource = cm.markText(cm.posFromIndex(call.start), cm.posFromIndex(call.close + 1), {});
  const { rate, rateHz, mode } = parseLfoCall(code.slice(call.open + 1, call.close));
  if (openShapeById(id, { callSource, options: { rate, rateHz, mode } })) return true;
  callSource.clear();
  return false;
}

function closeLfoEditor() {
  if (lfoState?.marker) lfoState.marker.clear();
  if (lfoState?.callSource) lfoState.callSource.clear();
  lfoState = null;
  lfoHead.closePicker(false);
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
  // Rewriting the call clears any fold covering it, so dragging a breakpoint would flick the shape
  // open and (an eval later) shut again. Re-fold now, in the same frame - as writePianorollCall
  // does, and for the same reason.
  refoldAll();
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
  // The call must still be the KIND the panel opened: a definition edited back into a plain lfo()
  // (or the other way round) is a different thing to be editing.
  // Read off the registry rather than spelled out here: a definition is `_shape(`, and a guard that
  // still said `shape(` would fail on every definition there is - closing the panel on the next
  // keystroke anywhere in the buffer. Same shape of test as syncPianorollFromCode's.
  const stillTheCall = new RegExp(`^\\s*${lfoState.idLiteral ? shapeDefs.defCall : 'lfo'}\\s*\\(`);
  if (!stillTheCall.test(text)) { closeLfoEditor(); return; }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const body = text.slice(open + 1, close);
  const parsed = parseLfoCall(lfoState.idLiteral ? splitFirstArg(body)[1] : body);
  lfoState.callStart = cm.indexFromPos(range.from);
  lfoState.points = parsed.points;
  // A _shape(...) definition carries no rate or mode - those live on the lfo() that names it, so
  // re-reading the definition must not reset them to the parse's defaults.
  if (!lfoState.idLiteral) {
    lfoState.rate = parsed.rate;
    lfoState.rateHz = parsed.rateHz;
    lfoState.mode = parsed.mode;
  }
  lfoRate.value = lfoState.rate;
  lfoMode.value = lfoState.mode;
  lfoSyncHead();
  drawLfoShape();
}

function initLfoEditor() {
  for (const name of Object.keys(shapeMod.SHAPE_PRESETS)) lfoPreset.add(new Option(name, name));

  // Opening is initWidgetHandles' job (double-click the name). Closing is the ✕, Escape, or the
  // call itself leaving the buffer - see syncLfoFromCode. Nothing about where the text cursor
  // happens to be: a panel you asked for stays put while you edit around it.
  cm.on('change', syncLfoFromCode); // hand edits to the open call flow back into the panel

  // The head: the name is the title and typing over it renames the shape everywhere it is played;
  // the ▾ behind it searches every shape there is and offers to make one that matches nothing.
  // Same gestures as the piano roll's, because it is the same widget (see makeNamePicker).
  lfoName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lfoName.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); lfoHead.revertName(); lfoName.blur(); return; }
    e.stopPropagation();
  });
  lfoName.addEventListener('blur', () => lfoHead.commitName());

  lfoPickBtn.addEventListener('click', () => {
    if (lfoHead.isOpen()) lfoHead.closePicker();
    else lfoHead.openPicker();
  });
  // Send what's on screen back into the lfo() the panel came from. Hidden unless there is one and
  // it plays something else - see lfoSyncHead.
  lfoUseBtn.addEventListener('click', () => {
    if (lfoState?.shapeId) lfoUseInCall(lfoState.shapeId);
  });
  lfoLockBtn.addEventListener('click', () => {
    lfoSetFollowLock(!lfoFollowLocked);
    lfoCanvas.focus({ preventScroll: true });
  });
  lfoSearch.addEventListener('input', () => lfoHead.renderList(true));
  lfoSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); lfoHead.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); lfoHead.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); lfoHead.choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); lfoHead.closePicker(); return; }
    e.stopPropagation();
  });
  // Anywhere else is "never mind" - including the canvas, which is where you were headed anyway.
  document.addEventListener('mousedown', (e) => {
    if (lfoHead.isOpen() && !lfoPickWrap.contains(e.target)) lfoHead.closePicker(false);
  });

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
    writeLfoRateMode();
  });
  lfoMode.addEventListener('change', () => {
    if (!lfoState) return;
    lfoState.mode = lfoMode.value;
    writeLfoRateMode();
  });
  // Cycles or hz. Same number, different unit - the value stays put so the toggle reads as "what
  // does this 2 mean", not as a conversion.
  lfoRateUnit.addEventListener('click', () => {
    if (!lfoState) return;
    lfoState.rateHz = !lfoState.rateHz;
    lfoSyncHead();
    writeLfoRateMode();
    drawLfoShape();
  });
  lfoCloseBtn.addEventListener('click', () => closeLfoEditor());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !lfoState) return;
    // Innermost first: the dropdown, then the panel. The name field stops the event itself.
    if (lfoHead.isOpen()) { e.preventDefault(); lfoHead.closePicker(); return; }
    closeLfoEditor();
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

// The LFO's phase at this instant, 0..1, or null when there is nothing honest to draw: the panel
// is closed, the transport is stopped, or the shape is note-gated (its phase belongs to the notes,
// which the browser doesn't see). A synced rate counts in cycles, a free one in seconds - the same
// two readings lfoRateHz makes of the same number.
function lfoPhaseNow() {
  if (!lfoState || transport.paused || lfoState.mode !== 'free') return null;
  const cycles = lfoState.rateHz
    ? (Date.now() / 1000 - transport.baseSec) * lfoState.rate
    : currentCyclePos() * lfoState.rate;
  return ((cycles % 1) + 1) % 1;
}

// One repaint per frame while the panel is open and the clock is running. Stops itself when the
// panel closes, like the piano roll's own loop.
let lfoRaf = null;
// The breakpoint being dragged, if any. Module-level rather than initLfoCanvas's own, because the
// follow loop has to know: swapping the shape out from under a pointer that is bending it would
// land the drag on whichever shape the pattern moved on to.
let lfoDrag = null; // { kind: 'point'|'curve', index }

function lfoPlayheadLoop() {
  if (!lfoState) { lfoRaf = null; return; }
  lfoFollowPlayingShape();
  if (!transport.paused && lfoState.mode === 'free') drawLfoShape();
  lfoRaf = requestAnimationFrame(lfoPlayheadLoop);
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

  // Where the shape is right now, as a line down the canvas. Only in free mode: retrigger and
  // envelope shapes are started by notes, and a line running on the transport's clock would be
  // pointing at the wrong place in the shape for most of the bar.
  const phase = lfoPhaseNow();
  if (phase != null) {
    const x = LFO_PAD + (W - 2 * LFO_PAD) * phase;
    ctx.strokeStyle = col('--accent');
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, LFO_PAD);
    ctx.lineTo(x, H - LFO_PAD);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function initLfoCanvas() {
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
    lfoDrag = pointIdx != null ? { kind: 'point', index: pointIdx } : { kind: 'curve', index: segmentAt(px) };
  });

  lfoCanvas.addEventListener('pointermove', (e) => {
    if (!lfoDrag || !lfoState || lfoDrag.index == null) return;
    const { px, py } = canvasPos(e);
    const pts = lfoState.points;
    if (lfoDrag.kind === 'point') {
      const i = lfoDrag.index;
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
      const seg = pts[lfoDrag.index];
      const rising = pts[lfoDrag.index + 1].y >= seg.y;
      const delta = (e.movementY ?? 0) * 0.08 * (rising ? 1 : -1);
      seg.c = Math.max(-12, Math.min(12, (seg.c ?? 0) + delta));
    }
    drawLfoShape();
  });

  lfoCanvas.addEventListener('pointerup', (e) => {
    if (lfoDrag && lfoState) writeLfoCall();
    lfoDrag = null;
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
// Preset picker - double-click the `preset` name in any `.preset(...)` call (just the name: its
// argument is code you may want to edit by hand) and the preset library opens on whichever one is
// sounding.
//
// Unlike the roll and shape panels there is nothing to draw: a preset IS the plugin's own program,
// and it is edited by turning the plugin's own knobs (auto-pin files what you touch into whichever
// preset the slot is on - and while this panel is open, that is the one it is showing; see
// presetHold). So finding, picking, naming and throwing away presets is the whole of what anyone
// opens this for, and the search box and the list ARE the panel rather than sitting behind a ▾.
// The name in the head is the one being edited; typing over it renames it everywhere it is played.
// ---------------------------------------------------------------------------------------------

const presetPanel = document.getElementById('presetPanel');
const presetTitle = document.getElementById('presetTitle');
const presetPickWrap = document.getElementById('presetPickWrap');
const presetName = document.getElementById('presetName');
const presetSearch = document.getElementById('presetSearch');
const presetPickList = document.getElementById('presetPickList');
const presetTargetEl = document.getElementById('presetTarget');
const presetSizeEl = document.getElementById('presetSize');
const presetHeldEl = document.getElementById('presetHeld');
const presetStatusEl = document.getElementById('presetStatus');
const presetCloseBtn = document.getElementById('presetClose');

// { marker, id, source, held } - `marker` spans the _preset(...) definition on screen (gone from
// the buffer = panel gone), `source` the id string of the call it was opened through, which is what
// makes a rename of a SHARED preset fork instead (see makeDefRegistry's fork), and `held` the
// { label, slot } this panel has asked the server to hold, remembered so the release doesn't have
// to re-derive a target that may have moved.
let presetState = null;

const presetCarry = () => (presetState ? { source: presetState.source } : null);

/** The `.preset(...)` call containing idx, plus whether idx is on its name - the handle. */
function findPresetCallAt(code, idx) {
  return findNamedCallAt(code, idx, /\.\s*preset\s*\(/g, 'preset');
}

// splitLabeledBlocks over the whole buffer, remembered for the code it was computed from. Every
// `.preset(...)` call is now asked which plugin it aims at (see presetDefs' scope), and that runs on
// each buffer change - so the scan has to happen once per keystroke, not once per call.
let presetBlocksCache = { code: null, blocks: [] };
function labeledBlocksFor(code) {
  if (presetBlocksCache.code !== code) presetBlocksCache = { code, blocks: labelsMod.splitLabeledBlocks(code) };
  return presetBlocksCache.blocks;
}

// Which plugin a `.preset(...)` at `idx` aims at: the last synth()/.fx() before it in its block,
// which is exactly the rule Sig#preset uses (the chain as it stood when the method was called).
// Read from the code rather than remembered, so moving the call between two .fx()es re-aims it.
function presetTargetAt(code, idx) {
  if (!labelsMod) return null;
  const block = labeledBlocksFor(code).find((b) => idx >= b.start && idx <= b.end);
  if (!block) return null;
  const isCode = codeOnly(code);
  const re = /\b(synth|fx)\s*\(/g;
  re.lastIndex = block.start;
  let m;
  let fxSeen = 0;
  let found = null;
  while ((m = re.exec(code)) && m.index < block.end) {
    if (!isCode(m.index)) continue; // a commented-out call holds no slot
    if (m.index > idx) break; // past the .preset(...) - a later .fx() is not what it aims at
    const slot = m[1] === 'synth' ? 0 : ++fxSeen;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    const [lit] = splitFirstArg(code.slice(open + 1, close < 0 ? code.length : close));
    found = { label: block.label, slot, plugin: idLiteralValue(lit.trim()) };
  }
  return found;
}

/** The plugin and the program out of a `_preset(id, plugin, state)` definition, read off the buffer. */
function presetDefParts(code, def) {
  const [, afterId] = splitFirstArg(code.slice(def.open + 1, def.close));
  const [pluginLit, stateLit] = splitFirstArg(afterId);
  return {
    plugin: idLiteralValue(pluginLit.trim()) ?? '',
    state: idLiteralValue(stateLit.trim()) ?? '',
  };
}

// The call the panel is looking THROUGH, and the plugin at the end of it. Re-derived on every sync
// rather than captured once: the call moves as you type around it, and which slot it addresses can
// change under it (add an .fx() above and slot 1 is a different plugin).
function presetTarget() {
  if (!presetState) return null;
  const code = cm.getValue();
  const call = sourceCallAmong(presetDefs.idCalls(code), presetState.source);
  return call ? presetTargetAt(code, call.start) : null;
}

const presetHead = makeNamePicker({
  els: { wrap: presetPickWrap, title: presetTitle, name: presetName, search: presetSearch, list: presetPickList },
  reg: presetDefs,
  inline: true, // the list is the panel - see the section header
  current: () => presetState?.id ?? null,
  // What this SLOT can load, which is not quite the open preset's own owner: point the panel at a
  // patch whose plugin has since changed and the list should offer what fits the plugin now there.
  scope: () => presetTarget()?.plugin ?? null,
  open: (id, sc) => openPresetById(id, presetCarry(), sc),
  canUse: () => !!presetState?.source,
  use: (id, sc) => presetUseInCall(id, sc),
  // Picking one leaves you in the search box rather than back in the code: browsing presets is a
  // run of gestures, not a single one.
  refocus: () => presetSearch.focus(),
});

// Puts `id` into the `.preset(...)` the panel is looking through, replacing whatever it names now,
// and follows it there. This is the panel's other half: opening a row shapes that preset, this one
// chooses it - so a patch with a library of presets and one call can be auditioned from the list
// without touching the code, and a patterned `.preset("<a b>")` can be collapsed onto one name.
//
// The whole argument goes, pattern and all, which is why the line says what it replaced: it is one
// undo away, but only if you can see that it happened.
function presetUseInCall(id, sc = presetTarget()?.plugin ?? null) {
  const span = presetState?.source?.find();
  if (!span) return;
  const was = cm.getRange(span.from, span.to);
  if (was === id) return openPresetById(id, presetCarry(), sc); // already the one named
  // A mark over just the string BODY collapses when the body is replaced wholesale, so take the
  // quotes in for the duration of the edit and put the inner mark back over the new name - the
  // same trick, and for the same reason, as makeDefRegistry's fork.
  const quoted = cm.markText({ line: span.from.line, ch: span.from.ch - 1 }, { line: span.to.line, ch: span.to.ch + 1 }, {});
  cm.replaceRange(id, span.from, span.to);
  const after = quoted.find();
  quoted.clear();
  presetState.source?.clear();
  presetState.source = after
    ? cm.markText({ line: after.from.line, ch: after.from.ch + 1 }, { line: after.to.line, ch: after.to.ch - 1 }, {})
    : null;
  logLine(`.preset("${was}") now plays "${id}"`);
  // Follow it, but only where there is something to follow: a library preset has no definition in
  // this buffer to edit, and the call naming it IS the whole gesture - reporting the missing
  // definition as a failure right after a write that worked would read as if the write hadn't.
  if (presetDefs.findDef(cm.getValue(), id, sc)) openPresetById(id, { source: presetState.source }, sc);
  else presetSyncHead();
  presetScheduleEval();
}

function openPresetById(id, from = {}, sc = presetTarget()?.plugin ?? null) {
  const def = presetDefs.findDef(cm.getValue(), String(id), sc);
  if (!def) {
    logLine(
      presetDefs.allIds(sc).some((r) => r.id === String(id))
        ? `preset "${id}" comes from the shared library - there is no definition here to edit. Capture one of your own and it will shadow it.`
        : `no preset called "${id}"${sc ? ` for ${sc}` : ''} is defined in this buffer`,
      true
    );
    return false;
  }
  showPresetPanel({ ...def, ...from });
  return true;
}

// `.preset("<a b>")` names presets, so open the one you can HEAR - read off the playback
// highlighter's own lit spans, the same grid the scheduler plays, so the panel can never disagree
// with what is sounding. Stopped, it opens the first one named.
function openPresetFromCall(call, code) {
  const range = idStringRange(call, code);
  if (!range) return false;
  const [from, to] = range;
  const id = activeIdIn(from, to) ?? (code.slice(from, to).match(/[\w$]+/) ?? [])[0];
  if (id == null) return false;
  const source = cm.markText(cm.posFromIndex(from), cm.posFromIndex(to), {});
  // Read from the call rather than from presetTarget(), which follows the panel - and the panel is
  // either closed or still showing whatever was open before this double-click.
  if (openPresetById(id, { source }, presetTargetAt(code, call.start)?.plugin ?? null)) return true;
  source.clear();
  return false;
}

// The panel holds its slot on the preset it is showing, for as long as it is open (see the server's
// /api/presetHold and Scheduler#holdPreset). This is not a nicety: a preset is edited by turning
// the plugin's own knobs, and `.preset("<a b>")` swaps which preset those knobs belong to every
// cycle - so without a hold, picking `a` and turning a knob puts the turn in whichever preset
// happened to be sounding, and a and b drift together instead of apart.
function presetHold(id) {
  const target = presetTarget();
  const at = target ? { label: target.label, slot: target.slot } : null;
  const was = presetState?.held ?? null;
  // Release the old slot first when the panel has moved to a different one, or the abandoned slot
  // would stay frozen with no panel left to unfreeze it.
  if (was && (!at || was.label !== at.label || was.slot !== at.slot)) presetRelease(was);
  if (presetState) presetState.held = at;
  if (!at) return;
  api('POST', '/api/presetHold', { trackId: at.label, slot: at.slot, preset: id })
    .then((res) => {
      if (!res?.why) return setPresetStatus('');
      // A preset the BUFFER defines for this slot's plugin can always be loaded here - so a refusal
      // means the scheduler hasn't been told about it yet, not that anything is wrong. That is the
      // normal state of a preset created a moment ago: a definition reaches the store only on the
      // next evaluation (see presetScheduleEval), and the panel's lease is retried on every poll
      // until it does. Reporting "can't load this one here" for a preset just made here is simply
      // wrong, and reporting "no preset called X" as an error for X we are in the middle of
      // creating is worse.
      if (presetLoadableHere(id)) return setPresetStatus('');
      // Short in the panel, the whole reason on the console.
      setPresetStatus("can't load this one here", 'bad');
      logLine(`preset "${id}": ${res.why}`, true);
    })
    .catch((e) => logLine(e.message ?? String(e), true));
}

// Whether the buffer defines `id` in a way this slot could load - the definition exists, and its
// plugin is the one the slot holds. Used to tell a preset the scheduler merely hasn't caught up
// with from one it will go on refusing however long you wait.
function presetLoadableHere(id) {
  const def = presetDefs.findDef(cm.getValue(), id, presetState?.scope ?? null);
  if (!def) return false;
  const plugin = presetTarget()?.plugin;
  return !plugin || !def.scope || def.scope === plugin;
}

function presetRelease(at) {
  if (!at) return;
  api('POST', '/api/presetHold', { trackId: at.label, slot: at.slot, preset: null }).catch(() => {});
}

function showPresetPanel(next) {
  // Only markers this panel is done with are cleared - switching presets in the picker carries the
  // source along (see presetCarry), and clearing it would drop the call being looked through.
  if (presetState?.marker && presetState.marker !== next.marker) presetState.marker.clear();
  if (presetState?.source && presetState.source !== next.source) presetState.source.clear();
  presetState = {
    id: next.id,
    // The plugin this preset belongs to, so the panel's own gestures - rename, delete - act on the
    // right one of however many presets share this name across the buffer's plugins.
    scope: next.scope ?? '',
    source: next.source ?? null,
    marker: cm.markText(cm.posFromIndex(next.start), cm.posFromIndex(next.close + 1), {}),
  };
  setPresetStatus('');
  presetPanel.classList.remove('hidden');
  presetSearch.value = '';
  presetSyncHead();
  presetHead.renderList(true);
  presetSearch.focus();
  presetHold(presetState.id);
}

function closePresetPanel() {
  presetRelease(presetState?.held); // the pattern gets its slot back
  if (presetState?.marker) presetState.marker.clear();
  if (presetState?.source) presetState.source.clear();
  presetState = null;
  presetHead.closePicker(false);
  presetPanel.classList.add('hidden');
}

function setPresetStatus(text, cls = '') {
  presetStatusEl.textContent = text;
  presetStatusEl.className = `preset-status${cls ? ` ${cls}` : ''}`;
}

// Everything the panel shows, re-read from the buffer: the name, how many patterns share it, what
// it is pointed at, and what it weighs. Called on every buffer change, so a hand edit to the
// definition shows up here instead of being quietly out of date.
function presetSyncHead() {
  if (!presetState) return;
  const code = cm.getValue();
  const def = presetDefs.findDef(code, presetState.id, presetState.scope);
  // Only the calls aimed at this preset's own plugin count as sharing it - another plugin's
  // .preset("disco") names a different preset, and a rename here leaves it alone.
  presetHead.syncHead(presetDefs.refCalls(code, presetState.id, presetState.scope).length);
  const target = presetTarget();
  presetTargetEl.textContent = target
    ? `${target.label} · slot ${target.slot} · ${target.plugin ?? 'no plugin'}`
    : '';
  // Said in the head, not inferred from the sound: while this panel is open the slot plays the
  // preset shown and the pattern does not swap it, which is the only way a preset can be edited by
  // ear - but it is still a change to what you are hearing, so it is on screen the whole time.
  presetHeldEl.classList.toggle('hidden', !presetState.held);
  presetHeldEl.title = 'this slot plays the preset shown for as long as this panel is open, so what you hear is what you are editing — close the panel and the pattern swaps it again';
  // Empty is a real state to be in - a name with nothing captured yet holds the plugin as it is -
  // so it is reported as a size, not as a warning.
  presetSizeEl.textContent = presetStateSize(def ? presetDefParts(code, def).state : '');
}

// What a captured program weighs. The definition holds a handle into the store rather than the
// program itself (see blobs.js), so the number comes from the server - once per handle, cached,
// because this runs on every buffer change. A state written in full (a patch pasted in from
// somewhere, a definition typed by hand) is measured where it stands.
const blobSizes = new Map(); // handle -> bytes, 'asking' while in flight, 'gone' if unstored
function presetStateSize(state) {
  if (!state) return 'empty';
  if (!state.startsWith('@')) return `${(state.length / 1048576).toFixed(1)} mb`;
  const known = blobSizes.get(state);
  if (known === undefined) {
    blobSizes.set(state, 'asking');
    api('GET', `/api/blobs/stat?id=${encodeURIComponent(state.slice(1))}`)
      .then(({ bytes }) => { blobSizes.set(state, bytes ?? 'gone'); presetSyncHead(); })
      .catch(() => blobSizes.delete(state)); // a failed request asks again rather than sticking on "…"
    return '…';
  }
  if (known === 'asking') return '…';
  if (known === 'gone') return 'missing';
  return `${(known / 1048576).toFixed(1)} mb`;
}

// A captured program reaching the BUFFER is not enough: the scheduler swaps presets out of the
// store, which only an evaluation refills - so a preset written and not evaluated would be replayed
// from its old program the next time the pattern came back round to it. Every write here schedules
// one, debounced like the shape editor's so a knob drag costs one request. evaluate(false) is the
// "update" path: a stopped clock stays stopped, a running one keeps running. The plugin itself is
// already holding what was captured, and markStateApplied stops the eval pushing it back.
let presetEvalTimer = null;
function presetScheduleEval() {
  clearTimeout(presetEvalTimer);
  presetEvalTimer = setTimeout(() => { presetEvalTimer = null; evaluate(false); }, LFO_EVAL_DEBOUNCE_MS);
}

// The definition the panel is anchored to left the buffer (deleted, or typed into something that
// is no longer a preset definition) - there is nothing left to show, so the panel goes with it.
// This is the only thing that closes it by itself, opening being an explicit double-click.
function syncPresetFromCode() {
  if (!presetState) return;
  const range = presetState.marker.find();
  if (!range) { closePresetPanel(); return; }
  if (!/^\s*_preset\s*\(/.test(cm.getRange(range.from, range.to))) { closePresetPanel(); return; }
  presetSyncHead();
}

function initPresetPanel() {
  cm.on('change', syncPresetFromCode);

  // The head: the same widget, the same gestures, as the roll's and the shape's (makeNamePicker).
  presetName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); presetName.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); presetHead.revertName(); presetName.blur(); return; }
    e.stopPropagation();
  });
  presetName.addEventListener('blur', () => presetHead.commitName());

  presetSearch.addEventListener('input', () => presetHead.renderList(true));
  presetSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); presetHead.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); presetHead.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); presetHead.choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePresetPanel(); return; }
    e.stopPropagation();
  });

  presetCloseBtn.addEventListener('click', () => closePresetPanel());
  document.addEventListener('keydown', (e) => {
    // There is no popover to unwind first - escape is the panel's. The name field stops the event
    // itself, so a rename in progress reverts before this ever sees it.
    if (e.key === 'Escape' && presetState) closePresetPanel();
  });
}

// ---------------------------------------------------------------------------------------------
// Interactive piano roll editor - double-click the `pianoroll` name in any `pianoroll(...)` call
// (just the name: its arguments are code you may want to edit by hand) and an Ableton-style grid opens
// over the editor, with a real piano keyboard down the left edge and a playhead that sweeps the
// steps as it plays. Two tools (pencil draws, arrow marquee-selects); click a note
// to select it (shift-click extends, ctrl/cmd-A selects all), drag to move, drag a note's right
// edge to resize, cmd-drag vertically to set velocity or probability (whichever the value lane's gutter
// label has picked), cmd-D
// duplicates, option-drag drags a copy, cmd-Z / cmd-shift-Z walk the roll's own undo history.
// Arrow keys nudge the selection (shift-up/down = octave, shift-right/left lengthen/shorten), delete removes
// it, double-click erases one, and 0 mutes it - greyed out and silent, still there to switch back
// on with another 0 (Live's deactivate). A value lane along the bottom shows every note's velocity
// or probability (its gutter label names the channel and clicks through to the other one) as an
// Ableton-style marker - a dot at the onset, a line running right for the duration, dashed for
// probability. With the arrow tool a marker drags up and down, whole selection at once, keeping the
// selection's differences; with the pencil you PAINT instead, and every note the drag sweeps over
// snaps to the height you're holding it at (see prPaintLane). 🎲 rolls the whole channel at once -
// the selection, or the roll. A note dropped on one already sounding at that pitch keeps its own
// length and the one underneath gives way - cut short, or hidden if it was landed on square - and
// gets everything back the moment the note on top moves away (see prClipOverlaps). Wheel scrolls
// pitch, shift-wheel scrolls time, ctrl-wheel (or cmd ±)
// zooms in on fine grids. Every note carries a pitch AND a sample index, and the `note`/`index`
// button says which of them the rows are showing - a piano keyboard, or a plain 0, 1, 2, … count of
// a pack's files driving .i(). Switching moves nothing and changes no sound (see prSetMode). `fold`
// hides the rows nothing is drawn on, on either axis; `scale` hides everything outside the key, and
// greys out on the index rows, where there is no key. The loop bar along the top carries the playing window: drag either end
// anywhere on the timeline - so a loop can open half way through bar 1 and close half way through
// bar 2, the note it opens on being the pattern's first beat - or drag its body to slide the whole
// window over the notes (its ends snap to bar lines and their halves - hold shift for exact cells),
// and ⧉ repeats the window after itself at twice the length. The grid menu re-meshes the roll
// keeping the music where it is (a 1/4-grid quarter note becomes four 1/16 cells), while ÷2 / ×2
// stretch the music itself - the selected notes, or the whole roll when nothing is selected. Clicking the scale chip snaps every note into
// the key. Clicking anywhere outside the panel closes it - the roll is a tool you reach past to get back to the code.
// With 🎧 on, drawing/dragging previews the note through the track's own
// synth; →♪ rewrites the whole roll as an equivalent mini-notation note("…"). Every change is
// serialized straight back into `pianoroll("midi,start,len[,vel[,prob]] …", { grid, len, start })` and
// re-evaluated (debounced), so the track plays what's drawn without a manual ⏎; hand edits to the
// call flow the other way, back into the open panel. The code stays the single source of truth,
// exactly like the lfo() shape editor.
// ---------------------------------------------------------------------------------------------

const prPanel = document.getElementById('pianorollPanel');
const prTitle = document.getElementById('pianorollTitle');
const prPickWrap = document.getElementById('pianorollPickWrap');
const prName = document.getElementById('pianorollName');
const prPickBtn = document.getElementById('pianorollPickBtn');
const prPicker = document.getElementById('pianorollPicker');
const prSearch = document.getElementById('pianorollSearch');
const prPickList = document.getElementById('pianorollPickList');
const prLockBtn = document.getElementById('pianorollLock');
const prCanvas = document.getElementById('pianorollCanvas');
const prGridSelect = document.getElementById('pianorollGrid');
const prLenInput = document.getElementById('pianorollLen');
const prSwingBox = document.getElementById('pianorollSwing'); // a box slider, not a text field (see prMakeBoxSlider)
const prSwingGridSelect = document.getElementById('pianorollSwingGrid');
const prCommitSwingBtn = document.getElementById('pianorollCommitSwing');
const prHalveBtn = document.getElementById('pianorollHalve');
const prDoubleBtn = document.getElementById('pianorollDouble');
const prDupLoopBtn = document.getElementById('pianorollDupLoop');
const prToolBtn = document.getElementById('pianorollTool');
const prModeBtn = document.getElementById('pianorollMode');
const prScaleFoldBtn = document.getElementById('pianorollScaleFold');
const prFoldBtn = document.getElementById('pianorollFold');
const prScaleLabel = document.getElementById('pianorollScale');
const prPreviewBtn = document.getElementById('pianorollPreview');
const prRandomBtn = document.getElementById('pianorollRandom');
const prToMiniBtn = document.getElementById('pianorollToMini');
const prSide = document.querySelector('.pianoroll-side');
const prSideToggle = document.getElementById('pianorollSideToggle');
const prCloseBtn = document.getElementById('pianorollClose');

const PR_W = 660; // grid width with the control column open; the CSS owns it from there (see prW)
const PR_TOPBAR = 16; // loop-ruler strip along the top (drag it to set the loop length)
const PR_GRIDH = 384; // piano-grid height below the ruler
const PR_LANEH = 64; // value lane below the grid (per-note velocity / probability markers)
const PR_CH = PR_TOPBAR + PR_GRIDH + PR_LANEH; // full canvas height
const PR_LANE_PAD = 5; // lane inset above 1.0 / below 0.0, so end-stop markers stay visible
const PR_LANE_CARET_W = 7; // solid caret after the value lane's channel label, marking it clickable
const PR_ROWS = 24; // visible semitone rows (2 octaves)
const PR_GUTTER = 54; // left piano-keyboard gutter, px
// Top row when a fresh/empty roll opens - a MIDI note, framed 24 rows down to 24, so the window is
// exactly the two octaves c2..b3 (this package names middle C c5 - see notes.mjs). The bottom row
// is the sampler's native pitch: MIDI 24 is where a sample plays as recorded (DEFAULT_SYNTH_NOTE,
// and the engine's repitch anchor), so on a sampler roll the "as recorded" row is the floor of the
// window rather than somewhere off the bottom of it. It is also the register poptart's own idiom
// writes in - the note() examples through the docs are c2/c3/f3. A roll that already HAS notes
// ignores this and frames its own (prFramePitch), so this is only what an empty one opens at.
const PR_DEFAULT_TOP = 47;
// Top row an INDEX roll opens at: index 0 sits on the bottom row, because a pack is counted up
// from its first file and nothing lives below it. (prMetrics clamps pitchTop to at least this, so
// the axis can never be scrolled past 0 into negative indices.)
const PR_INDEX_TOP = PR_ROWS - 1;
const PR_INDEX_GROUP = 4; // rows per heavy line on the index axis - and shift-arrow's jump on it
const PR_DEFAULT_VEL = 0.8; // velocity of a freshly drawn note
const PR_EDGE_PX = 6; // right-edge grab zone for resizing
const PR_MAX_ZOOM = 24; // deepest horizontal zoom (cells that many times wider than "fit")
const PR_ZOOM_WHEEL = 0.0012; // wheel-zoom sensitivity (smaller = slower); proportional to deltaY
const PR_PITCH_WHEEL = 0.013; // wheel pitch-scroll sensitivity, rows per deltaY unit (smaller = slower)
const PR_BTN_ZOOM = 1.4; // per-keypress zoom step for cmd ± (the wheel zooms proportionally)
const PR_EVAL_DEBOUNCE_MS = 150; // quiet time after the last roll edit before it re-evaluates
const PR_WRITE_COALESCE_MS = 60; // fastest a live control (the swing slider) rewrites the call
const PR_BOX_SWEEP_PX = 170; // sideways travel for a box slider's full range; shift is a tenth of it
const PR_GRID_DIVS = [['1/4', 4], ['1/8', 8], ['1/8T', 12], ['1/16', 16], ['1/16T', 24], ['1/32', 32], ['1/64', 64]];
// Vertical time lines, by how coarse a division they land on (0 = a bar line, 1 = its halves, …):
// how wide they are drawn and how solid. Past the end of the arrays every deeper level draws like
// the last one.
const PR_DIV_W = [1.4, 1.1, 0.9, 0.7, 0.55];
const PR_DIV_A = [1, 0.95, 0.75, 0.55, 0.4];
const PR_DIV_MIN_PX = 5; // a division whose lines crowd closer than this drops out until you zoom in
// How hard the loop bar's ends are pulled onto a bar line, its half-way point and its quarters (by
// division level, in screen px). Anything the pointer isn't that close to lands on a plain cell,
// and holding shift turns the magnet off entirely. Levels past the end of the array aren't magnetic
// - they're already reachable by cell.
const PR_SNAP_PX = [18, 12, 8];

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
// The channels the value lane edits, in the order its gutter label cycles them. vel and prob are
// 0..1; nudge is the drawn time offset (see pianoroll.mjs), bipolar around 0 and measured in cells.
const PR_LANE_KEYS = ['vel', 'prob', 'nudge'];
const PR_MAX_NUDGE = 0.5; // mirrors pianoroll.mjs's PIANOROLL_MAX_NUDGE - half a cell either way
// What the lane and cmd-drag set. Deliberately NOT sticky, unlike the tool and the folds: a roll
// opened fresh always shows `vel`, because that is what you reach for nearly every time, and a lane
// still parked on `nudge` from a session an hour ago reads as the panel having lost its place.
// Switching channels lasts as long as the panel stays open (see openPianorollEditor).
let prCmdMode = 'vel';
let prScaleFold = localStorage.getItem('poptartPianorollScaleFold') === '1'; // show only the scale's rows
let prFold = localStorage.getItem('poptartPianorollFold') === '1'; // Live's Fold: only rows that have notes
let prSideMin = localStorage.getItem('poptartPianorollSide') === '1'; // timing controls column minimized
// The grid's logical width in CSS px. PR_W to start with, but the canvas is a flex child now: it
// takes whatever the control column isn't using, so minimizing the column widens the roll instead
// of resizing the panel. prSizeCanvas keeps this, the backing store and the drawing in step.
let prW = PR_W;
// Whether the panel STOPS following the pattern. Opened from a pianoroll("<0 chorus>") the roll on
// screen is whichever one is sounding, which is what you want when you're reading along and the
// last thing you want when you're drawing into one mid-set - so it pins, and the pattern goes on
// switching what you HEAR either way. Sticky, like the tool and fold settings.
let prFollowLocked = localStorage.getItem('poptartPianorollLock') === '1';
let prPrebakeRolls = []; // ids from ~/.poptart/prebake.js: listed in the picker, not editable here
let prPrebakeShapes = []; // the same for shape(...) definitions
let prPrebakePresets = []; // ...and for captured plugin presets, a sound library shared by every patch
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
  if (prScaleLabel) prScaleLabel.textContent = prIndexMode() ? '' : (patchScale ?? '');
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

// --- the two axes ---
// Every event in a roll carries BOTH a pitch and a sample index - two channels of one event (see
// pianoroll.mjs). The mode says which of them the vertical axis is showing you:
//
//   note   the piano keyboard this editor has always had. A row is a semitone; a note drawn here
//          gets sample index 0.
//   index  a plain 0, 1, 2, … count of a pack's files, driving `.i()`. A row is a file; a note
//          drawn here gets pitch c2, where a sample plays as recorded.
//
// Switching moves nothing and changes no sound - the timings, lengths, velocity, probability and
// mute are the same events either way, and the other channel keeps whatever it already had. It is
// a change of view, so it costs one `mode:` in the call and nothing else.
//
// What DOESN'T carry over is the key: a pack has no scale, so `scale` (the tint and its fold) is a
// note-axis feature. It stays in the toolbar - greyed, not removed, so the buttons never move
// under the pointer - and `fold`, which hides the rows nothing is drawn on, works on both.

const prIndexMode = () => prState?.mode === 'index';

/** The channel the axis is showing: which key of a note object a drawn ROW reads and writes. */
const prRowField = () => (prIndexMode() ? 'index' : 'midi');

/** Where a note sits on the axis currently on screen. */
const prRowOf = (nt) => (prIndexMode() ? pianorollMod.noteIndex(nt) : nt.midi);

/** Move a note to row `row` on the axis currently on screen, leaving its other channel alone. */
const prSetRow = (nt, row) => { nt[prRowField()] = Math.max(0, Math.min(127, Math.round(row))); };

/** A fresh note at row `row`: the drawn channel takes the row, the other one its resting value. */
const prNewNote = (row, cell) => ({
  ...pianorollMod.pianoRollEventAt(row, prState.mode),
  start: cell,
  len: 1,
  full: 1,
  vel: PR_DEFAULT_VEL,
  prob: 1,
  nudge: 0, // on the grid until something drags it off - see the value lane's nudge channel
  mute: false,
});

/** Rows either side of one another in the axis's own units: an octave, or a group of 4 indices. */
const prAxisJump = () => (prIndexMode() ? PR_INDEX_GROUP : 12);

/** The mode button's face, and the one control that only means something on one of the two axes. */
function prSyncMode() {
  if (!prState) return;
  const index = prIndexMode();
  // The label IS the state - which is why this button never takes the `active` accent the toggles
  // do: switching would flash the accent colour off behind the new word, and the word had already
  // said it.
  prModeBtn.textContent = index ? 'index' : 'note';
  prModeBtn.title = index
    ? 'rows are sample indices (.i()) — click for note names'
    : 'rows are note names — click for sample indices (.i())';
  // Greyed rather than hidden: a toolbar that reshuffles itself under the pointer is worse than a
  // button that plainly doesn't apply here. Both of these are keyboard things - a key to fold to,
  // and a pitch to audition - and the index rows have neither. (Preview would happily play the c2
  // every index note sits at, which is worse than silence: it would sound the same on every row.)
  prScaleFoldBtn.disabled = index;
  prScaleFoldBtn.title = index
    ? 'a key is a note-axis thing — switch to note rows to fold to the scale'
    : 'show only the scale set by setscale()';
  prPreviewBtn.disabled = index;
  prPreviewBtn.title = index ? 'the index rows name files, not pitches — nothing to audition' : 'preview notes as you draw';
  prScaleLabel.textContent = index ? '' : (patchScale ?? '');
}

/**
 * Switch which channel the axis shows. Nothing about the roll moves: the notes are the same
 * events, drawn against a different ruler, and each keeps the channel you can't currently see. The
 * view is re-framed around wherever they land on the new axis, which is the only thing that has to
 * change.
 */
function prSetMode(mode) {
  if (!prState || prState.mode === mode) return;
  prState.mode = mode;
  prState.sel.clear(); // a selection is a set of rows to nudge, and the rows just changed meaning
  prPreviewOff();
  prSyncMode();
  prFramePitch();
  writePianorollCall();
  drawPianoroll();
}

// --- lanes ---
// The roll's vertical axis is a list of LANES rather than raw rows. Unfolded every row gets one, so
// a lane index simply *is* its row value (a MIDI note, or a sample index) and all the geometry
// below is unchanged. Two things narrow it:
//
//   fold    Live's Fold - only the rows something is actually drawn on. Works on either axis: on
//           the keyboard it collapses a two-octave line to the notes it uses, on the index axis to
//           the files the pack actually plays. Nothing drawn means nothing to fold to, so it falls
//           back to the full axis rather than to an empty one.
//   scale   only the notes of the global key, plus any pitch the roll actually uses - so it can
//           never hide a note you drew (an out-of-key one keeps its dimmed lane, which is exactly
//           the signal you want). Note axis only; a pack has no key.
//
// Both at once is just fold: it is the narrower of the two, and the rows it keeps are the ones you
// drew, in or out of the key.

/** The lane list, low to high, or null for the identity mapping (lane index === row value). */
function prLaneList() {
  const used = [...new Set(prLiveNotes(prState.notes).map(prRowOf))].sort((a, b) => a - b);
  if (prState.fold) return used.length ? used : null;
  const info = prIndexMode() || !prState.scaleFold ? null : prScaleInfo();
  if (!info) return null;
  const inUse = new Set(used);
  const lanes = [];
  for (let midi = 0; midi <= 127; midi++) if (info.pcs.has(pitchClass(midi)) || inUse.has(midi)) lanes.push(midi);
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

/** row value -> lane index. Off-lane rows (a note mid-drag) resolve to the nearest lane below. */
const prPosOf = (midi, m) => (m.lanes ? m.laneOf[Math.min(127, Math.max(0, Math.round(midi)))] : midi);

/** lane index -> row value, clamped to the ends of the axis. */
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
  // `end` is the next block's start, so the test is half-open: a call at a block's very first
  // character - which is what a column-0 `pianoroll()` is - belongs to THAT block, not the one
  // above it. (blockAtCursor deliberately keeps the closed test: a cursor may sit at the end of
  // the buffer, which is one past the last block.)
  return labelsMod.splitLabeledBlocks(cm.getValue()).find((b) => idx >= b.start && idx < b.end)?.label ?? null;
}

// --- note preview: play the drawn note through the track's own synth (if the 🎧 toggle is on and
// the track has been evaluated with an instrument). One note at a time; always paired with an off.
function prPreviewSend(note, isOn) {
  if (!prState?.trackLabel) return;
  api('POST', '/api/previewNote', { trackId: prState.trackLabel, note, vel: PR_DEFAULT_VEL, isOn }).catch(() => {});
}
function prPreview(midi) {
  // An index roll's rows are files in a pack, not pitches: there is nothing here that knows what
  // row 3 sounds like, and playing it as MIDI note 3 would be a lie rather than a preview.
  if (!prPreviewEnabled || prIndexMode() || prSounding === midi) return;
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

// Splits `roll(id, "notes", { … })`'s argument list at its first TOP-LEVEL comma - the id, then
// exactly what pianoroll() itself takes. String- and bracket-aware, so a comma inside the note
// string or the options object doesn't count.
function splitFirstArg(inner) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1)];
  }
  return [inner.trim(), ''];
}

// The document range of a pianoroll(...) call's id STRING content - what the playback highlighter
// lights an atom of, and what tells us which roll is sounding.
function idStringRange(call, code) {
  const inner = code.slice(call.open + 1, call.close);
  const m = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(inner);
  if (!m) return null;
  const from = call.open + 1 + m.index + 1;
  return [from, from + m[2].length];
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
  // start: where the loop window opens, in cells. 0 (the default) is left out of the code entirely.
  const startM = /\bstart\s*:\s*(\d+)/.exec(inner);
  const start = startM ? Math.max(0, Math.round(Number(startM[1]))) : 0;
  // mode: what the rows MEAN - notes (the default, and what every roll drawn before index mode
  // existed says) or sample indices. Only ever written when it isn't the default.
  const modeM = /\bmode\s*:\s*(["'`])(\w+)\1/.exec(inner);
  const mode = pianorollMod.normalizePianoRollMode(modeM?.[2]);
  // swing: the roll's own groove knob, and the division it acts on. Both are left out of the code
  // at their defaults (straight, and the roll's own grid), like start and mode.
  const swingM = /\bswing\s*:\s*(-?[\d.]+)/.exec(inner);
  const swing = swingM ? Math.min(0.5, Math.max(-0.5, Number(swingM[1]) || 0)) : 0;
  const sgM = /\bswinggrid\s*:\s*(\d+)/.exec(inner);
  const swinggrid = sgM ? Math.max(1, Math.round(Number(sgM[1]))) : null;
  let notes = [];
  try {
    notes = pianorollMod.parsePianoRoll(noteStr);
  } catch {
    // unparseable note string - start from an empty roll
  }
  return { notes, grid, len, start, mode, swing, swinggrid };
}

// Hidden notes (buried under another - see prClipOverlaps) are left out: the code holds what
// actually sounds, and they are only kept around in the panel so they can come back.
function serializePianorollCall({ notes, grid, len, start, mode, swing, swinggrid, idLiteral }) {
  const from = start ? `, start: ${start}` : ''; // a window that opens at 0 is the default - don't write it
  const how = mode === 'index' ? ', mode: "index"' : ''; // notes are the default - don't write it
  // A straight roll writes no swing at all, and one swinging its own grid writes no division: both
  // are what the builder assumes, and a roll that says nothing about groove should look like one.
  const sw = swing ? `, swing: ${Math.round(swing * 100000) / 100000}` : '';
  const swg = swing && swinggrid && swinggrid !== grid ? `, swinggrid: ${swinggrid}` : '';
  const body = `"${pianorollMod.serializePianoRoll(prLiveNotes(notes))}", { grid: ${grid}, len: ${len}${from}${how}${sw}${swg} }`;
  // The roll being edited is either drawn inline or kept under an id - same notes, same options,
  // one argument apart. The id is written back exactly as it was found, so _roll(0, …) doesn't
  // become _roll("0", …) the first time you move a note.
  //
  // rollDefs.defCall, not the bare `roll(` this used to write. The marker being replaced covers
  // the leading underscore, so writing the legacy name dropped it - and for the moment before the
  // next eval put it back, the buffer held no definition the editor could recognise: the run's
  // chip fell off, and the data argument got chipped on its own instead. Every write is now the
  // same shape the definition already had, so a note drawn into a roll changes only the notes.
  return idLiteral ? `${rollDefs.defCall}(${idLiteral}, ${body})` : `pianoroll(${body})`;
}

// ---------------------------------------------------------------------------------------------
// Auto-naming: nobody types roll(...).
//
// `lead: pianoroll().synth("Serum 2")` is all it takes to get a named roll. An empty pianoroll() is
// a request for a new one, so it is given an id (its track's name, or `roll2`, `roll3`… when that
// is spoken for) and a definition; and an id a pattern NAMES but nothing defines - the second half
// of `pianoroll("<lead alt>")` - gets an empty definition too, which is how a second roll comes
// into being. The definitions go in a block at the foot of the buffer, folded to one chip
// (see foldDefRuns), so `roll(` is a word the user need never read or write. The console says what
// was created, so a typo makes an empty roll you can SEE rather than silence you have to work out.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Named definitions: one registry, three kinds of data
//
// `roll("lead", "…")` keeps drawn notes under a name so a pattern can say the name instead of
// carrying the notes; `shape("swell", "…")` does the same for a drawn LFO shape. They are the same
// idea applied to different data, and - more to the point - the same handful of fiddly text edits:
// find the definitions, hide them, name a new one after its track, rename one everywhere it is
// played, split one that two patterns share, delete one nothing plays any more. That is what this
// factory holds. Each kind supplies the words (which call defines one, which call names them, what
// an empty one looks like) and the hooks its editor panel needs; everything else is shared, which
// is why a fix like "don't fold a name as if it were data" only has to be made once.
//
// The definitions are ordinary code in the buffer - export, undo, share links and git see the whole
// patch - and the editor folds them out of the way rather than storing them anywhere else.
// ---------------------------------------------------------------------------------------------

// A name has to survive being written inside a mini pattern - pianoroll("<lead pad>") - so it is
// one plain word: no whitespace and none of mini's own punctuation. Same rule the builders apply
// on their own side (see signal.mjs).
const DEF_ID_BAD = /[\s<>[\]{}(),*!?~@|:/"'`.]/;

// The id a definition files itself under, read off its first argument's literal - a quoted name or
// a bare number, matching String(id) on the builder's side. Null for anything else (an id built
// from a variable is real code, and not something the editor can rewrite).
function idLiteralValue(literal) {
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(literal);
  if (quoted) return quoted[2];
  return /^-?\d+(?:\.\d+)?$/.test(literal) ? String(Number(literal)) : null;
}

// The ids a "<a b>" string names. Mini's own modifiers are stripped first so the `2` of `<a b>*2`
// isn't read as a name, and `~` (a rest) and `_` (hold) are the notation's own words.
function idsNamedIn(str) {
  const bare = String(str).replace(/[*/!@:]\s*\d+(?:\.\d+)?/g, ' ');
  return [...new Set((bare.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/g) ?? []).filter((w) => w !== '_'))];
}

// The word-boundary form of an id, for finding it inside a "<lead pad>" string: `lead` must not
// match the `lead` of `leader`.
function idWordRe(id, flags = 'g') {
  return new RegExp(`(?<![\\w$])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, flags);
}

// Renaming inside one call's string, occurrence by occurrence rather than by replacing the whole
// string. A change strictly INSIDE a marker leaves that marker in place, which is what keeps a
// panel's `source` (and the highlighter's spans) pointing where they were.
function idOccurrenceEdits(call, from, to) {
  const out = [];
  const word = idWordRe(from);
  let m;
  while ((m = word.exec(call.str)) !== null) out.push([call.from + m.index, call.from + m.index + m[0].length, to]);
  return out;
}

// The span of the id literal inside a definition - the `"lead"` of roll("lead", "…").
function defIdLiteralRange(code, def) {
  const inner = code.slice(def.open + 1, def.close);
  const [idLiteral] = splitFirstArg(inner);
  const at = def.open + 1 + inner.indexOf(idLiteral);
  return [at, at + idLiteral.length];
}

// The span a definition occupies when it is taken out: its whole LINE where it has one to itself
// (which is how they are written), or just the call where it is sharing with other code.
function defLineRange(code, def) {
  const lineStart = code.lastIndexOf('\n', def.start - 1) + 1;
  const end = def.close + 1;
  const tail = /^[ \t;]*(?:\r?\n|$)/.exec(code.slice(end));
  if (tail && /^\s*$/.test(code.slice(lineStart, def.start))) return [lineStart, end + tail[0].length];
  return [def.start, end];
}

/** Applies [from, to, text] edits as one undoable step. Sorted here, so callers needn't be. */
function applyEdits(edits) {
  const sorted = [...edits].sort((a, b) => a[0] - b[0]);
  cm.operation(() => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      cm.replaceRange(sorted[i][2], cm.posFromIndex(sorted[i][0]), cm.posFromIndex(sorted[i][1]));
    }
  });
}

// A new definition is named after the track it is in - `lead` reads far better in a picker than
// `1` - falling back to the kind's own word where the block has no name of its own. A number is
// appended only to break a tie, so the common case is the plain track name.
// `taken` is a Set of names, or - where what counts as taken depends on more than the name (a
// preset is only taken within its own plugin, see makeDefRegistry's scope) - a predicate.
/**
 * The name a fresh definition would LIKE: its block's label, when that reads as an identifier, and
 * the kind's own word otherwise. Named separately from freshDefId because a caller that has just
 * been given a suffixed name often wants to know what it asked for - see libraryBumpNote.
 */
const preferredDefId = (label, base) => (/^[A-Za-z_][\w]*$/.test(label ?? '') ? label : base);

function freshDefId(label, taken, base) {
  const isTaken = typeof taken === 'function' ? taken : (name) => taken.has(name);
  const name = preferredDefId(label, base);
  if (!isTaken(name)) return name;
  for (let i = 2; ; i++) if (!isTaken(`${name}${i}`)) return `${name}${i}`;
}

/**
 * Says so when an auto-named definition was pushed off the name it wanted by something OUTSIDE the
 * buffer - a built-in shape preset, a prebake roll. A collision inside the buffer explains itself
 * (the other definition is right there on screen), but a library one is invisible: the `2` appears
 * from nowhere and reads as a bug. The shadowing is the reason it matters - a buffer definition
 * WINS over the library of the same name (see shapeNamed), so taking the name would quietly
 * repoint every other use of it in the patch.
 */
function libraryBumpNote(kind, wanted, got, note) {
  if (got === wanted) return;
  logLine(`named this ${kind} "${got}": "${wanted}" is a ${note} ${kind} already, and a ${kind} of your own by that name would shadow it.`);
}

/** Which of `refs` the panel is looking THROUGH, given the marker over its id string. */
function sourceCallAmong(refs, sourceMark) {
  const range = sourceMark?.find();
  if (!range) return null;
  const a = cm.indexFromPos(range.from);
  const b = cm.indexFromPos(range.to);
  return refs.find((call) => call.from <= a && call.to >= b) ?? null;
}

/**
 * One kind of named definition. `opts`:
 *   kind        what the console calls one of these ("roll")
 *   section     what a PLAYER calls a block of these ("pianorolls") - the word on the folded chip.
 *               The editor's own name for the panel that edits them, not the builder's, and always
 *               plural: the chip names the SECTION, and how many are in it is not the point
 *   defCall     the (private) builder that defines one ("_roll")
 *   useCall     the builder that NAMES them ("pianoroll")
 *   legacyCall  what defCall was called back when it was public ("roll"), for the migration to
 *               rename - and ONLY for that. A kind that was never public must leave this unset:
 *               deriving it by dropping the underscore would have the migration rewrite
 *               .preset("<a b>") into ._preset("<a b>"), destroying the calls it was meant to fix.
 *   emptyBody   the rest of the argument list a new, empty definition is written with (defsEdit
 *               takes a per-id override, for a caller that has real content to file)
 *   isData      (str) => true if the useCall's string is DATA rather than names; null when the
 *               module that can tell hasn't loaded yet, in which case nothing is assumed
 *   library     () => ids that exist without being defined here (prebake, built-in presets)
 *   panel       the editor panel's hooks - see the roll instance below for the full shape
 */
function makeDefRegistry(opts) {
  const { kind, section, defCall, useCall, legacyCall = null, emptyBody, isData, library, libraryNote, panel, scope = null } = opts;
  const say = (line, isError) => logLine(line, isError);

  // A kind whose names are only unique WITHIN something else. A preset belongs to the plugin it was
  // captured from - a program is meaningless to any other plugin - so `disco` on a delay and `disco`
  // on a reverb are two unrelated presets that share a word, and a chain of three effects can carry
  // three presets all called `disco` instead of disco1/disco2/disco3. `scope` reads that owner off a
  // definition (its plugin argument) and off a call (the plugin its slot holds). A kind without one
  // has a single flat namespace, and every scope question below answers trivially true.
  const scopeOfDef = (code, def) => (scope ? scope.ofDef(code, def) ?? '' : '');
  const scopeOfCall = (code, call) => (scope ? scope.ofCall(code, call) ?? '' : '');
  // Two scopes match when they agree, or when either is UNKNOWN. An empty one is a definition named
  // but never captured into, which belongs to whichever plugin claims it first, and a call the
  // editor can't aim yet must not be filtered away from the name it uses. Same rule as lookupPreset.
  const sameScope = (a, b) => !scope || !a || !b || a === b;
  const scopedBody = (sc) => (typeof emptyBody === 'function' ? emptyBody(sc) : emptyBody);
  // A library entry is a bare id for the flat kinds, { id, scope } for a scoped one.
  const libId = (e) => (typeof e === 'string' ? e : e.id);
  const libScope = (e) => (typeof e === 'string' ? '' : e.scope ?? '');
  const inLibrary = (id, sc) => library().some((e) => libId(e) === id && sameScope(libScope(e), sc));
  // Which owner the panel's gestures act in - the plugin the open preset belongs to. Null for a
  // flat kind, and null is the scope that matches everything, so nothing narrows by accident.
  const panelScope = () => (scope && panel.scope ? panel.scope() : null);

  // Is this string a list of NAMES rather than the data itself? The two share one argument
  // position, so the question is answered by what the string says, not by which call it is.
  const isIdString = (str) => {
    if (!String(str).trim()) return false;
    const data = isData(String(str));
    return data === null ? false : !data;
  };
  const isIdCall = (inner) => isIdString(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(inner)?.[2] ?? '');

  // Every definition in the buffer: { id, idLiteral, start, open, close }. Commented-out ones are
  // skipped - they define nothing, so there is nothing there to open.
  function defsInBuffer(code = cm.getValue()) {
    const isCode = codeOnly(code);
    const re = new RegExp(`\\b${defCall}\\s*\\(`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!isCode(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      if (close < 0) continue;
      const [idLiteral] = splitFirstArg(code.slice(open + 1, close));
      const id = idLiteralValue(idLiteral);
      if (id == null) continue;
      const def = { id, idLiteral, start: m.index, open, close };
      def.scope = scopeOfDef(code, def);
      out.push(def);
    }
    return out;
  }

  /** This buffer's definition of `id` within `sc`, or null. */
  function findDef(code, id, sc = null) {
    return defsInBuffer(code).find((d) => d.id === id && sameScope(d.scope, sc)) ?? null;
  }

  // Every call that NAMES definitions, with the span of the id string inside it.
  function idCalls(code) {
    const isCode = codeOnly(code);
    const re = new RegExp(`\\b${useCall}\\s*\\(`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!isCode(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      if (close < 0 || !isIdCall(code.slice(open + 1, close))) continue;
      const range = idStringRange({ open, close }, code);
      if (!range) continue;
      const call = { start: m.index, open, close, from: range[0], to: range[1], str: code.slice(range[0], range[1]) };
      call.scope = scopeOfCall(code, call);
      out.push(call);
    }
    return out;
  }

  /**
   * The calls that name `id` - the patterns that play it. Scoped kinds only count the calls aimed
   * at the same owner: renaming ValhallaDelay's `disco` must not rewrite a Serum track's
   * `.preset("disco")`, which names a different preset that merely spells the same.
   */
  function refCalls(code, id, sc = null) {
    const word = idWordRe(id, '');
    return idCalls(code).filter((call) => word.test(call.str) && sameScope(call.scope, sc));
  }

  // Groups the buffer's definitions into the runs that fold together. A definition joins a run
  // when it stands alone as a statement and nothing but blank space, a `;` or a comment separates
  // it from the one before. Two things drop out of runs entirely:
  //   - a definition that CHAINS (`lead: roll(0, "…").synth("Serum 2")`) - _clone() drops the
  //     marker, so that one is a playing track and its code is code to read
  //   - one that isn't the start of its own statement (`const a = roll(…)`), where folding from
  //     the callee would leave a dangling `const a =`
  function runs(code) {
    const isCode = codeOnly(code);
    const out = [];
    let prevEnd = -1;
    for (const def of defsInBuffer(code)) {
      const after = code.slice(def.close + 1);
      const head = code.slice(code.lastIndexOf('\n', def.start - 1) + 1, def.start);
      const standalone = /^\s*$/.test(head) || /^\s*[A-Za-z_$][\w$]*\s*:\s*$/.test(head);
      if (!standalone || /^\s*[.[(]/.test(after)) { prevEnd = -1; continue; }
      // Only filler may sit between two definitions of the same run - and a comment there is
      // filler whatever it says, so the mask decides which characters have to be blank.
      const gap = prevEnd < 0 ? null : code.slice(prevEnd, def.start);
      const joins = gap !== null && [...gap].every((ch, i) => isCode(prevEnd + i) === false || /[\s;]/.test(ch));
      if (joins) out[out.length - 1].push(def);
      else out.push([def]);
      prevEnd = def.close + 1;
    }
    return out;
  }

  // Where a new definition goes: appended to the buffer's first run of them, or - when the buffer
  // has no run yet - a fresh one at the END. Returns the edit as [from, to, text] against `code`.
  //
  // The end rather than the top, because of line numbers. A run is hidden by default, and
  // CodeMirror draws a collapsed multi-line mark as ONE visual line - so a block of five
  // definitions at the top of the buffer numbered the player's first real line 6. Below their
  // code, the same merge happens where nothing is counting. Nothing else minds the move:
  // resolution is lazy (see rollPattern in signal.mjs), so a definition reads the same either side
  // of the pattern that names it. An older patch's block is brought down by sinkDefRuns.
  //
  // Deliberately NOT under a `rolls:` label. A label is a track NAME - it would collide with one
  // the player might reasonably want, and, being the first label in the buffer, it was what named
  // the window and the entry in the files list (see deriveLabel). Bare statements evaluate exactly
  // as well: the definition Sig carries `isDef`, which is what keeps a definitions block from being
  // taken for a track, and that has never depended on the label.
  // `ids` are bare names, or - for a scoped kind - { id, scope } so a new definition is written
  // already owned by the plugin that will play it, rather than as an ownerless placeholder two
  // different plugins could each end up claiming.
  function defsEdit(code, ids, bodyFor = null) {
    const lines = ids.map((entry) => {
      const id = typeof entry === 'string' ? entry : entry.id;
      const body = bodyFor ? bodyFor(id) : scopedBody(typeof entry === 'string' ? '' : entry.scope ?? '');
      return `${defCall}(${JSON.stringify(id)}, ${body})`;
    });
    const found = runs(code);
    if (found.length) {
      const at = found[0][found[0].length - 1].close + 1;
      return [at, at, `\n${lines.join('\n')}`];
    }
    // The first of ITS kind, but not necessarily the first definition down there: another kind's
    // block is already the bottom of the buffer, and the two stack up flush. Each folds to its own
    // chip, so they read as two lines either way - and a blank line between them would only be a
    // hole in the code, kept alive by every pass that puts the block back together.
    const below = lastDefRunEnd(code);
    if (below !== null) return [below, below, `\n${lines.join('\n')}`];
    // A blank line between the player's code and the block, without stacking up another one each
    // time a buffer that already ends in one gets its first definition.
    const gap = code.trim() ? '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(code)[0].length)) : '';
    return [code.length, code.length, `${gap}${lines.join('\n')}`];
  }

  /**
   * Every id the editor knows: this buffer's definitions, then the shared library. `sc` narrows a
   * scoped kind to one owner, which is what the preset picker lists - offering a slot the presets
   * of some other plugin would only ever be offering it names it can't load.
   */
  function allIds(sc = null) {
    const own = defsInBuffer().map((d) => ({ id: d.id, scope: d.scope, note: '', own: true }));
    const rows = [
      ...own,
      ...library()
        .filter((e) => !own.some((o) => o.id === libId(e) && sameScope(o.scope, libScope(e))))
        .map((e) => ({ id: libId(e), scope: libScope(e), note: libraryNote, own: false })),
    ];
    return sc === null ? rows : rows.filter((r) => sameScope(r.scope, sc));
  }

  /** Gives every un-named and un-defined one in the buffer a definition. True if it wrote. */
  function materialize() {
    if (isData('') === null || !labelsMod) return false; // can't yet tell a name from data
    const code = cm.getValue();
    // { id, scope } rather than a flat set of names: for a scoped kind the same name is free again
    // under a different plugin, and the definition written for it records which one it belongs to.
    // Kept apart from the buffer's own names so a bump can say WHICH kind of collision it was: one
    // the person can see on screen, or one from outside the buffer that needs explaining.
    const libTaken = library().map((e) => ({ id: libId(e), scope: libScope(e) }));
    const taken = [
      ...defsInBuffer(code).map((d) => ({ id: d.id, scope: d.scope })),
      ...libTaken,
    ];
    const isTaken = (id, sc) => taken.some((t) => t.id === id && sameScope(t.scope, sc));
    const inLibrary = (id, sc) => libTaken.some((t) => t.id === id && sameScope(t.scope, sc));
    const claim = (id, sc) => { taken.push({ id, scope: sc }); };
    const created = []; // in the order they were first named, which is the order they are written
    const rewrites = []; // [from, to, text] against `code`, applied last-first so offsets hold

    const isCode = codeOnly(code);
    const bare = new RegExp(`\\b${useCall}\\s*\\(\\s*\\)`, 'g');
    let m;
    while ((m = bare.exec(code)) !== null) {
      if (!isCode(m.index)) continue;
      const sc = scopeOfCall(code, { start: m.index });
      const label = prBlockLabelAt(m.index);
      const id = freshDefId(label, (name) => isTaken(name, sc), kind);
      const wanted = preferredDefId(label, kind);
      if (inLibrary(wanted, sc)) libraryBumpNote(kind, wanted, id, libraryNote);
      claim(id, sc);
      created.push({ id, scope: sc });
      rewrites.push([m.index, m.index + m[0].length, `${useCall}(${JSON.stringify(id)})`]);
    }
    for (const call of idCalls(code)) {
      for (const id of idsNamedIn(call.str)) {
        if (isTaken(id, call.scope)) continue;
        claim(id, call.scope);
        created.push({ id, scope: call.scope });
      }
    }
    if (!created.length) return false;

    cm.operation(() => {
      for (let i = rewrites.length - 1; i >= 0; i--) {
        const [from, to, text] = rewrites[i];
        cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to));
      }
      // Computed after the rewrites, since an inserted id moves everything below it along.
      const [from, to, text] = defsEdit(cm.getValue(), created);
      cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to));
    });
    refoldAll(); // the new block starts life hidden, like every other one
    say(`new ${kind}${created.length === 1 ? '' : 's'}: ${created.map((c) => c.id).join(', ')}`);
    return true;
  }

  // Making one from the panel's search box. A new one is empty and named only - nothing plays it
  // until a pattern says its name, which is the point: you draw the variation first and swap it in
  // when you are ready.
  function create(id, sc = panelScope()) {
    const code = cm.getValue();
    if (!id || DEF_ID_BAD.test(id)) {
      return say(`can't create a ${kind} called "${id}": a name has to be one plain word`, true);
    }
    if (findDef(code, id, sc) || inLibrary(id, sc)) {
      panel.open(id, panel.carry()); // it already exists - showing it is what was meant anyway
      return;
    }
    const [from, to, text] = defsEdit(code, [{ id, scope: sc ?? '' }]);
    cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to));
    refoldAll();
    say(`new ${kind}: ${id}`);
    panel.open(id, panel.carry());
    panel.scheduleEval();
  }

  // Throwing one away from the picker. Refused while a pattern still names it - not out of
  // caution, but because it wouldn't work: a name a pattern uses and nothing defines is given a
  // fresh empty definition on the next evaluation (see materialize), so it would come straight
  // back with its data gone. Take it out of the patterns first and the delete goes through.
  function remove(id, sc = panelScope()) {
    const code = cm.getValue();
    const def = findDef(code, id, sc);
    const refuse = (why) => say(`can't delete ${kind} "${id}": ${why}`, true);
    if (!def) {
      return refuse(inLibrary(id, sc)
        ? "it isn't defined in this buffer - it comes from the shared library"
        : 'there is no definition for it in this buffer');
    }
    const refs = refCalls(code, id, def.scope);
    if (refs.length) {
      return refuse(`${refs.length} pattern${refs.length === 1 ? '' : 's'} still play${refs.length === 1 ? 's' : ''} it `
        + '- take the name out of them first, or it will be re-created empty on the next evaluation');
    }
    const [from, to] = removalRange(code, def);
    const wasOpen = panel.current() === id;
    cm.replaceRange('', cm.posFromIndex(from), cm.posFromIndex(to));
    refoldAll();
    say(`deleted ${kind} "${id}"`);
    panel.scheduleEval();
    // The panel was showing the one that just went: put another up rather than closing, since
    // deleting from the picker is usually one of several tidying gestures.
    if (wasOpen) {
      const next = defsInBuffer().find((d) => d.id !== id && sameScope(d.scope, def.scope));
      if (next) panel.open(next.id, panel.carry());
      else panel.close();
    }
  }

  /**
   * The span taking one definition out of the buffer covers: its own line, or - when it is the last
   * of its run - the whole run, which is the same span the fold hides (otherwise deleting the only
   * one leaves the block's blank line behind). Also what a conversion uses, which takes a
   * definition out having rewritten the patterns that named it.
   */
  function removalRange(code, def) {
    const run = runs(code).find((r) => r.some((d) => d.id === def.id));
    return run && run.length === 1 ? runLineRange(code, run) : defLineRange(code, def);
  }

  // Renaming from the panel, which is the only place one of these HAS a visible name. The
  // definition and every pattern that names it move together - a rename that left a pattern
  // pointing at nothing would silently swap the part for silence. Unless it is SHARED and you are
  // looking at it through one of the patterns playing it, which asks for something else: see fork.
  function rename(from, to, sc = panelScope()) {
    const code = cm.getValue();
    const refuse = (why) => { say(`can't rename ${kind} "${from}" to "${to}": ${why}`, true); panel.syncHead(); };
    if (!to || DEF_ID_BAD.test(to)) return refuse('a name has to be one plain word');
    const def = findDef(code, from, sc);
    if (!def) return refuse('its definition is not in this buffer');
    // Taken WITHIN this one's own scope. The same name under another plugin is another preset
    // entirely and no obstacle - which is the whole point of scoping them.
    if (findDef(code, to, def.scope) || inLibrary(to, def.scope)) {
      return refuse(scope && def.scope ? `that name is taken for ${def.scope}` : 'that name is taken');
    }

    const refs = refCalls(code, from, def.scope);
    const here = panel.sourceCall(refs);
    if (here && refs.length > 1) return fork(code, def, from, to, here, refs.length - 1);

    const [litStart, litEnd] = defIdLiteralRange(code, def);
    const edits = [[litStart, litEnd, JSON.stringify(to)]];
    for (const call of refs) edits.push(...idOccurrenceEdits(call, from, to));
    applyEdits(edits);
    panel.setCurrent(from, to);
    refoldAll();
    panel.syncHead();
    panel.scheduleEval();
    say(`renamed ${kind} "${from}" to "${to}"${refs.length ? ` (${refs.length} pattern(s) updated)` : ''}`);
  }

  // Two patterns playing one of these, renamed from inside one of them. Renaming both is the move
  // you can't take back by hand: the other pattern's part loses the name you knew it by, and
  // nothing called `lead` exists any more. So the pattern you renamed FROM gets one of its own - a
  // copy under the new name, pointed at from that call and nowhere else - and every other pattern
  // goes on playing `lead` exactly as before. The two are identical the moment they split and
  // diverge from there, which is the only thing "unlink" can mean for drawn data.
  //
  // Opened straight from the picker there is no `source` call, so there is nothing to unlink it
  // from and a rename there stays a plain rename.
  function fork(code, def, from, to, call, others) {
    const [litStart, litEnd] = defIdLiteralRange(code, def);
    const text = code.slice(def.start, def.close + 1);
    const copy = text.slice(0, litStart - def.start) + JSON.stringify(to) + text.slice(litEnd - def.start);
    const lineStart = code.lastIndexOf('\n', def.start - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart, def.start))[0];

    // The quotes are never part of an edit, so a mark that takes them IN survives having the whole
    // string body replaced - which is what renaming a one-name call does - and comes back sitting
    // over the new name, ready to go on being followed.
    const quoted = cm.markText(cm.posFromIndex(call.from - 1), cm.posFromIndex(call.to + 1), {});
    const view = panel.carry();
    const oldSource = view?.source ?? null;
    applyEdits([[def.close + 1, def.close + 1, `\n${indent}${copy}`], ...idOccurrenceEdits(call, from, to)]);
    const span = quoted.find();
    quoted.clear();
    oldSource?.clear();
    if (view) {
      view.source = span
        ? cm.markText({ line: span.from.line, ch: span.from.ch + 1 }, { line: span.to.line, ch: span.to.ch - 1 }, {})
        : null;
    }
    refoldAll();
    panel.open(to, view); // the same data stays on screen, now under the name just given it
    panel.scheduleEval();
    say(
      `${kind} "${to}" is this pattern's own copy of "${from}" - ${others} other pattern${others === 1 ? '' : 's'} `
        + `still play${others === 1 ? 's' : ''} "${from}", which is unchanged`
    );
  }

  // A copy of one under a new name, from the panel's `dup` button: the same data, under the next
  // free spelling of its name (`lead` -> `lead2`), opened in place of the original so the next
  // stroke lands in the copy. Nothing plays it until a pattern names it - which is the point: a
  // variation is drawn on top of what is playing and swapped in when it is ready, the same way a
  // new one is (see create), only without starting from nothing.
  function duplicate(id = panel.current(), sc = panelScope()) {
    if (id == null) return;
    const code = cm.getValue();
    const def = findDef(code, id, sc);
    if (!def) {
      return say(`can't duplicate ${kind} "${id}": ${inLibrary(id, sc) ? 'it comes from the shared library - only what this buffer defines can be copied here' : 'its definition is not in this buffer'}`, true);
    }
    const rows = allIds(def.scope ?? null);
    // Counted from the stem, not the name: duplicating `snare2` gives `snare3`, not `snare22` -
    // a copy of a copy is the next one in the series, which is how you think of them.
    const stem = id.replace(/\d+$/, '') || id;
    const to = freshDefId(stem, (name) => rows.some((r) => r.id === name), kind);
    const [litStart, litEnd] = defIdLiteralRange(code, def);
    const text = code.slice(def.start, def.close + 1);
    const copy = text.slice(0, litStart - def.start) + JSON.stringify(to) + text.slice(litEnd - def.start);
    const lineStart = code.lastIndexOf('\n', def.start - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart, def.start))[0];
    applyEdits([[def.close + 1, def.close + 1, `\n${indent}${copy}`]]);
    refoldAll();
    say(`${kind} "${to}" is a copy of "${id}"`);
    panel.open(to, panel.carry());
    panel.scheduleEval();
  }

  return { kind, section, defCall, useCall, legacyCall, isIdString, isIdCall, defsInBuffer, findDef, idCalls, refCalls, runs, removalRange, defsEdit, allIds, materialize, create, remove, rename, duplicate };
}



// The definition builders were once plain roll(...) and shape(...); they are _roll/_shape now, so
// those words stay free for whatever they should mean to a person later. A patch saved before that
// still says the old ones, and they are no longer bound - so rewrite them the first time it is
// evaluated, which is the only moment it matters. Only calls that actually look like DEFINITIONS
// (a literal id first) are touched, so someone's own `const roll = …` is left alone.
function migrateDefNames() {
  // Five passes, each reading what the last wrote: runs() looks for the private names, so the
  // labels above them can only be found once the calls have been renamed - the indentation those
  // labels left behind can only be squared up once they are gone - and only then is the block in
  // the shape sinkDefRuns will agree to move, which is what leaves the runs adjacent enough for
  // the last pass to close the gaps between them.
  const renamed = renameLegacyDefCalls();
  const labels = legacyLabelLines(cm.getValue());
  if (labels.length) applyEdits(labels.map(([from, to]) => [from, to, '']));
  const dedented = dedentDefRuns();
  const sunk = sinkDefRuns();
  const tightened = tightenDefRuns();
  if (!renamed && !labels.length && !dedented && !sunk && !tightened) return;
  refoldAll();
  const parts = [];
  if (renamed) parts.push(`${renamed} definition${renamed === 1 ? '' : 's'} renamed to the editor's private form`);
  if (labels.length) parts.push(`${labels.length} leftover label${labels.length === 1 ? '' : 's'} removed`);
  if (dedented) parts.push(`${dedented} definition${dedented === 1 ? '' : 's'} un-indented`);
  if (sunk) parts.push(`${sunk} definition${sunk === 1 ? '' : 's'} moved below the code, so the line numbers read straight`);
  if (tightened) parts.push(`${tightened} blank line${tightened === 1 ? '' : 's'} between definition blocks closed up`);
  logLine(`tidied the definitions block: ${parts.join(', ')}`);
}

// Pass three: definitions written under a `rolls:`/`shapes:` label were indented to sit beneath it.
// The label is gone (pass two, or an earlier session), but its indentation stayed - so a buffer can
// hold two-space `_roll`/`_shape` definitions next to flush-left `_preset` ones - visible now that
// the runs are chipped rather than hidden. Returns how many lines were squared up.
//
// Only TOP-LEVEL runs are touched. A definition indented inside a function body is indented on
// purpose, and while re-indenting it would cost nothing but looks, code the editor did not write is
// not code the editor should reformat.
function dedentDefRuns() {
  const code = cm.getValue();
  const isCode = codeOnly(code);
  const edits = [];
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      if (!atTopLevel(code, isCode, run[0].start)) continue;
      for (const def of run) {
        const lineStart = code.lastIndexOf('\n', def.start - 1) + 1;
        const indent = code.slice(lineStart, def.start);
        // runs() already guarantees nothing but blank space precedes a definition on its line.
        if (indent) edits.push([lineStart, def.start, '']);
      }
    }
  }
  if (edits.length) applyEdits(edits);
  return edits.length;
}

// Definitions used to be written at the TOP of the buffer. A run is hidden by default, and
// CodeMirror draws a collapsed multi-line mark as ONE visual line - so a block up there made the
// player's first real line read as line 6. New ones are written at the end now (see defsEdit);
// this brings an older patch's block down to join them, once, the first time it is evaluated.
//
// Nothing about playback minds: resolution is lazy (see rollPattern in signal.mjs), so a
// definition reads the same either side of the pattern that names it.
function sinkDefRuns() {
  const code = cm.getValue();
  const isCode = codeOnly(code);
  const found = [];
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      // A run nested in a function body is scoped to it - hoisting that one to the bottom would
      // move it out of the scope it was written in, so one of those stops the whole pass.
      if (!atTopLevel(code, isCode, run[0].start)) return 0;
      found.push({ run, span: runLineRange(code, run) });
    }
  }
  if (!found.length) return 0;
  found.sort((a, b) => a.span[0] - b.span[0]);
  // Whole lines only. runs() already refuses a definition sharing the start of its line, but a run
  // whose last line carries code after the closing paren would strand that code - so leave it.
  const partial = ([a, b]) => (a > 0 && code[a - 1] !== '\n') || (b < code.length && code[b - 1] !== '\n');
  if (found.some((f) => partial(f.span))) return 0;
  // Already at the bottom: nothing but blank space follows the last block.
  if (!code.slice(found[found.length - 1].span[1]).trim()) return 0;
  // Each span carries the newline (and any blank lines) that followed it, which is what separates
  // them once they are stacked up - squeezed to the single newline that puts the next block on the
  // next line, since blocks brought down from anywhere in the buffer land as one block. The last
  // one loses its newline entirely: an empty line at the bottom of the buffer looks like a mistake.
  const block = found
    .map((f) => code.slice(...f.span).replace(/\n+$/, '\n'))
    .join('')
    .replace(/\n+$/, '');
  const gap = '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(code)[0].length));
  applyEdits([...found.map((f) => [...f.span, '']), [code.length, code.length, `${gap}${block}`]]);
  return found.reduce((n, f) => n + f.run.length, 0);
}

// Where the definitions block BEGINS - the start of the line its first run opens on, which is the
// offset new CODE is written in front of so the block stays the bottom of the buffer.
//
// Null unless the runs really are the bottom: everything from that line down has to be definitions
// and blank space. An older patch keeps its block at the TOP until the first evaluation sinks it
// (see sinkDefRuns), and new lanes belong under that code, not above it. Nested runs don't count,
// for the same reason as lastDefRunEnd below.
function firstDefRunStart(code) {
  const isCode = codeOnly(code);
  const spans = [];
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      if (!atTopLevel(code, isCode, run[0].start)) continue;
      spans.push([code.lastIndexOf('\n', run[0].start - 1) + 1, run[run.length - 1].close + 1]);
    }
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let end = spans[0][0];
  for (const [from, to] of spans) {
    if (code.slice(end, from).trim()) return null; // ordinary code in among the runs
    end = Math.max(end, to);
  }
  return code.slice(end).trim() ? null : spans[0][0];
}

// Where the last definition in the buffer ends, whatever kind it is - the offset a brand-new kind
// of block is appended at, so all of them stack up as one. Null when the buffer holds no run at
// all, and a run nested in a function body doesn't count: it is scoped to that body, and appending
// to it would write a definition into a scope the buffer can't see.
function lastDefRunEnd(code) {
  const isCode = codeOnly(code);
  let end = null;
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      if (!atTopLevel(code, isCode, run[0].start)) continue;
      const at = run[run.length - 1].close + 1;
      if (end === null || at > end) end = at;
    }
  }
  return end;
}

// Pass five: the blank lines an older patch has between one definition block and the next - two
// kinds first written at different times, or blocks a hand-edit pulled apart. Each block folds to
// one chip, and a gap between two chips at the bottom of the buffer reads as a hole in the code
// rather than as structure, so they are squeezed onto consecutive lines. Only the space BETWEEN
// two runs is touched: the blank line that separates the whole block from the player's code is
// what tells them apart, and it is above the first run.
function tightenDefRuns() {
  const code = cm.getValue();
  const isCode = codeOnly(code);
  const spans = [];
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      if (!atTopLevel(code, isCode, run[0].start)) continue;
      spans.push([run[0].start, run[run.length - 1].close + 1]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const edits = [];
  for (let i = 1; i < spans.length; i++) {
    const [from, to] = [spans[i - 1][1], spans[i][0]];
    const gap = code.slice(from, to);
    // Whitespace and a stray `;` only - a comment between two blocks is someone's note about the
    // one below it, and closing that gap would strand it against the block above.
    if (gap !== '\n' && /^[ \t;]*\n\s*$/.test(gap)) edits.push([from, to, '\n']);
  }
  if (edits.length) applyEdits(edits);
  return edits.length;
}

/** Is `at` outside every bracket - i.e. a statement of the buffer itself rather than of some block? */
function atTopLevel(code, isCode, at) {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (!isCode(i)) continue; // brackets inside strings and comments nest nothing
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  return depth <= 0;
}

// Pass one: roll(...) / shape(...) -> _roll(...) / _shape(...). Only calls that actually look like
// DEFINITIONS (a literal id first) are touched, so someone's own `const roll = …` is left alone.
// Returns how many were rewritten.
function renameLegacyDefCalls() {
  const code = cm.getValue();
  const isCode = codeOnly(code);
  const edits = [];
  for (const reg of DEF_REGISTRIES) {
    // Only a kind that WAS public has anything to rename. Dropping the underscore off every
    // defCall would make `_preset` claim `preset(` - which is a real, current call - and rewrite
    // every .preset("<a b>") in the buffer into ._preset("<a b>").
    if (!reg.legacyCall) continue;
    const re = new RegExp(`\\b${reg.legacyCall}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!isCode(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      if (close < 0) continue;
      const [idLiteral] = splitFirstArg(code.slice(open + 1, close));
      if (idLiteralValue(idLiteral) == null) continue;
      edits.push([m.index, m.index, '_']);
    }
  }
  if (edits.length) applyEdits(edits);
  return edits.length;
}

// The `rolls:` / `shapes:` lines that label nothing but a run of definitions, as [from, to) spans
// including the newline. Only those exact words, and only alone on their line directly above a run:
// a real track called `rolls` has an expression after the colon, and is left alone.
function legacyLabelLines(code) {
  const out = [];
  for (const reg of DEF_REGISTRIES) {
    for (const run of reg.runs(code)) {
      const lineStart = code.lastIndexOf('\n', run[0].start - 1) + 1;
      if (lineStart === 0) continue;
      const prevStart = code.lastIndexOf('\n', lineStart - 2) + 1;
      if (!/^\s*(?:rolls|shapes)\s*:\s*$/.test(code.slice(prevStart, lineStart - 1))) continue;
      out.push([prevStart, lineStart]);
    }
  }
  return out;
}

// The head: the shape's name and the find-or-create popover behind it. rate and mode go with it
// when a definition is open - they are the calling lfo()'s, not the shape's, and showing them here
// would invite editing something this panel isn't looking at.
const lfoHead = makeNamePicker({
  els: { wrap: lfoPickWrap, title: lfoTitle, name: lfoName, btn: lfoPickBtn, picker: lfoPickBox, search: lfoSearch, list: lfoPickList },
  reg: shapeDefs,
  current: () => lfoState?.shapeId ?? null,
  // Carried, so browsing the list doesn't lose the call the panel came from - see lfoCarry.
  open: (id) => openShapeById(id, lfoCarry()),
  canUse: () => !!lfoState?.callSource?.find(),
  use: (id) => lfoUseInCall(id),
  refocus: () => lfoCanvas.focus({ preventScroll: true }),
  onPick: () => lfoSetFollowLock(true), // reaching in here says you want THAT one, not the next bar's
});

function lfoSyncHead() {
  const named = !!lfoState?.shapeId;
  // rate and mode belong to the lfo() CALL. An inline one is the call; a definition has them only
  // while the panel still knows which call it was opened through.
  const editable = !named || !!lfoState?.callSource?.find();
  lfoRateWrap.classList.toggle('hidden', !editable);
  lfoModeWrap.classList.toggle('hidden', !editable);
  // The → is offered only when it would change something: there is a call behind the panel, and it
  // isn't already playing what you are looking at. A call that names several (`lfo("<a b>")`) is
  // never "already" it - sending collapses the pattern onto this one, which is a real edit.
  const plays = named && editable ? lfoSourceShapeId() : lfoState?.shapeId;
  lfoUseBtn.classList.toggle('hidden', plays === lfoState?.shapeId);
  lfoUseBtn.title = `play "${lfoState?.shapeId}" in the lfo() this panel came from`
    + (plays == null ? '' : ` (it plays "${plays}" now)`);
  // The lock, like the roll's, only appears when there is something to follow: a shape opened
  // straight from the picker follows nothing, and an inline lfo() is the whole of its own pattern.
  lfoLockBtn.classList.toggle('hidden', !(named && editable));
  lfoLockBtn.textContent = lfoFollowLocked ? '🔒' : '🔓';
  lfoLockBtn.classList.toggle('active', lfoFollowLocked);
  lfoLockBtn.title = lfoFollowLocked ? 'pinned to this shape' : 'following the playing shape';
  lfoRateUnit.textContent = lfoState?.rateHz ? 'hz' : 'cyc';
  lfoRateUnit.title = lfoState?.rateHz ? 'free-running — click for cycles' : 'synced to the cycle — click for hz';
  lfoHead.syncHead(named ? shapeDefs.refCalls(cm.getValue(), lfoState.shapeId).length : 0);
}



// Frame the pitch window so the drawn notes sit centered; default to PR_DEFAULT_TOP for an empty
// roll. Works in lane coordinates, so it frames a folded roll just as well; prMetrics clamps the
// result to the ends of the axis.
function prFramePitch() {
  const m = prMetrics();
  const notes = prLiveNotes(prState.notes);
  if (!notes.length) {
    prState.pitchTop = prIndexMode() ? PR_INDEX_TOP : prPosOf(PR_DEFAULT_TOP, m);
    return;
  }
  const positions = notes.map((nt) => prPosOf(prRowOf(nt), m));
  const center = Math.round((Math.min(...positions) + Math.max(...positions)) / 2);
  prState.pitchTop = center + Math.floor(PR_ROWS / 2);
}

/**
 * Live's box slider: a control that READS as a value box and WORKS as a slider. Drag it sideways
 * and a fill sweeps behind the number, so the amount is legible at a glance without a track and a
 * handle eating a whole row of a 92px column. The drag is relative (it picks up from where the
 * value already was, rather than jumping to wherever the box was grabbed), shift makes it fine, and
 * double-click puts it back to `home`.
 *
 * `center: true` grows the fill from the value's zero instead of from the left edge, which is what a
 * bipolar control needs - on swing, which side of straight you are on is half the reading.
 *
 * onInput fires all the way THROUGH a drag - that's the point of the thing, a value you hear your
 * way to - and onCommit once at the end of one, for whatever is too expensive to do per frame.
 * Returns { get, set }, where set is silent: it's how the panel syncs the widget from state.
 */
function prMakeBoxSlider(el, { min, max, step, home = 0, center = false, fmt, onInput, onCommit }) {
  const fill = el.querySelector('.pr-box-fill');
  const label = el.querySelector('.pr-box-val');
  // Step-quantized, then trimmed: 0.1 + 0.2 arithmetic would otherwise reach the serializer.
  const quant = (v) => Number((Math.round(Math.min(max, Math.max(min, v)) / step) * step).toFixed(6));
  let value = quant(home);

  const paint = () => {
    label.textContent = fmt(value);
    const u = (value - min) / (max - min); // where the value sits across the box, 0..1
    const base = center ? (0 - min) / (max - min) : 0; // ...and where its fill grows from
    fill.style.left = `${Math.min(u, base) * 100}%`;
    fill.style.width = `${Math.abs(u - base) * 100}%`;
    el.setAttribute('aria-valuenow', String(value));
  };

  const set = (v) => { value = quant(v); paint(); };
  // Reports whether the value actually moved, so a gesture that changed nothing - a plain click, an
  // arrow held against an end stop - doesn't commit, and so doesn't cost the buffer a re-eval.
  const apply = (v) => {
    const next = quant(v);
    if (next === value) return false;
    value = next;
    paint();
    onInput?.(value);
    return true;
  };
  paint();

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no text selection, and the panel's own click-outside never sees it
    el.setPointerCapture(e.pointerId);
    el.focus();
    const x0 = e.clientX;
    const v0 = value;
    let moved = false;
    const onMove = (ev) => {
      moved = apply(v0 + ((ev.clientX - x0) / PR_BOX_SWEEP_PX) * (max - min) * (ev.shiftKey ? 0.1 : 1)) || moved;
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moved) onCommit?.(value);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });

  el.addEventListener('dblclick', () => { if (apply(home)) onCommit?.(value); });

  el.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation(); // the arrows are this control's while it has focus, not the roll's
    if (apply(value + dir * step * (e.shiftKey ? 10 : 1))) onCommit?.(value);
  });

  // No onCommit here: a trackpad fires these in bursts, and the live path already lands the final
  // value a coalescing window later.
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    apply(value - Math.sign(e.deltaY) * step * (e.shiftKey ? 1 : 5));
  }, { passive: false });

  return { get: () => value, set };
}

let prSwingSlider = null; // the swing box slider, built once the panel's controls are wired

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
  prSwingSlider?.set(prState.swing ?? 0);
  // The division swing acts on. The blank first option is "whatever the roll's grid is", which is
  // the default and what most rolls want - a stated resolution, swung.
  prSwingGridSelect.innerHTML = '';
  prSwingGridSelect.add(new Option('grid', ''));
  for (const [label, n] of opts) prSwingGridSelect.add(new Option(label, String(n)));
  prSwingGridSelect.value = prState.swinggrid ? String(prState.swinggrid) : '';
  // Nothing to commit on a straight roll, and saying so with the button is better than letting it
  // look like it did something.
  prCommitSwingBtn.disabled = !prState.swing;
}

function openPianorollEditor(call, carry = null) {
  const wasOpen = !!prState; // a fresh open refreshes the roll list; a follow-switch must not
  if (!wasOpen) prCmdMode = 'vel'; // every fresh open starts on velocity (see prCmdMode)
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const inner = cm.getValue().slice(call.open + 1, call.close);
  if (prState?.marker) prState.marker.clear();
  // A roll(...) definition is a pianoroll() call with an id in front of it - drop the id and the
  // rest parses identically.
  const { notes, grid, len, start, mode, swing, swinggrid } = parsePianorollCall(call.idLiteral ? splitFirstArg(inner)[1] : inner);
  prState = {
    marker: cm.markText(from, to, {}),
    callStart: call.start,
    notes,
    grid, // granularity: cells per cycle (the *grid multiplier)
    len, // loop length in cells (grid-th notes)
    start, // where the loop window opens, in cells - drag either end of the loop bar to move it
    // What the vertical axis MEANS: 'note' (a piano keyboard, MIDI pitches) or 'index' (a plain
    // 0,1,2… list of a sample pack's files). Per ROLL - it is written into the call - rather than
    // sticky like the tool, because it is a fact about this roll's data, not a way of working.
    mode,
    // The roll's own groove: how far its offbeats are delayed, and which division counts as an
    // offbeat (null = the roll's own grid). Played as the ordinary swing channel (see the builder),
    // and the commit button turns it into per-note nudges without changing a thing that sounds.
    swing,
    swinggrid,
    pitchTop: PR_DEFAULT_TOP, // replaced by prFramePitch below, which needs prState to exist
    fold: prFold, // Live's Fold: only the rows something is drawn on (either axis)
    scaleFold: prScaleFold, // ...and only the key's rows, on the note axis (both sticky, like the tool)
    zoom: 1, // 1 = the whole rendered width fits; >1 zooms in horizontally with a scroll offset
    scrollCells: 0, // leftmost visible cell when zoomed in
    sel: new Set(), // currently selected note objects (transient; mutated in place, never reserialized)
    history: [], // undo snapshots, oldest first (see prPushHistory); seeded with the opening state
    histIdx: -1,
    trackLabel: prBlockLabelAt(call.start),
    // Set when this is a roll(...) definition: the id it is filed under, and the exact literal to
    // write back. Null for an inline pianoroll(...), which is the whole of its own pattern.
    rollId: call.id ?? null,
    idLiteral: call.idLiteral ?? null,
    // A marker over the id string of the pianoroll("<0 chorus>") this was opened from, so the
    // panel can keep asking which roll is sounding. Null when a definition was opened directly.
    source: carry?.source ?? null,
  };
  prPushHistory(); // the state the roll opened in - what the first cmd-Z comes back to
  prFramePitch();
  // Following the pattern from one roll to the next must not throw the view away: the notes are
  // different but you are still reading the same part, at the same zoom, in the same register.
  // Only a follow-switch carries a view, though - a first open keeps the frame prFramePitch just
  // put around this roll's own notes.
  if (carry?.pitchTop != null) {
    prState.pitchTop = carry.pitchTop;
    prState.zoom = carry.zoom;
    prState.scrollCells = carry.scrollCells;
  }
  prSyncGridLenInputs();
  prSyncMode();
  prSyncRollHead();
  prSyncLaneChannel();
  if (call.id && !wasOpen) prRefreshRollList(); // the prebake half of the picker, asked for once
  prPanel.classList.remove('hidden');
  prSizeCanvas(); // the width the layout gives it now, so the first frame is already right
  drawPianoroll();
  if (!prRaf) prRaf = requestAnimationFrame(prPlayheadLoop); // sweep a playhead while it plays
  // Focus isn't taken here - openWidgetAt hands it to the canvas, because the double-click that
  // got us here says the notes are what the keyboard is for now.
}

// ---------------------------------------------------------------------------------------------
// Named rolls in the panel: which one is on screen, and how it follows the pattern.
//
// A pianoroll("<0 chorus>") holds no notes - they are in the roll(...) definitions - so the panel
// opens a DEFINITION and remembers the call it came from. From there it follows whatever that call
// is playing, bar by bar, unless the lock is on. The picker opens one on purpose, and doing that
// pins it: choosing a roll by hand is a decision to look at that one.
// ---------------------------------------------------------------------------------------------

/** What a follow-switch has to carry over: the same view, and the call still being followed. */
function prCarry() {
  return prState
    ? { source: prState.source, pitchTop: prState.pitchTop, zoom: prState.zoom, scrollCells: prState.scrollCells }
    : null;
}

/** Puts roll `id`'s definition under the editor. False (and a line) if this buffer hasn't got one. */
function openRollById(id, carry = null) {
  const def = rollDefs.defsInBuffer().find((d) => d.id === String(id));
  if (!def) {
    const known = prPrebakeRolls.includes(String(id));
    logLine(
      known
        ? `roll "${id}" is defined in prebake.js - open it there to edit its notes`
        : `no roll(${JSON.stringify(String(id))}, …) in this buffer to open`,
      true
    );
    return false;
  }
  openPianorollEditor(def, carry);
  return true;
}

// Double-clicked the name of a pianoroll("<0 chorus>"): open whichever roll is sounding right now,
// or the first id named when nothing is playing, and follow the call from there.
function openRollFromIdCall(call, code) {
  const range = idStringRange(call, code);
  if (!range) return;
  const [from, to] = range;
  const id = activeIdIn(from, to) ?? (code.slice(from, to).match(/[\w$]+/) ?? [])[0];
  if (id == null) return;
  const source = cm.markText(cm.posFromIndex(from), cm.posFromIndex(to), {});
  // Just the source marker: no view to carry on a first open, so the roll frames its own notes.
  if (openRollById(id, { source })) {
    prCanvas.focus({ preventScroll: true });
  } else {
    source.clear();
  }
}

// The id sounding inside a document range, read off the playback highlighter's own lit spans - the
// same grid the scheduler plays, so a panel can never disagree with what you are hearing. Not
// roll-specific: rolls, presets and lfo shapes all name their definitions in a mini string, and all
// three ask this the same question about it.
function activeIdIn(from, to) {
  for (const r of patternRegions) {
    for (const [a, b] of r.litSpans ?? []) {
      if (a >= from && b <= to) return cm.getRange(cm.posFromIndex(a), cm.posFromIndex(b)).trim();
    }
  }
  return null;
}

// One frame's worth of following: swap the definition under the editor when the call it was opened
// from moves on to another roll. Locked, stopped, or already showing it - nothing to do.
function prFollowPlayingRoll() {
  if (prFollowLocked || !playing || !prState?.source) return;
  // Renaming or browsing is a conversation about ONE roll; swapping it out underneath would throw
  // the name away mid-word, or change what the list is a list of.
  if (document.activeElement === prName || !prPicker.classList.contains('hidden')) return;
  const range = prState.source.find();
  if (!range) return;
  const id = activeIdIn(cm.indexFromPos(range.from), cm.indexFromPos(range.to));
  if (id == null || id === prState.rollId) return;
  openRollById(id, prCarry());
}

function prSetFollowLock(locked) {
  prFollowLocked = !!locked;
  localStorage.setItem('poptartPianorollLock', prFollowLocked ? '1' : '0');
  prSyncRollHead();
}

// The head: the roll's name, the find-or-create popover behind it, and the follow lock. The lock
// only appears when there is something to follow - a definition opened directly isn't following
// anything, and an inline pianoroll() is the whole pattern.
// The piano roll's head. The lock is the one part that isn't shared - only a roll opened THROUGH a
// pattern has something to follow.
const rollPicker = makeNamePicker({
  els: { wrap: prPickWrap, title: prTitle, name: prName, btn: prPickBtn, picker: prPicker, search: prSearch, list: prPickList },
  reg: rollDefs,
  current: () => prState?.rollId ?? null,
  open: (id) => { if (!openRollById(id, prCarry())) prSyncRollHead(); }, // refused - say so, stay put
  canUse: () => !!prState?.source?.find(),
  use: (id) => prUseInCall(id),
  refocus: () => prRefocus(),
  onPick: () => prSetFollowLock(true), // reaching in here says you want THAT one, not the next bar's
});

// Puts `id` into the pianoroll(...) the panel is looking through, in place of whatever it names
// now - the roll's half of presetUseInCall: opening a row EDITS that roll, this plays it here. It is
// the gesture after ⧉: the copy is on screen, and the → on its row is how the call comes to play it
// instead of the original. The whole argument goes, pattern and all, which is why the line says
// what it replaced: it is one undo away, but only if you can see that it happened.
function prUseInCall(id) {
  const span = prState?.source?.find();
  if (!span) return;
  const was = cm.getRange(span.from, span.to);
  if (was === id) return;
  // A mark over just the string BODY collapses when the body is replaced wholesale, so take the
  // quotes in for the duration of the edit and put the inner mark back over the new name (see
  // presetUseInCall, and makeDefRegistry's fork).
  const quoted = cm.markText({ line: span.from.line, ch: span.from.ch - 1 }, { line: span.to.line, ch: span.to.ch + 1 }, {});
  cm.replaceRange(id, span.from, span.to);
  const after = quoted.find();
  quoted.clear();
  prState.source.clear();
  prState.source = after
    ? cm.markText({ line: after.from.line, ch: after.from.ch + 1 }, { line: after.to.line, ch: after.to.ch - 1 }, {})
    : null;
  refoldAll();
  logLine(`pianoroll("${was}") now plays "${id}"`);
  if (id !== prState.rollId) openRollById(id, prCarry());
  else prSyncRollHead();
  prScheduleEval();
}

function prSyncRollHead() {
  prLockBtn.classList.toggle('hidden', !prState?.source);
  prLockBtn.textContent = prFollowLocked ? '🔒' : '🔓';
  prLockBtn.classList.toggle('active', prFollowLocked);
  prLockBtn.title = prFollowLocked ? 'pinned to this roll' : 'following the playing roll';
  // Only a roll being watched through a pattern can be shared in the sense the tooltip means.
  const shared = prState?.source && prState.rollId ? rollDefs.refCalls(cm.getValue(), prState.rollId).length : 0;
  rollPicker.syncHead(shared);
}

const prCommitName = () => rollPicker.commitName();
const prOpenPicker = () => rollPicker.openPicker();
const prClosePicker = (refocus = true) => rollPicker.closePicker(refocus);
const prRenderPickList = (reset = false) => rollPicker.renderList(reset);
const prPickMove = (delta) => rollPicker.move(delta);
const prPickChoose = () => rollPicker.choose();

// ---------------------------------------------------------------------------------------------
// The find-or-create popover. Searching and renaming are separate gestures on purpose: while the
// name box is the roll you are looking at, this one is every OTHER roll - filter as you type, and
// a name that matches nothing offers to make it. Picking (or creating) pins, because reaching in
// here at all says you want to look at that roll rather than whatever the bar brings next.
// ---------------------------------------------------------------------------------------------

/**
 * The name-and-picker head a definition editor wears: the name IS the title, typing over it
 * renames, and the ▾ behind it searches every name there is, offering to create one that matches
 * nothing. One of these per panel (the piano roll's rolls, the LFO's shapes); everything specific
 * to a kind comes in through `reg` and the hooks.
 *
 * els   { wrap, title, name, btn, picker, search, list }
 * reg   the definition registry (see makeDefRegistry)
 * current  () => the name on screen, or null when the call has no name at all
 * open     (id) => put that one on screen
 * refocus  () => hand focus back to the panel's own surface
 * onPick   () => called when the picker is used, before opening (the roll panel pins its lock)
 */
function makeNamePicker({
  els, reg, current, open, refocus, onPick = () => {}, inline = false, scope = () => null,
  // Optional second gesture per row: `use` writes that name into the call the panel is looking
  // through, rather than opening it for editing. `canUse` is asked per render, since there is only
  // something to write into when the panel was opened from a call (see makeDefRegistry's fork).
  use = null, canUse = () => false,
}) {
  let rows = [];
  let idx = 0;
  // `inline`: there is no popover to open - the search box and the list are the panel itself, which
  // is what a kind whose ONLY editing gesture is finding, naming and deleting wants (see the preset
  // panel). Everything else about the widget is the same, so the two share one implementation.
  const isOpen = () => inline || !els.picker.classList.contains('hidden');

  function openPicker() {
    if (inline || current() == null) return;
    els.picker.classList.remove('hidden');
    els.search.value = '';
    // Opened ON the one you are looking at: `idx` outlives a close, so without the reset the
    // highlight bar comes back wherever it was left - pointing at some other row than the ● dot,
    // and one Enter away from opening it. The list is a place to leave from, so it starts where
    // you are (see renderList's reset).
    renderList(true);
    els.search.focus();
  }

  function closePicker(doRefocus = true) {
    if (inline || !isOpen()) return;
    els.picker.classList.add('hidden');
    // Closing because the click landed somewhere else must not then take that click's focus away.
    if (doRefocus) refocus();
  }

  function renderList(resetIdx = false) {
    const typed = els.search.value.trim();
    const q = typed.toLowerCase();
    // Only what could actually be used here: a preset belongs to the plugin it came from, so
    // listing another plugin's would be offering names that can only fail to load (see
    // makeDefRegistry's scope). Unscoped kinds pass null and see everything, as before.
    const all = reg.allIds(scope());
    rows = all.filter((r) => r.id.toLowerCase().includes(q)).map((r) => ({ ...r, label: r.id, act: 'open' }));
    // A name that matches nothing is one you meant to have, so the search doubles as the way to
    // make it - which is how you think about it live, rather than hunting for a + button.
    if (typed && !all.some((r) => r.id.toLowerCase() === q)) {
      rows.push({ id: typed, label: `create “${typed}”`, note: 'new', act: 'create' });
    }
    // Reset means "go to the one that is open", not "go to the top". The list is rebuilt every time
    // a pick opens one, so starting at row 0 would leave the highlight bar and the ● dot pointing at
    // two different presets - and the highlight is where the keyboard would act next, which after a
    // click ought to be the row that was clicked.
    if (resetIdx) {
      const at = rows.findIndex((r) => r.act === 'open' && r.id === current());
      idx = at >= 0 ? at : 0;
    }
    idx = Math.min(idx, Math.max(0, rows.length - 1));
    els.list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'def-pick-empty';
      empty.textContent = `no ${reg.kind}s yet`;
      els.list.appendChild(empty);
      return;
    }
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = `def-pick-row${i === idx ? ' on' : ''}${row.id === current() && row.act === 'open' ? ' current' : ''}`;
      const name = document.createElement('span');
      name.className = 'def-pick-name';
      name.textContent = row.label;
      el.appendChild(name);
      if (row.note) {
        const note = document.createElement('span');
        note.className = 'def-pick-note';
        note.textContent = row.note;
        el.appendChild(note);
      }
      // A copy of this one under the next free spelling of its name, opened in its place - the same
      // data, to draw a variation on; the → beside it is then how the call comes to play the copy.
      // Only this buffer's own: a library entry's data isn't in the buffer to copy (see duplicate).
      if (row.act === 'open' && row.own) {
        const dup = document.createElement('span');
        dup.className = 'def-pick-dup';
        dup.textContent = '⧉';
        dup.title = `duplicate ${row.id}`;
        dup.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation(); // the row's own handler opens it instead
          idx = i;
          onPick();
          reg.duplicate(row.id, row.scope);
          // The list stays up, moved onto the copy (which the panel now shows, so it is `current`):
          // the → beside it is the likely next gesture, and Enter/arrows start from there. Focus
          // stays in the search box so the keyboard keeps driving the list rather than the canvas.
          renderList(true);
          els.search.focus();
        });
        el.appendChild(dup);
      }
      // Send this one into the call the panel is looking through, in place of whatever it names
      // now. Opening a row EDITS that preset; this plays it - which is what the list is for once a
      // patch has more presets than it has calls, and you are picking one rather than shaping it.
      // A library row gets one too: reusing someone else's is the whole point of having a library.
      if (row.act === 'open' && use && canUse()) {
        const send = document.createElement('span');
        send.className = 'def-pick-use';
        send.textContent = '→';
        send.title = `play ${row.id} here`;
        send.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation(); // the row's own handler opens it for editing instead
          idx = i;
          use(row.id, row.scope);
        });
        el.appendChild(send);
      }
      // Only this buffer's own can be deleted - the shared library isn't ours, and there is
      // nothing to delete about one the "create" row is offering to make.
      if (row.act === 'open' && row.own) {
        const del = document.createElement('span');
        del.className = 'def-pick-del';
        del.textContent = '×';
        del.title = `delete ${row.id}`;
        // Stops the row's own handler: the × is the one part of the row that doesn't open it. The
        // popover stays up afterwards, since clearing these out is rarely one at a time.
        del.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          reg.remove(row.id, row.scope);
          renderList();
        });
        el.appendChild(del);
      }
      // mousedown, not click: the search field's blur would otherwise close the popover first.
      el.addEventListener('mousedown', (e) => { e.preventDefault(); idx = i; choose(); });
      els.list.appendChild(el);
    });
    scrollRowIntoView();
  }

  // The list scrolls once it is more than a box deep, so the highlighted row is regularly below the
  // fold - on open, where it is the one you came in on, and while arrow-keying, which would
  // otherwise walk off the bottom with nothing appearing to happen. Measured against the box rather
  // than offsetTop, which would be relative to whichever ancestor happens to be positioned.
  function scrollRowIntoView() {
    const el = els.list.children[idx];
    if (!el) return;
    const box = els.list.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    if (row.top < box.top) els.list.scrollTop -= box.top - row.top;
    else if (row.bottom > box.bottom) els.list.scrollTop += row.bottom - box.bottom;
  }

  function move(delta) {
    if (!rows.length) return;
    idx = (idx + delta + rows.length) % rows.length;
    renderList();
  }

  function choose() {
    const row = rows[idx];
    if (!row) return;
    if (!inline) els.picker.classList.add('hidden');
    onPick();
    // Created into the scope the list was drawn for - a preset made here belongs to the plugin the
    // slot holds, which is the one it is about to be shaped on.
    if (row.act === 'create') reg.create(row.id, scope());
    else open(row.id, row.scope);
    refocus();
  }

  // The head, redrawn: the name IS the title, so a separate label beside it could only ever repeat
  // what it says. The plain title is what's left when the call has no name at all - an inline
  // pianoroll()/lfo(), which is the whole of its own pattern and names nothing.
  function syncHead(sharedRefs = 0) {
    const id = current();
    els.title.classList.toggle('hidden', id != null);
    els.wrap.classList.toggle('hidden', id == null);
    if (id == null) return closePicker();
    // Never type over someone mid-rename - the box is theirs until they leave it.
    if (document.activeElement !== els.name) els.name.value = id;
    // Fixed width, so a long name is clipped on screen; the tooltip is where it stays whole. A
    // shared one says so, because renaming it here forks rather than renames - but it says it in a
    // glance's worth of words, which is all a tooltip gets mid-set.
    els.name.title = sharedRefs > 1 ? `${id} — shared by ${sharedRefs}; renaming forks` : id;
    if (isOpen()) renderList();
  }

  // Typing over the name renames it. Committing on blur (rather than only on enter) is what makes
  // it feel like a title rather than a form: click, type, look away. Escape puts it back, and the
  // whole rename is one cm.operation, so cmd-Z in the buffer is the other way out.
  function commitName() {
    const id = current();
    if (id == null) return;
    const to = els.name.value.trim();
    if (!to || to === id) return syncHead(); // nothing asked for
    reg.rename(id, to);
  }

  function revertName() {
    els.name.value = current() ?? '';
  }

  return { openPicker, closePicker, isOpen, renderList, move, choose, syncHead, commitName, revertName };
}

// The buffer's own definitions the editor can read; the prebake library it has to ask for.
function prRefreshRollList() {
  api('GET', '/api/rolls')
    .then((res) => {
      const prebake = (list) => (list ?? []).filter((r) => r.layer === 'prebake').map((r) => String(r.id));
      prPrebakeRolls = prebake(res.rolls);
      prPrebakeShapes = prebake(res.shapes);
      // Presets carry the plugin they were captured from, since that is half of what names one
      // (see makeDefRegistry's scope) - so the library's entries keep it rather than flattening.
      prPrebakePresets = (res.presets ?? [])
        .filter((r) => r.layer === 'prebake')
        .map((r) => ({ id: String(r.id), scope: String(r.plugin ?? '') }));
      if (prState?.rollId && !prPicker.classList.contains('hidden')) prRenderPickList();
    })
    .catch(() => {}); // the picker still lists this buffer's rolls without it
}

function closePianorollEditor() {
  prClosePicker();
  prPreviewOff();
  if (prRaf) { cancelAnimationFrame(prRaf); prRaf = null; }
  if (prState?.marker) prState.marker.clear();
  if (prState?.source) prState.source.clear();
  prState = null;
  prPanel.classList.add('hidden');
}

// Redraw each frame while the transport is running, so the playhead tracks the cycle; when it's
// paused, redraw once to clear the last playhead, then idle (the loop keeps spinning cheaply so it
// picks straight back up when play resumes). currentCyclePos() is the scheduler's own timebase.
function prPlayheadLoop() {
  if (!prState) { prRaf = null; return; }
  prFollowPlayingRoll();
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

// The roll as one undoable state. Swing is in it because committing is an edit like any other: it
// zeroes the knob and writes the same offsets into the notes, and an undo that put the nudges back
// while leaving the knob at 0 would double the groove.
const prSnapshot = () => ({ notes: prState.notes.map((nt) => ({ ...nt })), grid: prState.grid, len: prState.len, start: prState.start, mode: prState.mode, swing: prState.swing, swinggrid: prState.swinggrid });
const prSnapKey = (s) => `${pianorollMod.serializePianoRoll(prLiveNotes(s.notes))}|${s.grid}|${s.len}|${s.start}|${s.mode}|${s.swing}|${s.swinggrid}`;

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
  prState.start = snap.start;
  prState.mode = snap.mode;
  prState.swing = snap.swing;
  prState.swinggrid = snap.swinggrid;
  prState.sel.clear(); // the restored notes are new objects; the old selection means nothing
  prSyncGridLenInputs();
  prSyncMode();
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
  // Rewriting the call clears any fold covering it, so a note drawn into a roll would flick its
  // whole definitions block open and (an eval later) shut again. Re-fold now, in the same frame -
  // all of them, since the half-cleared mark this edit just left behind has to go with them.
  refoldAll();
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

// A control that streams while you hold it (the swing slider) would otherwise rewrite the call -
// and re-fold the whole buffer - on every pointer frame. The eval each write schedules is debounced
// anyway, so there is nothing to hear from writing faster than this; the code just catches up on a
// slower beat. Nothing mid-gesture is RECORDED: one drag of the knob is one undo step, the same as
// one drag of a note, and prWriteNow - the end of the gesture - is what records it.
let prWriteTimer = null;
function prWriteSoon() {
  if (prWriteTimer) return; // already on the way - it will pick up whatever the state says by then
  prWriteTimer = setTimeout(() => { prWriteTimer = null; if (prState) writePianorollCall(false); }, PR_WRITE_COALESCE_MS);
}
function prWriteNow() {
  clearTimeout(prWriteTimer);
  prWriteTimer = null;
  writePianorollCall();
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
  // The call must still be the KIND the panel opened: a definition edited back into a plain
  // pianoroll() (or the other way round) is no longer the thing on screen.
  const stillTheCall = new RegExp(`^\\s*${prState.idLiteral ? rollDefs.defCall : 'pianoroll'}\\s*\\(`);
  if (!stillTheCall.test(text)) { closePianorollEditor(); return; }
  const open = text.indexOf('(');
  // Hand-edited into the id form while open: the roll on screen no longer describes this call, and
  // the next edit would write its notes over the ids. Let it go, the same as any other call the
  // roll is no longer anchored to. (A definition's own first argument is an id, not a pattern -
  // its notes are the argument after it, so the question is only asked of the inline form.)
  if (!prState.idLiteral && rollDefs.isIdCall(text.slice(open + 1, text.lastIndexOf(')')))) {
    closePianorollEditor();
    return;
  }
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return; // mid-edit, not a whole call right now - wait for the next change
  const body = text.slice(open + 1, close);
  const parsed = parsePianorollCall(prState.idLiteral ? splitFirstArg(body)[1] : body);
  prState.callStart = cm.indexFromPos(range.from);
  prState.grid = parsed.grid;
  prState.len = parsed.len;
  prState.start = parsed.start;
  prState.swing = parsed.swing;
  prState.swinggrid = parsed.swinggrid;
  if (parsed.mode !== prState.mode) {
    // Typed `mode: "index"` into the call by hand - the same change of view the button makes.
    prState.mode = parsed.mode;
    prState.sel.clear();
    prPreviewOff();
    prSyncMode();
  }
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

// Rendered columns: the loop window's end rounded up to its next whole bar, plus a little headroom
// to drag into. Frozen (prState._dragCols) during a loop drag so the cell width - and thus the drag
// mapping - stays put instead of feeding back on itself as the window changes.
const prRenderCols = () => (Math.floor(prLoopEnd() / prState.grid) + 1) * prState.grid + 4;

// The loop window: `len` cells from `start`. Notes outside it are drawn (dimmed) but never sound,
// and the editing gestures - drawing, dragging, nudging - keep notes inside it.
const prLoopEnd = () => prState.start + prState.len;
const prInLoop = (cell) => cell >= prState.start && cell < prLoopEnd();
const prClampToLoop = (cell) => Math.min(prLoopEnd() - 1, Math.max(prState.start, cell));

// The bar's divisions, coarsest first: the bar itself (`grid` cells), then its halves, quarters,
// … down to a single cell - thirds where a triplet grid can't be halved. A vertical line's weight
// is the coarsest division it lands on, which is what makes the half-way point of a bar readable
// at a glance the way Live's does.
function prBarDivisions(grid) {
  const divs = [];
  let d = grid;
  while (d > 1) {
    divs.push(d);
    d = d % 2 === 0 ? d / 2 : d % 3 === 0 ? d / 3 : 1;
  }
  divs.push(1);
  return divs;
}

// The visible vertical lines as [x, level] pairs (level 0 = a bar line, 1 = its halves, …). Levels
// finer than `maxDepth`, and levels whose lines would crowd closer than PR_DIV_MIN_PX, are left
// out - so zooming in reveals the subdivisions rather than smearing them together. Shared by the
// grid and the value lane, so the two read as one timeline.
function prTimeLines(m, maxDepth = Infinity) {
  const divs = prBarDivisions(prState.grid);
  const crowded = divs.findIndex((d) => d * m.cellW < PR_DIV_MIN_PX);
  const deepest = Math.min(maxDepth, crowded === -1 ? divs.length - 1 : Math.max(0, crowded - 1));
  const out = [];
  const c0 = Math.max(0, Math.floor(m.scroll));
  const c1 = Math.min(m.cols, Math.ceil(m.scroll + m.visibleCells));
  for (let c = c0; c <= c1; c++) {
    const level = divs.findIndex((d) => c % d === 0);
    if (level > deepest) continue;
    const x = prCellToX(c, m);
    if (x >= PR_GUTTER - 0.5 && x <= m.W + 0.5) out.push([x, level]);
  }
  return out;
}

// Everything outside the loop window - the cells before it opens and the ones after it closes - is
// dimmed wherever the timeline is drawn: you can still draw there, it just doesn't play.
function prDimOutside(ctx, m, top, h) {
  const x0 = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prState.start, m)));
  const x1 = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prLoopEnd(), m)));
  ctx.fillStyle = 'rgba(120,120,130,0.22)';
  if (x0 > PR_GUTTER) ctx.fillRect(PR_GUTTER, top, x0 - PR_GUTTER, h);
  if (x1 < m.W) ctx.fillRect(x1, top, m.W - x1, h);
}

function prMetrics() {
  const gridW = prW - PR_GUTTER;
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
  return { W: prW, H: PR_CH, gridTop: PR_TOPBAR, gridH: PR_GRIDH, laneTop: PR_TOPBAR + PR_GRIDH, laneH: PR_LANEH, gridW, cols, cellW, rowH, visibleCells, maxScroll, scroll, lanes, laneOf, laneMax, bottomPos: prState.pitchTop - PR_ROWS };
}

const prCellToX = (cell, m) => PR_GUTTER + (cell - m.scroll) * m.cellW;
const prPosToY = (pos, m) => PR_TOPBAR + (prState.pitchTop - pos) * m.rowH;
const prCellFloat = (px, m) => m.scroll + (px - PR_GUTTER) / m.cellW; // fractional cell under px

function prCanvasPos(e) {
  const r = prCanvas.getBoundingClientRect();
  return { px: (e.clientX - r.left) * (prW / r.width), py: (e.clientY - r.top) * (PR_CH / r.height) };
}

function prCellAt(px, m) {
  if (px < PR_GUTTER) return null;
  const cell = Math.floor(prCellFloat(px, m));
  return cell >= 0 && cell < m.cols ? cell : null;
}

const prClampCell = (px, m) => Math.max(0, Math.min(m.cols - 1, Math.floor(prCellFloat(px, m))));
// pitchTop is fractional (smooth scroll); the integer lane containing py is ceil(top - rows).
const prPosAt = (py, m) => Math.ceil(prState.pitchTop - (py - PR_TOPBAR) / m.rowH);
const prMidiAt = (py, m) => prMidiOf(prPosAt(py, m), m); // the ROW value under py, on whichever axis is showing

// Topmost note covering (cell, row) on the axis currently on screen - later notes draw on top (and
// win overlaps), so scan from the end. Hidden notes aren't on the grid at all, so they can't be hit.
function prNoteAt(cell, row) {
  for (let i = prState.notes.length - 1; i >= 0; i--) {
    const nt = prState.notes[i];
    if (!nt.hidden && prRowOf(nt) === row && cell >= nt.start && cell < nt.start + nt.len) return i;
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

// The index axis's gutter, in place of the keyboard: just the numbers, right-aligned, one per row,
// with every fourth called out - the same job the C labels and the heavier octave lines do on the
// piano, so a row twelve up from the bottom can be counted to rather than squinted at. No keys and
// no scale tint: an index names a file in a pack, and a pack has neither black notes nor a key.
function drawIndexRows(ctx, col, m) {
  const { H, gridTop, rowH, laneTop } = m;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, gridTop, PR_GUTTER, laneTop - gridTop);

  ctx.save(); // clip to the grid area so partial edge rows don't spill into the ruler or the value lane
  ctx.beginPath(); ctx.rect(0, gridTop, PR_GUTTER, laneTop - gridTop); ctx.clip();
  for (let p = Math.ceil(prState.pitchTop); p >= Math.floor(prState.pitchTop - PR_ROWS) - 1; p--) {
    if (p < 0 || p > m.laneMax) continue;
    const row = prMidiOf(p, m); // the index itself - folded, the lane it sits in is not its number
    const y = prPosToY(p, m);
    ctx.strokeStyle = col('--border');
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, y + rowH); ctx.lineTo(PR_GUTTER, y + rowH); ctx.stroke();
    const marked = row % PR_INDEX_GROUP === 0;
    ctx.font = `${marked ? '600 ' : ''}9px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = col(marked ? '--text' : '--text-dim');
    ctx.fillText(String(row), PR_GUTTER - 5, y + rowH / 2 + 0.5);
  }
  ctx.restore();

  ctx.strokeStyle = col('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER + 0.5, 0); ctx.lineTo(PR_GUTTER + 0.5, H); ctx.stroke();
}

// The loop ruler across the top: bar ticks, the loop window [start, start+len) highlighted, and a
// grab handle at each of its ends - drag either one to move that boundary anywhere on the timeline,
// or the highlighted body to slide the whole window over the notes.
function drawLoopBar(ctx, col, m) {
  const accent = col('--accent');
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, 0, m.W, PR_TOPBAR);

  const loopEndX = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prLoopEnd(), m)));
  const loopStartX = Math.min(m.W, Math.max(PR_GUTTER, prCellToX(prState.start, m)));
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

  // a grab handle at each end, pointing into the window
  ctx.fillStyle = accent;
  if (prCellToX(prState.start, m) >= PR_GUTTER) {
    ctx.beginPath();
    ctx.moveTo(loopStartX, 0); ctx.lineTo(loopStartX, PR_TOPBAR); ctx.lineTo(loopStartX + 6, PR_TOPBAR / 2);
    ctx.closePath(); ctx.fill();
  }
  if (prCellToX(prLoopEnd(), m) <= m.W) {
    ctx.beginPath();
    ctx.moveTo(loopEndX, 0); ctx.lineTo(loopEndX, PR_TOPBAR); ctx.lineTo(loopEndX - 6, PR_TOPBAR / 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = col('--border');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PR_GUTTER, PR_TOPBAR + 0.5); ctx.lineTo(m.W, PR_TOPBAR + 0.5); ctx.stroke();
}

// Which part of the loop bar the pointer is on: either end handle (within a grab zone), the window
// body between them, or - outside the window entirely - the end nearest to it, so a click out on
// the ruler still throws that boundary where you clicked.
function prLoopEdgeAt(px, m) {
  const x0 = prCellToX(prState.start, m);
  const x1 = prCellToX(prLoopEnd(), m);
  if (Math.abs(px - x0) <= PR_EDGE_PX) return 'start';
  if (Math.abs(px - x1) <= PR_EDGE_PX) return 'end';
  if (px > x0 && px < x1) return 'move';
  return px < x0 ? 'start' : 'end';
}

// Where a loop-bar drag lands, given the fractional cell under the pointer. The ends are magnetic:
// near a bar line they snap to the bar, a little nearer the half-bar to that, then its quarters -
// because "the top of the measure" is what you're almost always reaching for, and on a 1/32 grid
// that line is otherwise a couple of pixels wide. Further out than any magnet reaches, the drag is
// exact to the cell; `fine` (shift) skips the magnets altogether and is always exact.
function prSnapCell(cellF, m, fine) {
  if (fine) return Math.round(cellF);
  const divs = prBarDivisions(prState.grid);
  for (let level = 0; level < Math.min(divs.length, PR_SNAP_PX.length); level++) {
    const cand = Math.round(cellF / divs[level]) * divs[level];
    if (Math.abs(cand - cellF) * m.cellW <= PR_SNAP_PX[level]) return cand;
  }
  return Math.round(cellF);
}

// Put one end of the window at `cell`, keeping the other where it is (so either end can be
// dragged anywhere on the timeline, and the window never closes below one cell).
function prSetLoopEdge(edge, cell0) {
  const cell = Math.max(0, cell0);
  if (edge === 'start') {
    const end = prLoopEnd();
    prState.start = Math.min(cell, end - 1);
    prState.len = end - prState.start;
  } else {
    prState.len = Math.max(1, cell - prState.start);
  }
  prLenInput.value = prState.len;
}

// --- value lane ---
// Ableton's velocity/chance editor, along the bottom: every note gets a marker at its value's
// height - a dot at its onset with a line running right for its duration, drawn dashed when the
// lane is showing probability (Live's chance style). Drag a marker up or down to set the value; a
// marker in the selection drags the whole selection together, keeping their differences. The label
// in the lane's gutter names the channel on show, carries a caret to say it's clickable, and
// steps on to the next channel when clicked - it's the only channel switch there is.

/** Which note channel the lane (and cmd-drag) is editing right now. */
const prLaneKey = () => (PR_LANE_KEYS.includes(prCmdMode) ? prCmdMode : 'vel');

/** Step the lane (and cmd-drag) on to the next channel. The lane's own gutter label is the only
    switch there is - it names the channel on show and carries a caret to say so. */
function prToggleCmdMode() {
  prCmdMode = PR_LANE_KEYS[(PR_LANE_KEYS.indexOf(prLaneKey()) + 1) % PR_LANE_KEYS.length];
  prSyncLaneChannel();
  if (prState) drawPianoroll(); // the lane redraws with the newly chosen channel
  prRefocus();
}

/** Whatever outside the canvas names the lane's channel - just the 🎲 button's tooltip, for now. */
function prSyncLaneChannel() {
  if (prRandomBtn) prRandomBtn.title = `randomize ${prLaneKey()} — the selection, or the whole roll`;
}

/**
 * One note's value on the lane's channel. `nudge` goes through the roll's own reader, since a note
 * drawn before the field existed simply hasn't got one and `nt.nudge` would read undefined.
 */
const prLaneVal = (nt, key) => (key === 'nudge' ? (pianorollMod?.noteNudge(nt) ?? 0) : nt[key]);

/** A channel's value as the lane's height, 0 at the bottom - and back. vel and prob are already
    that; nudge is bipolar, so its zero sits half way up and "higher" reads as "later". */
const prLaneNorm = (v, key) => (key === 'nudge' ? (v / PR_MAX_NUDGE + 1) / 2 : v);
const prLaneDenorm = (u, key) => (key === 'nudge' ? (u * 2 - 1) * PR_MAX_NUDGE : u);

/** value -> lane y, inset so the end-stop dots at either extreme stay fully visible. */
const prLaneY = (v, m, key) => m.laneTop + PR_LANE_PAD + (1 - prLaneNorm(v, key)) * (m.laneH - 2 * PR_LANE_PAD);

/** ...and back: the channel value at a lane y, clamped to the end stops. What the pencil paints. */
const prLaneValAt = (py, m, key) =>
  prLaneDenorm(Math.min(1, Math.max(0, 1 - (py - m.laneTop - PR_LANE_PAD) / (m.laneH - 2 * PR_LANE_PAD))), key);

/**
 * The pencil in the value lane, Live's draw tool: every note the drag sweeps over takes the
 * ABSOLUTE height the pointer is held at, whatever it was before - so dragging across a bar flattens
 * it to one value and a diagonal drag ramps it. The whole span from the last pointer position is
 * painted rather than just the current one, so a fast drag can't skip a column.
 *
 * The arrow tool keeps the relative marker drag instead (see the 'lane' drag), which is the one that
 * preserves a selection's differences - the two gestures answer different questions.
 */
function prPaintLane(pxA, pxB, py, m) {
  const key = prLaneKey();
  const v = prLaneValAt(py, m, key);
  const x0 = Math.min(pxA, pxB), x1 = Math.max(pxA, pxB);
  let lead = null; // the painted note nearest the pointer - what the lane's readout follows
  let leadX = -Infinity;
  let painted = 0;
  for (const nt of prLiveNotes(prState.notes)) {
    const sx = prCellToX(nt.start, m);
    // Same reach as prLaneNoteAt: anywhere under the marker's line counts, with a few px of grace
    // in front of its onset dot.
    if (prCellToX(nt.start + nt.len, m) <= x0 || sx - 4 > x1) continue;
    nt[key] = v;
    painted++;
    if (sx <= x1 && sx > leadX) { leadX = sx; lead = nt; }
  }
  prState._laneDrag = lead; // null over a gap: the readout belongs to the note being painted, or nothing
  return painted;
}

/**
 * 🎲: fill the lane's channel with fresh random values - the selection if there is one, otherwise
 * every note in the roll. Uniform across the channel's own range (0..1 for vel and prob, half a cell
 * either way for nudge), which is what a die does; anything gentler is a pencil drag away.
 */
function prRandomizeLane() {
  if (!prState) return;
  const key = prLaneKey();
  const targets = prState.sel.size ? [...prState.sel].filter((nt) => !nt.hidden) : prLiveNotes(prState.notes);
  if (!targets.length) return;
  for (const nt of targets) nt[key] = prLaneDenorm(Math.random(), key);
  writePianorollCall();
  drawPianoroll();
  prRefocus();
}

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
    const dy = Math.abs(prLaneY(prLaneVal(nt, key), m, key) - py);
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

  // the timeline carries on through the lane - bars and their halves only, so the markers stay
  // locatable without the lane turning into a picket fence
  for (const [x, level] of prTimeLines(m, 1)) {
    ctx.strokeStyle = level === 0 ? col('--border-strong') : col('--border');
    ctx.lineWidth = 1;
    ctx.globalAlpha = PR_DIV_A[Math.min(level, PR_DIV_A.length - 1)];
    ctx.beginPath(); ctx.moveTo(x, laneTop); ctx.lineTo(x, laneTop + laneH); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // A bipolar channel needs its zero drawn, or "no offset" and "half a cell early" look alike.
  if (key === 'nudge') {
    ctx.strokeStyle = col('--border-strong');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    const y0 = prLaneY(0, m, key);
    ctx.beginPath(); ctx.moveTo(PR_GUTTER, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // dim outside the loop window, matching the grid above
  prDimOutside(ctx, m, laneTop, laneH);

  // markers - selected ones drawn last so a chord's dragged marker stays visible on top
  const selCol = col('--text');
  const muteCol = col('--text-dim');
  const marker = (nt) => {
    const x = prCellToX(nt.start, m);
    const x2 = prCellToX(nt.start + nt.len, m);
    if (x2 <= PR_GUTTER || x >= W) return;
    const y = prLaneY(prLaneVal(nt, key), m, key);
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
    const y = prLaneY(prLaneVal(dragNt, key), m, key);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col('--text');
    ctx.fillText(String(Math.round(prLaneVal(dragNt, key) * 1000) / 1000), Math.max(PR_GUTTER + 3, x + 7), Math.min(laneTop + laneH - 6, Math.max(laneTop + 7, y - 9)));
  }

  // gutter: the channel on show; clicking it flips to the other one
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, laneTop, PR_GUTTER, laneH);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  // name + a solid caret, so the label reads as the switch it is (clicking steps vel → prob → nudge).
  const cy = laneTop + laneH / 2;
  const tw = ctx.measureText(key).width;
  const x0 = (PR_GUTTER - (tw + PR_LANE_CARET_W + 4)) / 2;
  ctx.fillText(key, x0, cy);
  const cx = x0 + tw + 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 2);
  ctx.lineTo(cx + PR_LANE_CARET_W, cy - 2);
  ctx.lineTo(cx + PR_LANE_CARET_W / 2, cy + 3);
  ctx.closePath();
  ctx.fill();

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
  // No scale colouring on the index axis: its rows are files in a pack, not pitches in a key.
  const info = prIndexMode() ? null : prScaleInfo();
  const index = prIndexMode();
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
      } else if (!index && (rank === 0 || (rank === null && isBlackKey(M)))) {
        ctx.fillStyle = col('--hover-bg');
        ctx.fillRect(PR_GUTTER, y0, W - PR_GUTTER, y1 - y0);
      }
    }
    if (y >= gridTop - 0.5 && y <= laneTop + 0.5) {
      ctx.strokeStyle = col('--border');
      // heavier at each octave boundary - the tonic's when there's a scale, otherwise each C - and
      // every fourth row on the index axis, which is what its gutter counts in.
      ctx.lineWidth = (index ? M % PR_INDEX_GROUP === 0 : info ? rank === 2 : M % 12 === 0) ? 1.2 : 0.5;
      ctx.beginPath(); ctx.moveTo(PR_GUTTER, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  // vertical lines (visible span only), by division: heaviest at each bar (a cycle = grid cells),
  // then its halves, quarters and so on, each a little lighter than the last - so where you are in
  // the bar reads off the grid itself, and zooming in brings the finer levels in (see prTimeLines).
  for (const [x, level] of prTimeLines(m)) {
    ctx.strokeStyle = level === 0 ? col('--border-strong') : col('--border');
    ctx.lineWidth = PR_DIV_W[Math.min(level, PR_DIV_W.length - 1)];
    ctx.globalAlpha = PR_DIV_A[Math.min(level, PR_DIV_A.length - 1)];
    ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, laneTop); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // dim everything outside the loop window - before it opens as well as after it closes
  prDimOutside(ctx, m, gridTop, gridH);

  // notes: fill opacity encodes velocity; a dashed outline marks a sub-unity probability; selected
  // notes get a bright solid outline. A muted note drops out of the accent entirely and is drawn in
  // flat grey - it's still on the grid, and still selectable, but it reads as switched off.
  // Rectangles are clipped to the grid when scrolled.
  const selCol = col('--text');
  const muteCol = col('--text-dim');
  for (const nt of prLiveNotes(prState.notes)) {
    const pos = prPosOf(prRowOf(nt), m);
    if (pos > prState.pitchTop + 1 || pos < m.bottomPos) continue; // +1: keep a partial top lane
    const x = prCellToX(nt.start, m);
    const x2 = prCellToX(nt.start + nt.len, m);
    if (x2 <= PR_GUTTER || x >= W) continue;
    const dx = Math.max(PR_GUTTER + 0.5, x);
    const dx2 = Math.min(W, x2);
    const y = prPosToY(pos, m);
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
    // A nudged note keeps its CELL - the grid is what the roll is written on, and a rectangle that
    // wandered off it would also wander out of its own hit box. What moves is a tick at the onset
    // the note actually plays at, standing out to the left or right of the block it belongs to.
    //
    // The roll's swing counts towards that onset as well, because it is the same offset arriving
    // from somewhere else (the two sum - see timeShift). So turning the swing knob slides the ticks,
    // and pressing commit - which folds exactly this number into each note's own nudge - leaves
    // every one of them where it already was. Nothing moving is the confirmation that nothing changed.
    const nudge = pianorollMod.noteNudge(nt)
      + pianorollMod.pianoRollSwingCells(((Math.round(nt.start) % prState.grid) + prState.grid) % prState.grid, prState);
    if (nudge) {
      const tx = prCellToX(nt.start + nudge, m);
      if (tx >= PR_GUTTER && tx <= W) {
        ctx.strokeStyle = nt.mute ? muteCol : selected ? selCol : accent;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(tx, y + 1.5); ctx.lineTo(tx, y + rowH - 1.5); ctx.stroke();
      }
    }
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
    const x = prCellToX(prState.start + (((abs % prState.len) + prState.len) % prState.len), m);
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
  // last, so the gutter overlays the grid's left edge cleanly
  if (index) drawIndexRows(ctx, col, m);
  else drawPianoKeys(ctx, col, m, info);
}

// Keep the moved selection within the visible pitch window (in lane coordinates, so it follows a
// folded roll too). prMetrics clamps whatever this sets to the ends of the axis.
function prScrollTo(notes) {
  if (!notes.length) return;
  const m = prMetrics();
  const positions = notes.map((n) => prPosOf(prRowOf(n), m));
  const hi = Math.max(...positions);
  const lo = Math.min(...positions);
  if (hi > prState.pitchTop) prState.pitchTop = hi;
  else if (lo < prState.pitchTop - PR_ROWS + 1) prState.pitchTop = lo + PR_ROWS - 1;
}

// Which cursor the pointer should show at (px,py), given whether a velocity/prob modifier is held.
function prCursorFor(px, py, m, velMod) {
  if (py < PR_TOPBAR) { // loop ruler: the ends resize the window, its body slides it
    if (px < PR_GUTTER) return 'default';
    return prLoopEdgeAt(px, m) === 'move' ? 'grab' : 'ew-resize';
  }
  if (py >= m.laneTop) { // value lane: markers drag up/down, the gutter label is the channel switch
    if (px < PR_GUTTER) return 'pointer';
    if (prTool === 'draw') return CUR_PENCIL; // ...and the pencil paints values across it
    return prLaneNoteAt(px, py, m) ? CUR_UPDOWN : 'default';
  }
  if (px < PR_GUTTER) return prIndexMode() ? 'default' : 'pointer'; // over the piano keyboard - the index gutter has nothing to play
  const cell = prCellAt(px, m);
  const emptyCursor = prTool === 'draw' ? CUR_PENCIL : 'crosshair'; // pencil draws, arrow marquees
  if (cell == null) return emptyCursor;
  const hit = prNoteAt(cell, prMidiAt(py, m));
  if (hit == null) return emptyCursor;
  const nt = prState.notes[hit];
  if (velMod) return CUR_UPDOWN; // cmd/ctrl over a note = a drag on whichever channel the lane shows
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
  const copies = sel.map((n) => ({ ...n, start: prClampToLoop(n.start + shift) }));
  prState.notes.push(...copies);
  prState.sel = new Set(copies);
  prClipOverlaps(); // the copies were pushed last, so they land on top of anything already there
  writePianorollCall();
  drawPianoroll();
}

// Copy and paste (cmd-C / cmd-X / cmd-V), between rolls as well as within one. The editor's own
// clipboard rather than the system one: a note is a row of a roll, and the roll it is pasted into
// may be a different one - or one that did not exist when it was copied, since making a new roll
// and pasting a phrase into it is most of what this is for. So it is kept OUTSIDE prState: the
// panel moving to another roll, or a new one being created, leaves it exactly as it was.
//
// Pasted notes land where they were copied from - the phrase keeps its place in the bar, which is
// what carrying it into another roll means - clamped into the loop, and selected, so a paste is one
// arrow-key or drag away from anywhere else. Within the same roll that puts the copies on top of
// the originals (Ableton's overlap rule keeps the top ones); cmd-D is the in-roll duplicate.
let prClipboard = null; // [{ ...note }], each a detached copy - the roll it came from may be gone
function prCopy(notes) {
  prClipboard = notes.map((n) => ({ ...n, hidden: false }));
  logLine(`copied ${notes.length} note${notes.length === 1 ? '' : 's'} - cmd-V pastes them into any roll`);
}

function prPaste() {
  if (!prState || !prClipboard?.length) return;
  const copies = prClipboard.map((n) => ({ ...n, start: prClampToLoop(n.start) }));
  prState.notes.push(...copies); // last, so the pasted notes win the overlap rule where they land
  prState.sel = new Set(copies);
  prClipOverlaps();
  prScrollTo(copies);
  writePianorollCall();
  drawPianoroll();
}

// Either fold on/off, keeping the view where it was: the axis changes length underneath, so the
// row at the middle of the window is re-centered in the new coordinates rather than letting the
// raw lane index carry over (which would jump the roll somewhere unrelated).
function prSetFold(key, on) {
  const before = prMetrics();
  const centerRow = prMidiOf(Math.round(prState.pitchTop - PR_ROWS / 2), before);
  prState[key] = on;
  const after = prMetrics();
  prState.pitchTop = prPosOf(centerRow, after) + Math.floor(PR_ROWS / 2);
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

// Match the backing store to the width the layout has landed on (the column minimizing, the panel
// squeezed by a narrow window) and redraw at it. The CSS sizes the element; nothing here writes a
// style width back, so this can never drive the layout it is reading.
function prSizeCanvas() {
  const w = prCanvas.clientWidth;
  if (!w) return; // laid out at zero - the panel is hidden, and it will resize again on the way in
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  prW = w;
  prCanvas._dpr = dpr;
  prCanvas.width = w * dpr;
  prCanvas.height = PR_CH * dpr;
  if (prState) drawPianoroll();
}

function initPianorollCanvas() {
  prCanvas.tabIndex = 0; // focusable, so arrow keys / delete / ctrl-a reach it
  // Every width change lands here: the column minimizing, a narrow window squeezing the panel, or
  // the panel simply being shown. (While it's hidden the callback sees zero and waits.)
  new ResizeObserver(prSizeCanvas).observe(prCanvas);

  let drag = null; // { kind: 'create'|'move'|'resize'|'vel'|'lane'|'marquee'|'loop'|'audition', ... }
  const snapshotPos = () => [...prState.sel].map((n) => ({ n, start: n.start, row: prRowOf(n) }));
  const snapshotLen = () => [...prState.sel].map((n) => ({ n, len: n.len }));
  // Raise the dragged notes over whatever they land on - but only once the drag has actually moved
  // something, so a click that merely selects a note never reshuffles the lane it sits in.
  const raiseOnce = (d) => { if (!d.raised) { d.raised = true; prTouch(prState.sel); } };
  // Option-drag duplicates, Live's copy-drag: a copy of the selection is left behind at the position
  // it started from and the drag carries the copies instead. Like raiseOnce this waits for the drag
  // to actually move something, so an option-CLICK that never travels is just a click - not a note
  // stacked exactly on itself (which the overlap rule would resolve by burying the original).
  const altCopy = (d) => {
    if (!d.alt || d.copied) return;
    d.copied = true;
    const copies = d.orig.map((o) => ({ ...o.n })); // still at their original cells - nothing has moved yet
    prState.notes.push(...copies); // last, so the copies win the overlap rule wherever they land
    prState.sel = new Set(copies);
    d.orig = copies.map((n, i) => ({ n, start: d.orig[i].start, row: d.orig[i].row }));
  };
  const setCursor = (c) => { if (prCanvas.style.cursor !== c) prCanvas.style.cursor = c; };
  const dragCursor = (d) =>
    (d.kind === 'loop'
      ? (d.edge === 'move' ? 'grabbing' : 'ew-resize')
      : { vel: CUR_UPDOWN, lane: CUR_UPDOWN, paint: CUR_PENCIL, resize: CUR_BRACKET, move: 'grabbing', create: CUR_PENCIL, marquee: 'crosshair', audition: 'pointer' }[d.kind] ?? 'default');

  prCanvas.addEventListener('contextmenu', (e) => { if (prState) e.preventDefault(); }); // ctrl-drag (mac) = velocity, not a menu

  prCanvas.addEventListener('pointerdown', (e) => {
    if (!prState) return;
    prCanvas.focus();
    prCanvas.setPointerCapture(e.pointerId);
    const m = prMetrics();
    const { px, py } = prCanvasPos(e);
    prPointer = { px, py };
    if (py < PR_TOPBAR) { // loop ruler - drag either end, or the window itself (written on pointerup)
      if (px >= PR_GUTTER) {
        const edge = prLoopEdgeAt(px, m);
        drag = { kind: 'loop', edge, grabCell: prCellFloat(px, m), start0: prState.start };
        prState._dragCols = m.cols;
        // Grabbing an end throws it straight to the pointer (clicking out on the ruler is still
        // "put the near boundary here"); grabbing the body only moves once the pointer does.
        if (edge !== 'move') prSetLoopEdge(edge, prSnapCell(prCellFloat(px, m), m, e.shiftKey));
        drawPianoroll();
      }
      return;
    }
    if (py >= m.laneTop) { // value lane - drag a marker to set the channel on show (see drawValueLane)
      if (px < PR_GUTTER) { prToggleCmdMode(); return; } // the channel label - the lane's channel switch
      // Pencil: paint values across the lane at the height you hold it (see prPaintLane). Shift is
      // left to the marker drag below, so extending the selection from the lane still works.
      if (prTool === 'draw' && !e.shiftKey) {
        drag = { kind: 'paint', lastPx: px, painted: 0 };
        drag.painted += prPaintLane(px, px, py, m);
        drawPianoroll();
        return;
      }
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
    const row = prMidiOf(pos, m);
    const cell = prCellAt(px, m);
    if (cell == null) {
      // clicked the piano keyboard - audition that key, don't edit. There is no key to audition on
      // the index axis, where the gutter is a list of files the engine holds, not pitches.
      if (!prIndexMode() && px < PR_GUTTER && pos <= prState.pitchTop && pos >= m.bottomPos) {
        drag = { kind: 'audition' };
        prPreview(row);
      }
      return;
    }
    const hit = prNoteAt(cell, row);
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
        // alt: option-drag duplicates - see altCopy, which does it on the first movement
        drag = { kind: 'move', grabCell: cell, grabPos: pos, orig: snapshotPos(), alt: e.altKey };
        prPreviewNotes([nt]);
      }
    } else if (prTool === 'select') {
      // rubber-band select (shift keeps the existing selection as a base). Without shift the click
      // deselects right away, so a click that never becomes a drag still lands on empty space empty-handed.
      if (!e.shiftKey) prState.sel = new Set();
      drag = { kind: 'marquee', x0: px, y0: py, base: e.shiftKey ? new Set(prState.sel) : new Set() };
      prState.marquee = { x: px, y: py, w: 0, h: 0 };
    } else if (prInLoop(cell)) { // draw a note (only inside the loop window)
      if (!e.shiftKey) prState.sel = new Set();
      const nt = prNewNote(row, cell);
      prState.notes.push(nt);
      prState.sel.add(nt);
      drag = { kind: 'create', note: nt };
      prClipOverlaps(); // pushed last, so it takes the lane from whatever was under the pencil
      prPreview(nt.midi);
    } else {
      prState.sel = new Set(); // click in the dimmed area outside the loop window - just clear selection
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
      // The window's ends - and its start when the whole thing is being slid - snap to the bar and
      // its halves unless shift is held (see prSnapCell).
      const at = prSnapCell(drag.edge === 'move' ? drag.start0 + prCellFloat(px, m) - drag.grabCell : prCellFloat(px, m), m, e.shiftKey);
      if (drag.edge === 'move') prState.start = Math.max(0, at);
      else prSetLoopEdge(drag.edge, at);
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
      if (dCell || dPos) { altCopy(drag); raiseOnce(drag); }
      for (const o of drag.orig) {
        o.n.start = prClampToLoop(o.start + dCell);
        prSetRow(o.n, prMidiOf(prPosOf(o.row, m) + dPos, m));
      }
      prClipOverlaps(); // notes it passes over give way, and come back behind it
      if (drag.orig[0]) prPreviewNotes([drag.orig[0].n]);
    } else if (drag.kind === 'vel') {
      const d = (e.movementY ?? 0) * 0.01;
      const key = prLaneKey();
      for (const n of prState.sel) {
        n[key] = prLaneDenorm(Math.min(1, Math.max(0, prLaneNorm(prLaneVal(n, key), key) - d)), key);
      }
    } else if (drag.kind === 'lane') {
      // The lane's full height is the full 0..1 range; the delta is relative, so a multi-note drag
      // keeps the selection's differences until a note reaches an end stop.
      const d = (py - drag.lastPy) / (m.laneH - 2 * PR_LANE_PAD);
      drag.lastPy = py;
      const key = prLaneKey();
      // The delta is in lane HEIGHT, which every channel shares, so a bipolar one (nudge) drags at
      // the same feel as vel and a multi-note drag keeps the selection's differences either way.
      for (const n of prState.sel) {
        n[key] = prLaneDenorm(Math.min(1, Math.max(0, prLaneNorm(prLaneVal(n, key), key) - d)), key);
      }
    } else if (drag.kind === 'paint') {
      // Sweep from where the pointer was to where it is, so nothing between two frames is missed.
      drag.painted += prPaintLane(drag.lastPx, px, py, m);
      drag.lastPx = px;
    } else if (drag.kind === 'marquee') {
      const xa = Math.min(Math.max(px, PR_GUTTER), prW), xb = Math.min(Math.max(drag.x0, PR_GUTTER), prW);
      const ya = Math.min(Math.max(py, PR_TOPBAR), m.laneTop), yb = Math.min(Math.max(drag.y0, PR_TOPBAR), m.laneTop);
      const rx = Math.min(xa, xb), rw = Math.abs(xa - xb), ry = Math.min(ya, yb), rh = Math.abs(ya - yb);
      prState.marquee = { x: rx, y: ry, w: rw, h: rh };
      const c0 = prCellFloat(rx, m), c1 = prCellFloat(rx + rw, m);
      const midiHi = prMidiAt(ry, m), midiLo = prMidiAt(ry + rh, m);
      const inRect = (n) => prRowOf(n) >= midiLo && prRowOf(n) <= midiHi && n.start < c1 && n.start + n.len > c0;
      prState.sel = new Set([...drag.base, ...prLiveNotes(prState.notes).filter(inRect)]);
    }
    setCursor(dragCursor(drag));
    drawPianoroll();
  });

  prCanvas.addEventListener('pointerup', (e) => {
    if (drag && prState) {
      if (drag.kind === 'marquee') prState.marquee = null;
      // A pencil click that landed on empty lane changed nothing - and a write that changes nothing
      // still costs the buffer a re-eval, so it doesn't get one.
      else if (drag.kind === 'paint') { if (drag.painted) writePianorollCall(); }
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
    } else if (prTool === 'select' && prInLoop(cell)) { // double-click empty in the arrow tool draws a note
      const nt = prNewNote(prMidiAt(py, m), cell);
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
    } else if (mod && !e.shiftKey && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
      if (!sel.length) return;
      e.preventDefault();
      prCopy(sel);
      if (e.key === 'x' || e.key === 'X') {
        prState.notes = prState.notes.filter((n) => !prState.sel.has(n));
        prState.sel.clear();
        prClipOverlaps();
        writePianorollCall();
        drawPianoroll();
      }
    } else if (mod && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      prPaste();
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
      // A plain arrow steps one LANE (a semitone, or one scale step when folded); shift is a jump
      // in whatever the axis counts in - an octave of 12 semitones, or a group of 4 indices.
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const m = prMetrics();
      const jump = prAxisJump();
      prTouch(sel); // a nudged note lands on top, like a dragged one
      for (const n of sel) {
        const row = prRowOf(n);
        prSetRow(n, e.shiftKey ? row + dir * jump : prMidiOf(prPosOf(row, m) + dir, m));
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
        for (const n of sel) n.start = prClampToLoop(n.start + dir);
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
  // Asked for up front, not on first open: auto-naming has to know which ids prebake already
  // holds, or naming a prebake roll from a pattern would quietly define an empty one over it.
  prRefreshRollList();

  // Picking a roll by hand PINS it - otherwise the next bar takes the screen straight back, which
  // is the opposite of what reaching for the picker means.
  // The name box. Focus-then-select would be undone by the same click's mouseup, so the first click
  // takes the whole name in one gesture (typing replaces it); a second click inside places the
  // cursor like any text field. Following is suspended while it has focus - see prFollowPlayingRoll.
  prName.addEventListener('mousedown', (e) => {
    if (document.activeElement === prName) return;
    e.preventDefault();
    prName.focus();
    prName.select();
  });
  prName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); prName.blur(); } // Escape is the panel's, see above
    e.stopPropagation(); // the roll's own keys (delete, the arrows, B) are not editing this name
  });
  prName.addEventListener('blur', prCommitName);

  prPickBtn.addEventListener('click', () => {
    if (prPicker.classList.contains('hidden')) prOpenPicker();
    else prClosePicker();
  });
  prSearch.addEventListener('input', () => prRenderPickList(true));
  prSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); prPickMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); prPickMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); prPickChoose(); } // Escape is the panel's
    e.stopPropagation();
  });
  // Anywhere else is "never mind" - including the canvas, which is where you were headed anyway.
  document.addEventListener('mousedown', (e) => {
    if (!prPicker.classList.contains('hidden') && !prPickWrap.contains(e.target)) prClosePicker(false);
  });

  prLockBtn.addEventListener('click', () => {
    prSetFollowLock(!prFollowLocked);
    prRefocus();
  });



  // grid is the GRANULARITY, and changing it re-draws the same music on a finer or coarser mesh:
  // every note and the loop window are rescaled so they span the time they did before, so a quarter
  // note on the 1/4 grid becomes four cells of the 1/16 grid rather than a sixteenth. (Coarsening
  // rounds - that's the "do our best" part - and the overlap rule settles anything that rounds onto
  // a neighbour.) The ×2 / ÷2 buttons are the other axis: same cells, different amount of time.
  prGridSelect.addEventListener('change', () => {
    if (!prState) return;
    const grid = Math.max(1, Math.round(Number(prGridSelect.value) || 16));
    Object.assign(prState, pianorollMod.regridPianoRoll(prState, grid));
    prClipOverlaps();
    prSyncGridLenInputs();
    writePianorollCall();
    drawPianoroll();
    prRefocus();
  });

  // The roll's own groove. Setting it changes nothing about where the notes are WRITTEN - it is the
  // swing channel, applied where the events are emitted (see timeShift) - so the grid stays put and
  // the onset ticks move. Committing is what turns that into something the notes themselves hold.
  //
  // It applies as you DRAG it, not when you let go: swing is a thing you hear your way to, and a
  // groove knob you have to release to audition is a groove knob you can't dial in. `live` says the
  // gesture is still going, which is the only thing that changes - the write is coalesced onto a
  // slower beat (see prWriteSoon) instead of rewriting the call on every pointer frame.
  const prSetSwing = (live = false) => {
    if (!prState) return;
    prState.swing = prSwingSlider.get();
    const sg = Number(prSwingGridSelect.value);
    prState.swinggrid = sg >= 1 ? Math.round(sg) : null;
    // Just the commit button, not prSyncGridLenInputs: rebuilding the inputs mid-drag would set the
    // slider back from state under the pointer that is moving it.
    prCommitSwingBtn.disabled = !prState.swing;
    if (live) prWriteSoon(); else prWriteNow();
    drawPianoroll();
  };
  prSwingSlider = prMakeBoxSlider(prSwingBox, {
    min: -0.5,
    max: 0.5,
    step: 0.01,
    center: true, // straight sits in the middle: the fill says which side of it you're on
    fmt: (v) => (v ? v.toFixed(2) : '0'),
    onInput: () => prSetSwing(true),
    onCommit: () => prSetSwing(false),
  });
  prSwingGridSelect.addEventListener('change', () => { prSetSwing(); prRefocus(); });

  // Commit: the swing stops being a setting and becomes the notes' own offsets. Nothing about the
  // sound changes - that is the whole promise - so the onset ticks don't move as you click; what
  // changes is that they are now editable one at a time, and survive being converted to notation.
  prCommitSwingBtn.addEventListener('click', () => {
    if (!prState?.swing) return;
    prPushHistory(); // one undo step puts the swing knob and every nudge back together
    const { clamped, uneven } = pianorollMod.commitPianoRollSwing(prState.notes, {
      grid: prState.grid,
      len: prState.len,
      swing: prState.swing,
      swinggrid: prState.swinggrid,
    });
    prState.swing = 0;
    prState.swinggrid = null;
    prSyncGridLenInputs();
    writePianorollCall();
    drawPianoroll();
    // Both of these leave a roll that plays slightly differently from the one you just heard, which
    // is worth a line - and neither is a reason to refuse the edit (see the warn-don't-block rule).
    if (clamped) {
      logLine(`piano roll: ${clamped} note${clamped === 1 ? '' : 's'} needed more than half a cell of swing, which is as far as a per-note offset reaches - committed as far as they go. Swinging the roll's own grid always fits.`);
    }
    if (uneven) {
      logLine('piano roll: this roll\'s loop is not a whole cycle, so a note falls on a different beat each time round - the committed offsets are the ones from its first pass.');
    }
    prRefocus();
  });

  // ÷2 / ×2: stretch in time. With notes SELECTED it's just those notes - they spread out from (or
  // pull in towards) the first of them, so the phrase keeps its starting beat while its rhythm
  // halves or doubles, and everything else in the roll stays exactly where it is. Stretching a
  // phrase past the loop end doesn't move the loop: those notes go quiet in the dimmed area, still
  // drawn and still in the code, and ÷2 (or dragging the loop end out) brings them back.
  //
  // With nothing selected it's the whole roll - a bar-long arpeggio becomes half a bar, or two.
  // There the cells stay exactly where they are and the GRID moves under them (which is why `len`
  // doesn't change), so nothing is rounded unless the grid can't take it (see retimePianoRoll).
  const prRetime = (factor) => {
    if (!prState) return;
    const sel = [...prState.sel];
    if (sel.length) {
      prTouch(sel); // a stretched note lands on top of whatever it now runs into, like a dragged one
      pianorollMod.rescalePianoRoll(sel, factor, Math.min(...sel.map((n) => n.start)));
    } else {
      Object.assign(prState, pianorollMod.retimePianoRoll(prState, factor));
    }
    prClipOverlaps();
    prSyncGridLenInputs();
    writePianorollCall();
    drawPianoroll();
    prRefocus();
  };
  prHalveBtn.addEventListener('click', () => prRetime(0.5));
  prDoubleBtn.addEventListener('click', () => prRetime(2));

  // ⧉: repeat the loop window after itself - the window doubles in length and everything in it is
  // copied one window along, so a one-bar arpeggio becomes that arpeggio over two bars. The copies
  // land selected, ready to be edited into a variation.
  prDupLoopBtn.addEventListener('click', () => {
    if (!prState) return;
    const { copies, len } = pianorollMod.duplicatePianoRollLoop(prState);
    prState.notes.push(...copies); // last, so the copies win the overlap rule where they land
    prState.len = len;
    prState.sel = new Set(copies);
    prClipOverlaps();
    prSyncGridLenInputs();
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

  const reflectTool = () => { prToolBtn.textContent = prTool === 'draw' ? '✏️' : '⬚'; prToolBtn.title = `${prTool} (B)`; };
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

  // Clicking the scale chip snaps every note in the roll into the key - the same nearest-tone
  // quantize `.scale()`/`.sc()` apply to a note pattern, so a drawn line and a written one land on
  // the same pitches. One history entry, so cmd-Z puts the out-of-key notes back.
  prScaleLabel.addEventListener('click', () => {
    if (!prState || prIndexMode() || !prScaleInfo()) return; // a pack has no key to snap to
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

  // note ⇄ index: show the other channel. Per roll (it is written into the call, and undo walks
  // back over it), unlike the tool and the folds, which are ways of working and stay sticky. No log
  // line: nothing happened to the music, and the button's own label says where you now are.
  prModeBtn.addEventListener('click', () => {
    if (!prState) return;
    prSetMode(prIndexMode() ? 'note' : 'index');
    prRefocus();
  });

  // scale: show only the global scale's lanes. Sticky like the tool and cmd mode, but it needs a
  // scale to fold to - without one the button says so rather than silently doing nothing. (On the
  // index axis it is disabled outright; see prSyncMode.)
  const reflectScaleFold = () => {
    prScaleFoldBtn.classList.toggle('active', prScaleFold);
    prScaleFoldBtn.title = prScaleFold ? 'showing the scale’s notes' : 'show only the scale set by setscale()';
  };
  reflectScaleFold();
  prScaleFoldBtn.addEventListener('click', () => {
    if (!prScaleFold && !prScaleInfo()) {
      logLine('scale needs a key — put setscale("F minor") in the buffer', true);
      return;
    }
    prScaleFold = !prScaleFold;
    localStorage.setItem('poptartPianorollScaleFold', prScaleFold ? '1' : '0');
    reflectScaleFold();
    if (prState) prSetFold('scaleFold', prScaleFold);
    prRefocus();
  });

  // fold: Live's Fold - drop every row nothing is drawn on, so a line spread over two octaves (or a
  // pack sequence using four of its files) closes up to the rows you are actually working in. Both
  // axes, no key needed; an empty roll has nothing to fold to and stays as it is.
  const reflectFold = () => {
    prFoldBtn.classList.toggle('active', prFold);
    prFoldBtn.title = prFold ? 'showing only the rows that have notes' : 'show only the rows that have notes';
  };
  reflectFold();
  prFoldBtn.addEventListener('click', () => {
    prFold = !prFold;
    localStorage.setItem('poptartPianorollFold', prFold ? '1' : '0');
    reflectFold();
    if (prState) prSetFold('fold', prFold);
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

  // 🎲 rolls the value lane's channel. Which channel that is comes from the lane's own gutter label,
  // the one switch there is - the button's tooltip names it so the die is never a mystery.
  prSyncLaneChannel();
  prRandomBtn.addEventListener('click', prRandomizeLane);

  // The timing controls fold away, like the main sidebar - the grid is what you are working in,
  // and grid/len/÷2/×2/⧉ are set once and then left alone. Sticky, like the tool and fold.
  const reflectSide = () => {
    prSide.classList.toggle('collapsed', prSideMin);
    prSideToggle.textContent = prSideMin ? '»' : '«';
    prSideToggle.title = prSideMin ? 'show the timing controls' : 'hide the timing controls';
  };
  reflectSide();
  prSideToggle.addEventListener('click', () => {
    prSideMin = !prSideMin;
    localStorage.setItem('poptartPianorollSide', prSideMin ? '1' : '');
    reflectSide();
    prRefocus();
  });

  // →♪ - the drawn roll leaves, and the mini-notation that plays the same thing takes its place.
  //
  // WHERE it takes its place depends on which form the roll is. An inline pianoroll(...) IS its own
  // pattern, so the call is simply replaced. A NAMED roll is data behind a name: its definition
  // holds no position in any pattern, so what gets rewritten is every pianoroll("name") that plays
  // it - and the definition then goes, because a name nothing says any more is a name the next
  // evaluation would otherwise hand back as an empty roll (see materialize).
  prToMiniBtn.addEventListener('click', () => {
    if (!prState) return;
    const range = prState.marker.find();
    if (!range) return;
    const code = cm.getValue();
    const notes = prLiveNotes(prState.notes);
    // With `scale` on, the roll is being drawn IN that key, so it's written out in it: scale
    // degrees plus a `.sc(octave)`, which re-keys with the setscale line instead of freezing the
    // pitches that happened to be under the pencil. Off, the roll is chromatic and so is what
    // it converts to.
    const scale = prState.scaleFold && !prIndexMode() && prScaleInfo() ? patchScale : null;
    // Each destination gets the expression indented to ITS own line: one roll can be written into
    // several patterns, at whatever depth each of them sits.
    const exprAt = (at) => pianorollMod.pianoRollToMini(notes, {
      grid: prState.grid,
      len: prState.len,
      start: prState.start,
      indent: /^[ \t]*/.exec(code.slice(code.lastIndexOf('\n', at - 1) + 1))[0],
      scale,
      // Only decides which channel carries the RHYTHM where none of them differs from its default;
      // every channel the roll actually sets is written whichever axis it was drawn on.
      mode: prState.mode,
    });
    // Degrees can only name notes that are IN the key, so anything out of it lands on its nearest
    // neighbour - a real pitch change, and the one thing about this rewrite that isn't lossless.
    // Counted before the close, which drops the notes.
    // Muted notes aren't written out at all, so they can't be moved by the rounding either.
    const off = scale
      ? notes.filter((nt) => !nt.mute && prInLoop(nt.start) && notesMod.quantizeToScale(nt.midi, scale) !== nt.midi).length
      : 0;

    const id = prState.rollId;
    const edits = [];
    let played = 0;
    if (id) {
      const refuse = (why) => logLine(`can't convert roll "${id}" to mini-notation: ${why}`, true);
      const refs = rollDefs.refCalls(code, id);
      // A definition is not a place in a pattern, so with nothing naming it there is nowhere for
      // the notes to be written to.
      if (!refs.length) {
        return refuse(`no pattern in this buffer plays it - put pianoroll("${id}") in one first`);
      }
      // The name has to be the WHOLE of what the call says. Written among others - pianoroll("<lead
      // pad>") - the call is a pattern of names, and drawn notes can't take one name's turn inside
      // it; a modifier (`"lead*2"`) belongs to the call this would replace outright.
      const bare = refs.find((call) => call.str.trim().replace(/^<\s*|\s*>$/g, '') !== id);
      if (bare) {
        return refuse(`the pattern that plays it says "${bare.str.trim()}", and drawn notes can't take one name's `
          + 'turn inside that - take the roll out of it first');
      }
      for (const call of refs) edits.push([call.start, call.close + 1, exprAt(call.start)]);
      // Its definition goes with it: nothing names it now, and an unnamed definition is dead code
      // the picker would still offer.
      const def = rollDefs.defsInBuffer(code).find((d) => d.id === id);
      if (def) edits.push([...rollDefs.removalRange(code, def), '']);
      played = refs.length;
    } else {
      const from = cm.indexFromPos(range.from);
      edits.push([from, cm.indexFromPos(range.to), exprAt(from)]);
    }

    prSuppressCursor = true;
    applyEdits(edits);
    closePianorollEditor(); // the call the panel was anchored to is gone now
    prSuppressCursor = false;
    if (id) refoldAll(); // the definitions block lost a line - its chip has to be redrawn
    prScheduleEval(); // the rewrite plays the same notes - keep the running track in step with it
    const what = id
      ? `roll "${id}" → mini-notation in ${played} pattern${played === 1 ? '' : 's'}, and its definition is gone`
      : 'piano roll → mini-notation';
    if (!scale) logLine(what);
    else if (!off) logLine(`${what} (degrees in ${scale})`);
    else logLine(`${what} (degrees in ${scale}) - ${off} out-of-key note${off === 1 ? '' : 's'} moved to the nearest degree`, true);
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
    // Escape unwinds ONE layer at a time - the popover, then a rename in progress, then the panel.
    // It has to be decided here: this listener is capture phase, so a handler on the field itself
    // never gets the chance, and closing the whole roll because you changed your mind about the
    // name you were typing is not what the key means.
    if (e.key === 'Escape' && document.activeElement !== prCanvas) {
      if (!prPicker.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); prClosePicker(); return; }
      if (document.activeElement === prName) {
        e.preventDefault();
        e.stopPropagation();
        prName.value = prState.rollId ?? '';
        prName.blur();
        return;
      }
      closePianorollEditor();
      return;
    }
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

    const base = cm.indexFromPos(range.from);
    // A held slot is not playing its `.preset(...)` names - its plugin window is open, or the panel
    // has it - and the grid deliberately says nothing about that: a grid is computed in windows and
    // shipped ahead of the sound, while a hold comes and goes between them (see server.js's
    // patternSigs). Dropping those spans HERE is what lets a hold start and stop being drawn within
    // half a second instead of surviving until the next evaluation.
    const lit = heldRanges.length
      ? [...locs.values()].filter((l) => !inHeldRange(base + l[0], base + l[1]))
      : [...locs.values()];
    const key = lit.map((l) => `${l[0]}-${l[1]}`).sort().join(',');
    if (key === r.lastKey) continue; // same atoms still sounding - don't churn marks
    r.lastKey = key;
    for (const mk of r.marks) mk.clear();
    // Document-absolute copies of what is lit, so anything that needs to know WHICH atom is
    // sounding (the roll panel, following a pianoroll("<0 chorus>")) can read it off here rather
    // than re-deriving the grid.
    r.litSpans = lit.map((loc) => [base + loc[0], base + loc[1]]);
    r.marks = lit.map((loc) =>
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
  const block = blockForTrack(code, label);
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
// The mixer (ctrl+g, or settings → open mixer…). One modal: a strip per track - stereo meter,
// gain fader, pan knob, mute/solo - plus the spectrum (tilted, slow-release, with a freeze-max
// hold, the way a mastering analyzer reads) and a polar stereo image (angle is stereo position,
// radius is level - a mono track is a narrow vertical petal, a wide one a fan). Both plots
// switch between color-coded per-track and the summed master alone. Monitoring is engine-side
// (see server.js's mixer section): opening posts /api/mixer/monitor and the modal polls
// /api/mixer/status ~10x/sec, which doubles as the server's keep-alive.
//
// The controls WRITE CODE, not engine state: a fader gesture rewrites the block's trailing
// `.gain(x)` literal (or appends one - mixctl.mjs owns the edit) and re-evaluates on the same
// debounced update path the LFO editor uses, so what you hear is always what an eval of the
// buffer plays, and the mix survives in the pattern itself. .gain() chains multiply, which is
// what makes an appended literal a clean trim even over a patterned gain; a pan write replaces
// a patterned pan, which is what grabbing the knob means. Mute and solo write the label markers
// the language already has (`_bass:` / `Sbass:`) - which is why the strip list can't just be
// "what's playing": a track muted HERE must keep its strip (a strip that vanishes on mute could
// never be un-muted), so blocks silenced by mute or someone else's solo stay listed, metering
// silence. Only labels the last eval knew as tracks qualify, so a muted setup block never grows
// a strip.
// ---------------------------------------------------------------------------------------------

const mixerBackdrop = document.getElementById('mixerBackdrop');
const mixerStripsEl = document.getElementById('mixerStrips');
const mixerNoteEl = document.getElementById('mixerNote');
const mixerSpectrumCanvas = document.getElementById('mixerSpectrum');
const mixerSpatialCanvas = document.getElementById('mixerSpatial');
const mixerViewBtn = document.getElementById('mixerViewBtn');

const MIXER_POLL_MS = 100;
// The plots are redrawn at ~30fps, not at the display's rate: the analyzer sends 20 frames a
// second, so painting 60 (or 120, on a fast panel) is the same picture drawn twice for nothing -
// and this loop walks every band of every track through two canvases.
const MIXER_FRAME_MS = 32;
// Ballistics as TIME CONSTANTS rather than per-frame factors, so a 120Hz display doesn't decay
// everything twice as fast as a 60Hz one. Attack is near-instant, release is what makes a
// spectrum readable; the meters sit between the two.
const MIXER_TAU_ATTACK = 0.02;
const MIXER_TAU_RELEASE = 0.25;
const MIXER_TAU_METER_RMS = 0.13;
const MIXER_TAU_METER_PEAK = 0.2;
// dt -> the fraction of the remaining distance to close this frame, for a given time constant.
const mixerLerp = (dt, tau) => 1 - Math.exp(-dt / tau);
const MIXER_EVAL_DEBOUNCE_MS = 300; // one eval per gesture, same reasoning as LFO_EVAL_DEBOUNCE_MS
const MIXER_WRITE_THROTTLE_MS = 120; // code writes during a drag - the buffer re-lexes per write
const MIXER_METER_DB_MIN = -60;
const MIXER_METER_DB_MAX = 6;
// The fader's law: unity gain sits at 80% of the throw and the curve is gentle around it, like a
// console fader - linear-in-gain put the whole mix in the top centimetre.
const MIXER_FADER_UNITY = 0.8;
const MIXER_FADER_EXP = 2.5;
// Track colors, assigned first-seen per label so a track keeps its color across re-evals. Chosen
// to stay apart from each other on both dark and light themes.
const MIXER_PALETTE = [
  '#ff7a9c', '#63b4ff', '#7ed896', '#ffcb6b', '#c792ea', '#4dd0c4',
  '#f78c6c', '#82aaff', '#a5d98a', '#ff8fd8', '#e6c07b', '#7fd8f7',
];
const mixerColorByLabel = new Map();

// --- the spectrum's vertical scaling ---
//
// Display tilt, dB/octave around a 1kHz pivot, so program material reads roughly level instead
// of drooping to the right. The usual analyzer figure is 4.5, but that belongs to an FFT
// display, whose bins fall 3dB/oct on pink noise; a constant-Q filter bank like ours already
// reads pink as flat, so what we want is the difference between the two. Taking the 4.5 at face
// value is what buried the low end: it subtracts 15dB at 100Hz and 22dB at 35Hz.
const MIXER_SPEC_TILT_DB = 1.5;
// Makeup applied to every band before plotting. One narrow band of a full-scale mix holds a
// small slice of its total energy - pink noise at -12dBFS reads about -30dB in any one of these
// bands - so without this the whole curve hugs the floor no matter how loud the music is.
// Display-only, and a constant, so relative heights (the thing you actually read) are untouched.
// Sized to put that pink noise around two thirds up the plot, leaving room for the crest the
// followers add on real material: this is the number to nudge if the curve sits too low or pegs.
const MIXER_SPEC_MAKEUP_DB = 12;
// The plot's own dB window, wider than the strip meters': a spectrum wants to show what's
// happening well below the level a meter cares about.
const MIXER_SPEC_DB_MIN = -72;
const MIXER_SPEC_DB_MAX = 6;

let mixerState = null; // open modal: { strips: Map(label -> strip), order, bandFreqs, ... }
let mixerEvalTimer = null;
let mixerSuppressSync = false; // our own replaceRange must not bounce back through the code sync
let mixerSyncTimer = null;
let mixerViewMode = localStorage.getItem('poptart-mixer-view') === 'overall' ? 'overall' : 'tracks';
// Labels the last eval built as tracks, muted ones included (renderTracks records it). What
// qualifies a silenced block for a strip - see the section comment.
let mixerKnownTracks = [];
// The strip whose fader or pan knob is being held right now. While one is, the plots draw that
// track at full strength and everything else faded back, so you can see what you are moving in
// among the rest - the reason to have the plots and the controls on one panel at all.
//
// "Held" means held: a pointer focus ends on release, not when you next click something else.
// Clicking a range input also gives it DOM focus, so hanging this on focus/blur left the plots
// dimmed after the mouse was long gone. Keyboard focus is the one case that should persist -
// tab to a fader, arrow it, and the dimming stays until you tab away - so the two are told
// apart by which one started it.
let mixerFocus = null;
let mixerFocusFromPointer = false;

const mixerClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mixerDbOf = (amp) => 20 * Math.log10(Math.max(amp, 1e-6));
// dB onto 0..1 of the strip meters' range.
const mixerDbUnit = (db) => mixerClamp((db - MIXER_METER_DB_MIN) / (MIXER_METER_DB_MAX - MIXER_METER_DB_MIN), 0, 1);
// dB onto 0..1 of the spectrum plot's (wider) range.
const mixerSpecUnit = (db) => mixerClamp((db - MIXER_SPEC_DB_MIN) / (MIXER_SPEC_DB_MAX - MIXER_SPEC_DB_MIN), 0, 1);

// One band's measured values, as the engine lays them out (see MIX_SPEC_VALUES_PER_BAND):
// left, right, mid, side. Everything the plots show is derived here and nowhere else.
const bandL = (b) => b[0] ?? 0;
const bandR = (b) => b[1] ?? 0;
const bandMid = (b) => b[2] ?? 0;
const bandSide = (b) => b[3] ?? 0;
/** A band's level (mean of the two channels), as a linear amplitude. */
const bandAmp = (b) => (bandL(b) + bandR(b)) / 2;
const mixerFaderToGain = (v) => (v <= 0 ? 0 : (v / MIXER_FADER_UNITY) ** MIXER_FADER_EXP);
const mixerGainToFader = (g) => (g <= 0 ? 0 : mixerClamp(MIXER_FADER_UNITY * g ** (1 / MIXER_FADER_EXP), 0, 1));

function mixerColorFor(label) {
  if (!mixerColorByLabel.has(label)) {
    mixerColorByLabel.set(label, MIXER_PALETTE[mixerColorByLabel.size % MIXER_PALETTE.length]);
  }
  return mixerColorByLabel.get(label);
}

function mixerFmtDb(gain) {
  if (gain <= 0) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

// The two knobs under each fader, in signal order (width happens before pan on the channel
// strip, so it sits to the left of it). Each maps its control's value onto the knob's 0..1
// throw and back; both draw as an arc from the middle, which is each one's neutral.
// Bass mono: the cutoff the button switches on to, and the range it drags over. 120Hz is the
// conventional starting point for monoing a low end. Below ~20Hz there is nothing to collapse;
// above ~500 you are monoing the instruments, not the bass.
const MIXER_BASSMONO_DEFAULT = 120;
const MIXER_BASSMONO_MIN = 20;
const MIXER_BASSMONO_MAX = 500;

const MIXER_KNOBS = [
  {
    name: 'width',
    def: 1,
    // Unity at the CENTRE of the throw - 0..1 over the left half, 1..4 over the right - so the
    // half-turn either side of "leave it alone" is where the resolution goes. A plain linear
    // 0..400% taper would spend three quarters of the knob above unity.
    posOf: (v) => (v <= 1 ? v * 0.5 : 0.5 + (v - 1) / 6),
    valueAt: (p) => (p <= 0.5 ? p * 2 : 1 + (p - 0.5) * 6),
    format: (v) => `${Math.round(v * 100)}%`,
    title: 'width — 0 mono, 100% untouched, up to 400%; drag, double-click to reset. Writes .width(x)',
    patternedTitle: 'width is patterned in the code - grabbing the knob writes a .width(x) that takes over',
  },
  {
    name: 'pan',
    def: 0,
    posOf: (v) => (v + 1) / 2,
    valueAt: (p) => p * 2 - 1,
    format: (v) => mixerFmtPan(v),
    title: 'pan — drag, double-click to center. Writes .pan(x)',
    patternedTitle: 'pan is patterned in the code - grabbing the knob writes a .pan(x) that takes over',
  },
];

// The bass-mono button says what it is doing rather than just whether it is on - the cutoff is
// the whole decision, and it is the thing you drag.
function updateMixerBassBtn(strip) {
  const on = strip.bassmono > 0;
  strip.bassBtn.textContent = on ? `▽ ${strip.bassmono}` : '▽ mono';
  strip.bassBtn.classList.toggle('on-bass', on);
  strip.bassBtn.title = on
    ? `bass mono: everything below ${strip.bassmono} Hz is centred, the width above it is kept. `
      + 'Click to switch off, drag left/right for the cutoff. Writes .bassmono(hz)'
    : 'bass mono — collapse the low end to mono, keeping the width above the cutoff. '
      + 'Click to switch on, drag left/right for the cutoff. Writes .bassmono(hz)';
}

function mixerFmtPan(pan) {
  const p = Math.round(pan * 100);
  return p === 0 ? 'C' : p < 0 ? `L${-p}` : `R${p}`;
}

function toggleMixer() {
  if (mixerState) closeMixer();
  else openMixer();
}

async function openMixer() {
  if (mixerState) return;
  mixerBackdrop.classList.remove('hidden');
  mixerState = {
    strips: new Map(),
    order: [], // strip labels in code order - the palette walk and the draw order
    serverTracks: [], // what the engine says is playing, as of the last poll
    bandFreqs: [],
    masterDisp: null, // smoothed master band frame, [[l, r], ...]
    masterTarget: null,
    freeze: false, // spectrum freeze-max hold (the button on the plot)
    freezeMax: new Map(), // key ('*' or label) -> per-band max amp accumulated while frozen
    pollTimer: 0,
    raf: 0,
    lastArmAt: 0, // last re-POST of monitor-on, so a dead engine isn't spammed at poll rate
    monitorError: null,
  };
  updateMixerViewBtn();
  updateMixerFreezeBtn();
  sizeMixerCanvases();
  try {
    await api('POST', '/api/mixer/monitor', { on: true });
  } catch (e) {
    // Strips (built from the buffer) and their controls still work; only the meters stay dark.
    if (mixerState) mixerState.monitorError = e.message ?? String(e);
  }
  if (!mixerState) return; // closed again before the POST came back
  mixerPoll().catch(() => {});
  mixerState.pollTimer = setInterval(() => mixerPoll().catch(() => {}), MIXER_POLL_MS);
  const loop = () => {
    if (!mixerState) return;
    mixerState.raf = requestAnimationFrame(loop);
    const now = performance.now();
    const since = now - (mixerState.lastDrawAt ?? 0);
    if (since < MIXER_FRAME_MS) return;
    mixerState.lastDrawAt = now;
    // Capped: a tab that was hidden (or a stalled frame) must not hand the ballistics a
    // multi-second step and snap every meter to its target at once.
    drawMixer(Math.min(since / 1000, 0.25));
  };
  mixerState.raf = requestAnimationFrame(loop);
}

function closeMixer() {
  if (!mixerState) return;
  clearInterval(mixerState.pollTimer);
  cancelAnimationFrame(mixerState.raf);
  mixerState = null;
  mixerBackdrop.classList.add('hidden');
  api('POST', '/api/mixer/monitor', { on: false }).catch(() => {}); // server auto-offs anyway
}

function updateMixerViewBtn() {
  mixerViewBtn.textContent = mixerViewMode === 'tracks' ? 'by track' : 'overall';
}

// The plots take their bitmap size from their laid-out size, at device resolution; drawing code
// works in CSS pixels via the transform.
function sizeMixerCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [mixerSpectrumCanvas, mixerSpatialCanvas]) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    c.dataset.w = r.width;
    c.dataset.h = r.height;
  }
}

// --- polling: track list, meter readings, band frames ---

async function mixerPoll() {
  if (!mixerState) return;
  const s = await api('GET', '/api/mixer/status');
  if (!mixerState) return;
  // The server flags off when the engine restarted under it (or our first arm failed) - re-arm,
  // gently. While the engine is down this fails and the note below says so.
  if (!s.on && Date.now() - mixerState.lastArmAt > 1000) {
    mixerState.lastArmAt = Date.now();
    api('POST', '/api/mixer/monitor', { on: true })
      .then(() => { if (mixerState) mixerState.monitorError = null; })
      .catch((e) => { if (mixerState) mixerState.monitorError = e.message ?? String(e); });
  } else if (s.on) {
    mixerState.monitorError = null;
  }
  if (s.bandFreqs?.length) mixerState.bandFreqs = s.bandFreqs;

  mixerState.serverTracks = s.tracks ?? [];
  refreshMixerStrips();

  for (const strip of mixerState.strips.values()) {
    const batch = s.levels?.[strip.label] ?? [];
    const m = strip.meter;
    m.tPeakL = 0; m.tRmsL = 0; m.tPeakR = 0; m.tRmsR = 0;
    for (const r of batch) {
      m.tPeakL = Math.max(m.tPeakL, r.peakL); m.tRmsL = Math.max(m.tRmsL, r.rmsL);
      m.tPeakR = Math.max(m.tPeakR, r.peakR); m.tRmsR = Math.max(m.tRmsR, r.rmsR);
    }
    strip.bandTarget = s.spec?.[strip.label] ?? null;
    if (mixerState.freeze) accumMixerFreeze(strip.label, strip.bandTarget);
  }
  mixerState.masterTarget = s.spec?.['*'] ?? null;
  if (mixerState.freeze) accumMixerFreeze('*', mixerState.masterTarget);

  mixerNoteEl.textContent =
    !mixerState.order.length ? 'nothing playing — evaluate a pattern and its tracks appear here'
    : mixerState.monitorError ? `meters offline: ${mixerState.monitorError}`
    : '';
}

// The freeze hold accumulates from the RAW 15Hz frames, not the smoothed display, so a one-frame
// transient leaves its true mark - the point of the hold.
function accumMixerFreeze(key, frame) {
  if (!frame) return;
  let arr = mixerState.freezeMax.get(key);
  if (!arr || arr.length !== frame.length) {
    arr = new Array(frame.length).fill(0);
    mixerState.freezeMax.set(key, arr);
  }
  for (let i = 0; i < frame.length; i++) arr[i] = Math.max(arr[i], bandAmp(frame[i]));
}

// --- strips ---

// Which labels get a strip: every block the last eval knew as a track (mixerKnownTracks - which
// includes the muted ones, so a setup or definitions block never grows a strip), plus anything
// the engine currently reports playing.
//
// Deliberately NOT "what is playing, plus what the code has silenced". That was the same list
// most of the time and wrong for half a second at the worst moment: the server's playing set
// lags a mute/solo edit by the debounce plus a poll, so un-soloing showed the solo's single
// track until the re-eval landed and every other strip blinked out and back. Membership tracks
// the CODE, which changes the instant you click; only the dimming below reads the engine.
function mixerStripLabels() {
  const playing = mixerState.serverTracks;
  const blocks = labelsMod ? labelsMod.splitLabeledBlocks(cm.getValue()) : [];
  const known = new Set([...mixerKnownTracks, ...playing]);
  const inStrip = new Set(playing);
  for (const b of blocks) if (known.has(b.label)) inStrip.add(b.label);
  const codeOrder = blocks.map((b) => b.label);
  const pos = (l) => { const i = codeOrder.indexOf(l); return i < 0 ? codeOrder.length : i; };
  return [...inStrip].sort((a, b) => pos(a) - pos(b));
}

// Recompute the strip list, rebuild the row only when it actually changed, and re-read the
// code's values into the controls. Called from every poll and (debounced) from every buffer
// edit - but the code-derived work re-runs only when the buffer or the server's track list
// moved, keyed on CodeMirror's change generation, so an idle open mixer costs the polls alone.
function refreshMixerStrips() {
  const gen = cm.changeGeneration();
  const tracksKey = mixerState.serverTracks.join('\n');
  if (gen === mixerState.codeGen && tracksKey === mixerState.tracksKey) return;
  mixerState.codeGen = gen;
  mixerState.tracksKey = tracksKey;
  const labels = mixerStripLabels();
  if (labels.join('\n') !== mixerState.order.join('\n')) {
    const kept = mixerState.strips;
    mixerState.strips = new Map();
    mixerState.order = labels;
    mixerStripsEl.innerHTML = '';
    for (const label of labels) {
      const strip = kept.get(label) ?? buildMixerStrip(label);
      mixerState.strips.set(label, strip);
      mixerStripsEl.appendChild(strip.el);
    }
  }
  syncMixerFromCode();
}

function buildMixerStrip(label) {
  const dpr = window.devicePixelRatio || 1;
  const color = mixerColorFor(label);
  const el = document.createElement('div');
  el.className = 'mixer-strip';

  // The name row IS the plots' legend: the swatch is the colour that track draws in, right next
  // to the controls that move it. (A separate legend row said the same thing twice.) The swatch
  // carries the colour rather than the text, so the label stays readable on light themes where
  // the lighter palette entries wash out.
  const name = document.createElement('div');
  name.className = 'mixer-strip-name';
  name.title = label;
  const swatch = document.createElement('span');
  swatch.className = 'mixer-strip-swatch';
  swatch.style.background = color;
  const nameText = document.createElement('span');
  nameText.className = 'mixer-strip-name-text';
  nameText.textContent = label;
  name.append(swatch, nameText);

  const msRow = document.createElement('div');
  msRow.className = 'mixer-strip-ms';
  const muteBtn = document.createElement('button');
  muteBtn.className = 'small mixer-ms-btn';
  muteBtn.textContent = 'M';
  const soloBtn = document.createElement('button');
  soloBtn.className = 'small mixer-ms-btn';
  soloBtn.textContent = 'S';
  msRow.append(muteBtn, soloBtn);

  const body = document.createElement('div');
  body.className = 'mixer-strip-body';
  const fader = document.createElement('input');
  fader.type = 'range';
  fader.className = 'mixer-fader';
  fader.min = 0; fader.max = 1000; fader.step = 1;
  fader.title = 'gain — writes .gain(x) onto this block';
  const meterCanvas = document.createElement('canvas');
  meterCanvas.className = 'mixer-meter';
  meterCanvas.width = 26 * dpr; meterCanvas.height = 140 * dpr;
  meterCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  body.append(fader, meterCanvas);

  const dbLabel = document.createElement('div');
  dbLabel.className = 'mixer-db';

  const knobRow = document.createElement('div');
  knobRow.className = 'mixer-knob-row';
  const knobLabelRow = document.createElement('div');
  knobLabelRow.className = 'mixer-knob-labels';
  const knobs = new Map();
  for (const spec of MIXER_KNOBS) {
    const canvas = document.createElement('canvas');
    canvas.className = 'mixer-knob';
    canvas.width = 30 * dpr; canvas.height = 30 * dpr;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.title = spec.title;
    const valueEl = document.createElement('div');
    valueEl.className = 'mixer-knob-label';
    knobRow.appendChild(canvas);
    knobLabelRow.appendChild(valueEl);
    knobs.set(spec.name, { spec, canvas, valueEl, value: spec.def, drag: null });
  }

  const bassBtn = document.createElement('button');
  bassBtn.className = 'small mixer-bass-btn';

  el.append(name, msRow, body, dbLabel, knobRow, knobLabelRow, bassBtn);

  const strip = {
    label, color, el, fader, meterCanvas, dbLabel, knobs, muteBtn, soloBtn, bassBtn,
    gain: 1, gone: false, muted: false, soloed: false,
    bassmono: 0, // Hz, 0 = off
    bassLastHz: MIXER_BASSMONO_DEFAULT, // what the button switches back on to
    dragBass: null,
    dragGain: false,
    writeTimer: {}, pendingWrite: {},
    meter: { tPeakL: 0, tRmsL: 0, tPeakR: 0, tRmsR: 0, rmsL: 0, rmsR: 0, peakL: 0, peakR: 0, holdL: 0, holdR: 0, holdAtL: 0, holdAtR: 0 },
    bandTarget: null,
    bandDisp: null, // smoothed [[l, r, mid, side], ...], grown lazily to bandFreqs' length
  };

  muteBtn.addEventListener('click', () => applyMixerFlags(strip, { muted: !strip.muted, soloed: strip.soloed }));
  soloBtn.addEventListener('click', () => applyMixerFlags(strip, { muted: strip.muted, soloed: !strip.soloed }));

  fader.addEventListener('input', () => {
    const gain = mixerFaderToGain(fader.value / 1000);
    strip.gain = gain;
    dbLabel.textContent = mixerFmtDb(gain);
    // Arrow keys raise `input` too, with no pointer and so no hold - those take the code path.
    mixerDragValue(strip, 'gain', gain);
  });
  // Pointer grabs are released by the window-level handler below (a drag can end anywhere), so
  // all this does is take the focus and arm the hold. Arrow keys take the focus too, and only
  // that kind survives to the blur - see mixerFocusFromPointer.
  fader.addEventListener('pointerdown', () => {
    strip.dragGain = true;
    mixerFocus = label;
    mixerFocusFromPointer = true;
    armMixerHold(strip, 'gain');
  });
  fader.addEventListener('keydown', () => {
    mixerFocus = label;
    mixerFocusFromPointer = false;
  });
  fader.addEventListener('blur', () => {
    if (!mixerFocusFromPointer && mixerFocus === label) mixerFocus = null;
  });
  // Double-click back to unity, matching the pan knob's reset gesture.
  fader.addEventListener('dblclick', () => {
    strip.gain = 1;
    fader.value = Math.round(mixerGainToFader(1) * 1000);
    dbLabel.textContent = mixerFmtDb(1);
    queueMixerWrite(strip, 'gain', 1);
  });

  // Bass mono: click toggles it, drag left/right sets the cutoff (and switches it on if it was
  // off, since dragging a frequency you can't hear yet is never what you meant). One control
  // instead of a switch plus a slider, because a strip is 76px wide.
  const setBass = (hz) => {
    strip.bassmono = hz > 0 ? Math.round(hz) : 0;
    if (strip.bassmono > 0) strip.bassLastHz = strip.bassmono;
    updateMixerBassBtn(strip);
    mixerDragValue(strip, 'bassmono', strip.bassmono);
  };
  bassBtn.addEventListener('pointerdown', (e) => {
    if (strip.gone) return;
    bassBtn.setPointerCapture(e.pointerId);
    strip.dragBass = { x: e.clientX, hz: strip.bassmono || strip.bassLastHz, moved: false };
    mixerFocus = label;
    mixerFocusFromPointer = true;
    // Armed for the click-toggle as well as the drag: endBass runs on this button's own pointerup,
    // before the window release below, so a toggle is held (and therefore heard) exactly like a
    // drag's last value and written by the same release.
    armMixerHold(strip, 'bassmono');
  });
  bassBtn.addEventListener('pointermove', (e) => {
    const d = strip.dragBass;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return; // still a click, not a drag
    d.moved = true;
    // Exponential, so the drag feels the same at 30Hz as at 300.
    setBass(mixerClamp(d.hz * Math.exp(dx * 0.006), MIXER_BASSMONO_MIN, MIXER_BASSMONO_MAX));
  });
  const endBass = () => {
    const d = strip.dragBass;
    strip.dragBass = null;
    if (d && !d.moved) setBass(strip.bassmono > 0 ? 0 : strip.bassLastHz); // a plain click toggles
  };
  bassBtn.addEventListener('pointerup', endBass);
  bassBtn.addEventListener('pointercancel', endBass);

  for (const knob of knobs.values()) {
    const { spec, canvas, valueEl } = knob;
    const set = (value) => {
      knob.value = Math.round(value * 100) / 100;
      valueEl.textContent = spec.format(knob.value);
      mixerDragValue(strip, spec.name, knob.value);
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (strip.gone) return;
      canvas.setPointerCapture(e.pointerId);
      knob.drag = { x: e.clientX, y: e.clientY, pos: spec.posOf(knob.value) };
      mixerFocus = label;
      mixerFocusFromPointer = true;
      armMixerHold(strip, spec.name);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!knob.drag) return;
      const d = knob.drag;
      // Right and up both turn it up, so either gesture works without thinking about it.
      const pos = mixerClamp(d.pos + (e.clientX - d.x - (e.clientY - d.y)) * 0.004, 0, 1);
      set(spec.valueAt(pos));
    });
    // The window handler above covers the release; this is the local pair for a captured pointer.
    const end = () => { knob.drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', () => {
      if (!strip.gone) set(spec.def);
    });
  }

  return strip;
}

// --- the code writes ---

// One trailing write per control per throttle window: replaceRange re-lexes the buffer, and a
// drag emits input events far faster than the code needs to move.
function queueMixerWrite(strip, name, value) {
  strip.pendingWrite[name] = value;
  if (strip.writeTimer[name]) return;
  strip.writeTimer[name] = setTimeout(() => {
    strip.writeTimer[name] = null;
    const v = strip.pendingWrite[name];
    strip.pendingWrite[name] = null;
    if (v != null) applyMixerTrim(strip.label, name, v);
  }, MIXER_WRITE_THROTTLE_MS);
}

function applyMixerTrim(label, name, value) {
  if (!mixctlMod) return false;
  const code = cm.getValue();
  const edit = mixctlMod.trimEdit(code, label, name, mixctlMod.formatTrim(value));
  if (!edit) {
    logLine(`mixer: couldn't find a block "${label}" to write .${name}() into - re-evaluate and try again`, true);
    return false;
  }
  mixerSuppressSync = true;
  try {
    cm.replaceRange(edit.text, cm.posFromIndex(edit.from), cm.posFromIndex(edit.to));
  } finally {
    mixerSuppressSync = false;
  }
  mixerScheduleEval();
  return true;
}

// --- live audition: holding a control while it is dragged ---
//
// A trim only *sounds* once it has been written into the code and the buffer evaluated - and the
// eval is debounced, which a moving fader keeps resetting - so riding one used to be silent until
// you let go. Instead a drag posts its value straight to the engine, which holds the channel control
// there while everything else carries on playing (see Scheduler#holdChannel), and the code is
// written once, on release. Both halves of what a mixer wants: the buffer stops being rewritten
// mid-gesture, and you hear what your hand is doing while you do it.
//
// A control the code modulates natively (.gain(env()), .pan(sine(...))) keeps the old path. The
// engine runs those from a control bus MAPPED onto the channel strip, and holding a scalar there
// would unmap the bus and kill the modulation until the next eval. mixctl's `patterned` read is the
// guard: a superset of the native case, so a Tier-1 pattern falls back too - which costs it nothing,
// since writing and evaluating is what it did before.
let mixerHold = null; // { label, name, value, postedAt } while a control is held, else null
const MIXER_HOLD_POST_MS = 30; // the scheduler's own poll interval - posting faster is wasted

/** Can this control be auditioned live, or does the code modulate it natively? */
function mixerHoldable(label, name) {
  if (!mixctlMod) return false;
  const trim = mixctlMod.readTrim(cm.getValue(), label, name); // null when the block isn't in the buffer
  return !!trim && !trim.patterned;
}

// Arms a hold for the control a pointer just grabbed. Nothing is posted yet: a click that never
// moves (and the two of a double-click reset) should write no code and evaluate nothing, so the
// hold only goes live on the first value the drag produces.
function armMixerHold(strip, name) {
  // A second pointer arriving mid-drag (touch, mostly): finish the first gesture properly rather
  // than dropping the value it was holding. Safe to leave running - it takes the old hold and
  // clears `mixerHold` before its first await, so what we assign below is untouched by it.
  if (mixerHold?.value != null) releaseMixerHold().catch(() => {});
  mixerHold = strip.gone || !mixerHoldable(strip.label, name) ? null : { label: strip.label, name, value: null, postedAt: 0 };
}

// One new value from a drag: into the engine if this control holds, into the code if it doesn't.
// Throttled, since a pointermove stream runs far ahead of what the engine can use.
function mixerDragValue(strip, name, value) {
  if (mixerHold?.label !== strip.label || mixerHold?.name !== name) {
    queueMixerWrite(strip, name, value); // not held: write the code and let the eval debounce
    return;
  }
  const first = mixerHold.value == null;
  mixerHold.value = value;
  const now = performance.now();
  if (!first && now - mixerHold.postedAt < MIXER_HOLD_POST_MS) return;
  mixerHold.postedAt = now;
  const held = mixerHold;
  api('POST', '/api/channelHold', { trackId: held.label, name, value }).then((r) => {
    // Refused - the control became natively modulated between the grab and now. Drop the hold so
    // the rest of the drag writes code instead, which is the path that can express a modulator.
    if (r?.why && mixerHold === held) {
      mixerHold = null;
      queueMixerWrite(strip, name, value);
    }
  }).catch(() => {});
}

// Release. The code write and its evaluation happen once, here - and the control is handed back only
// AFTER that eval has landed. Release first and the scheduler's next poll would put the code's old
// value back for the length of a round trip, which is an audible jump at the end of every gesture.
// The debounce is skipped rather than waited out: letting go IS the moment this wanted to sound.
async function releaseMixerHold() {
  const held = mixerHold;
  mixerHold = null; // before any await, so a drag starting now gets a hold of its own
  if (!held || held.value == null) return; // never moved: nothing was posted, nothing to write
  try {
    if (applyMixerTrim(held.label, held.name, held.value)) {
      clearTimeout(mixerEvalTimer);
      mixerEvalTimer = null;
      await evaluate(false);
    }
  } finally {
    // Handed back even if the write or the eval threw. A hold nobody releases is a track stuck at
    // the level your hand was at until the lease times out - a worse failure than the one above.
    api('POST', '/api/channelHold', { trackId: held.label, name: held.name, value: null }).catch(() => {});
  }
}

// Mute/solo rewrite the block's label marker (`_bass:` / `Sbass:`) - the same switch you'd type.
function applyMixerFlags(strip, flags) {
  if (!mixctlMod || strip.gone) return;
  const edit = mixctlMod.flagEdit(cm.getValue(), strip.label, flags);
  if (!edit) {
    logLine(`mixer: "${strip.label}" has no label to mark - name the block to mute/solo it here`, true);
    return;
  }
  mixerSuppressSync = true;
  try {
    cm.replaceRange(edit.text, cm.posFromIndex(edit.from), cm.posFromIndex(edit.to));
  } finally {
    mixerSuppressSync = false;
  }
  refreshMixerStrips(); // the buttons (and possibly the strip list) change right away
  mixerScheduleEval();
}

// A trim isn't set until it *sounds*: same debounced evaluate(false) the LFO editor uses - a
// stopped clock stays stopped, a running one picks the new level up.
function mixerScheduleEval() {
  clearTimeout(mixerEvalTimer);
  mixerEvalTimer = setTimeout(() => { mixerEvalTimer = null; evaluate(false); }, MIXER_EVAL_DEBOUNCE_MS);
}

// The reverse direction: hand edits to the buffer move the faders and the mute/solo lights, so
// the mixer never reverts a value someone typed. Controls mid-drag are left alone.
function syncMixerFromCode() {
  if (!mixerState || !mixctlMod) return;
  const code = cm.getValue();
  const ctx = mixctlMod.analyze(code); // one lex serves every strip's reads below
  // "Silenced" is read off the CODE, not off the engine's playing set: the code is what the
  // buttons just changed, and the engine is a debounce and a poll behind it. Reading the engine
  // here dimmed every name for half a second after each mute, and all of them whenever the
  // engine was between evals.
  const anySolo = ctx.blocks.some((b) => b.soloed && !b.muted);
  for (const strip of mixerState.strips.values()) {
    const gain = mixctlMod.readTrim(code, strip.label, 'gain', undefined, ctx);
    const block = ctx.blocks.find((b) => b.label === strip.label);
    strip.gone = !gain;
    strip.silent = !!block && (block.muted || (anySolo && !block.soloed));
    strip.el.classList.toggle('mixer-strip-gone', strip.gone);
    strip.el.classList.toggle('mixer-strip-silent', strip.silent);
    strip.fader.disabled = strip.gone;
    strip.muted = block?.muted ?? false;
    strip.soloed = block?.soloed ?? false;
    const canFlag = !strip.gone && !!mixctlMod.flagEdit(code, strip.label, {}, ctx);
    strip.muteBtn.disabled = !canFlag;
    strip.soloBtn.disabled = !canFlag;
    strip.muteBtn.classList.toggle('on-mute', strip.muted);
    strip.soloBtn.classList.toggle('on-solo', strip.soloed);
    strip.muteBtn.title = canFlag
      ? `mute — writes the _ marker on this block's label${strip.muted ? ' (on)' : ''}`
      : 'name the block to mute it here';
    strip.soloBtn.title = canFlag
      ? `solo — writes the S marker on this block's label${strip.soloed ? ' (on)' : ''}`
      : 'name the block to solo it here';
    if (strip.gone) {
      strip.el.title = `"${strip.label}" is playing but isn't in the buffer any more - its controls are off`;
      continue;
    }
    strip.el.title = '';
    if (!strip.dragGain && !strip.writeTimer.gain) {
      strip.gain = gain.value;
      strip.fader.value = Math.round(mixerGainToFader(gain.value) * 1000);
      strip.dbLabel.textContent = mixerFmtDb(gain.value);
    }
    // A patterned control keeps modulating under the trim - say so rather than lying flat.
    strip.fader.classList.toggle('mixer-patterned', gain.patterned);
    strip.fader.title = gain.patterned
      ? 'gain is patterned in the code - the fader writes a trim that multiplies it'
      : 'gain — writes .gain(x) onto this block';
    const bass = mixctlMod.readTrim(code, strip.label, 'bassmono', undefined, ctx);
    if (!strip.dragBass && !strip.writeTimer.bassmono) {
      strip.bassmono = Math.round(bass.value);
      if (strip.bassmono > 0) strip.bassLastHz = strip.bassmono;
      updateMixerBassBtn(strip);
    }
    strip.bassBtn.disabled = strip.gone;
    strip.bassBtn.classList.toggle('mixer-patterned', bass.patterned);
    for (const knob of strip.knobs.values()) {
      const read = mixctlMod.readTrim(code, strip.label, knob.spec.name, undefined, ctx);
      if (!knob.drag && !strip.writeTimer[knob.spec.name]) {
        knob.value = read.value;
        knob.valueEl.textContent = knob.spec.format(read.value);
      }
      knob.canvas.classList.toggle('mixer-patterned', read.patterned);
      knob.canvas.title = read.patterned ? knob.spec.patternedTitle : knob.spec.title;
    }
  }
}

// Highlight the strip whose control is being held, and fade the others - the strips ARE the
// legend (each carries its colour swatch and name), so this is the same information the plots
// are showing without a second row of chips to read. Only touches the DOM when the focus
// actually changed; this runs every animation frame.
function syncMixerStripFocus() {
  if (mixerState.stripFocus === mixerFocus) return;
  mixerState.stripFocus = mixerFocus;
  for (const strip of mixerState.strips.values()) {
    strip.el.classList.toggle('mixer-strip-focus', mixerFocus === strip.label);
    strip.el.classList.toggle('mixer-strip-unfocused', !!mixerFocus && mixerFocus !== strip.label);
  }
}

function scheduleMixerSync() {
  if (!mixerState || mixerSuppressSync) return;
  clearTimeout(mixerSyncTimer);
  mixerSyncTimer = setTimeout(() => {
    mixerSyncTimer = null;
    if (mixerState) refreshMixerStrips(); // an edit can silence/unsilence a block, not just retune it
  }, 200);
}

// --- drawing ---

function drawMixer(dt) {
  const css = getComputedStyle(document.documentElement);
  const colors = {
    text: css.getPropertyValue('--text').trim() || '#ccc',
    dim: css.getPropertyValue('--text-dim').trim() || '#888',
    grid: css.getPropertyValue('--border').trim() || '#333',
    accent: css.getPropertyValue('--accent').trim() || '#6cf',
    err: css.getPropertyValue('--err').trim() || '#f66',
  };
  for (const strip of mixerState.strips.values()) {
    stepStripMeter(strip, dt);
    strip.bandDisp = stepBandFrame(strip.bandDisp, strip.bandTarget, dt);
    drawStripMeter(strip, colors);
    for (const knob of strip.knobs.values()) drawMixerKnob(strip, knob, colors);
  }
  mixerState.masterDisp = stepBandFrame(mixerState.masterDisp, mixerState.masterTarget, dt);
  syncMixerStripFocus();
  drawMixerSpectrum(colors);
  drawMixerSpatial(colors);
}

// Meter ballistics: instant attack, exponential release, and a peak-hold line that sits for a
// second before falling - the usual meter grammar, so it reads like every other meter.
function stepStripMeter(strip, dt) {
  const m = strip.meter;
  const now = performance.now();
  const fallRms = Math.exp(-dt / MIXER_TAU_METER_RMS);
  const fallPeak = Math.exp(-dt / MIXER_TAU_METER_PEAK);
  m.rmsL = Math.max(m.tRmsL, m.rmsL * fallRms);
  m.rmsR = Math.max(m.tRmsR, m.rmsR * fallRms);
  m.peakL = Math.max(m.tPeakL, m.peakL * fallPeak);
  m.peakR = Math.max(m.tPeakR, m.peakR * fallPeak);
  if (m.tPeakL >= m.holdL) { m.holdL = m.tPeakL; m.holdAtL = now; }
  else if (now - m.holdAtL > 1000) m.holdL *= 0.9;
  if (m.tPeakR >= m.holdR) { m.holdR = m.tPeakR; m.holdAtR = now; }
  else if (now - m.holdAtR > 1000) m.holdR *= 0.9;
}

// Smooth one band frame toward its target: fast up, slow down - the analyzer ballistics that
// make a peak register while keeping the fall readable (release time-constant ~0.25s), so the
// curve holds still long enough to read instead of flickering at the analyzer's frame rate.
// Returns the (possibly re-grown) display frame.
const MIXER_BAND_VALUES = 4; // l, r, mid, side - what the engine sends per band

function stepBandFrame(disp, target, dt) {
  const n = mixerState.bandFreqs.length;
  if (!n) return null;
  if (!disp || disp.length !== n) disp = Array.from({ length: n }, () => new Array(MIXER_BAND_VALUES).fill(0));
  const rise = mixerLerp(dt, MIXER_TAU_ATTACK);
  const fall = mixerLerp(dt, MIXER_TAU_RELEASE);
  for (let i = 0; i < n; i++) {
    const t = target?.[i];
    for (let ch = 0; ch < MIXER_BAND_VALUES; ch++) {
      const cur = disp[i][ch];
      const tgt = t?.[ch] ?? 0;
      disp[i][ch] = cur + (tgt - cur) * (tgt > cur ? rise : fall);
    }
  }
  return disp;
}

function drawStripMeter(strip, colors) {
  const ctx = strip.meterCanvas.getContext('2d');
  const w = 26, h = 140;
  ctx.clearRect(0, 0, w, h);
  const m = strip.meter;
  const barW = 10, gap = 2;
  const yOf = (amp) => h - mixerDbUnit(mixerDbOf(amp)) * h;
  const zeroY = h - mixerDbUnit(0) * h;
  const bars = [
    { x: (w - barW * 2 - gap) / 2, rms: m.rmsL, peak: m.peakL, hold: m.holdL },
    { x: (w - barW * 2 - gap) / 2 + barW + gap, rms: m.rmsR, peak: m.peakR, hold: m.holdR },
  ];
  for (const b of bars) {
    ctx.fillStyle = rgbaFrom(ctx, colors.grid, 0.5);
    ctx.fillRect(b.x, 0, barW, h);
    const py = yOf(b.peak);
    ctx.fillStyle = rgbaFrom(ctx, strip.color, 0.35);
    ctx.fillRect(b.x, py, barW, h - py);
    const ry = yOf(b.rms);
    ctx.fillStyle = rgbaFrom(ctx, strip.color, 0.95);
    ctx.fillRect(b.x, ry, barW, h - ry);
    // Anything over 0 dBFS paints the overshoot in the error color - that's the readout to act on.
    if (py < zeroY) {
      ctx.fillStyle = rgbaFrom(ctx, colors.err, 0.9);
      ctx.fillRect(b.x, py, barW, zeroY - py);
    }
    if (b.hold > 0.001) {
      const hy = yOf(b.hold);
      ctx.fillStyle = b.hold > 1 ? colors.err : colors.text;
      ctx.fillRect(b.x, hy - 1, barW, 1.5);
    }
  }
  // The 0 dB line across both bars.
  ctx.fillStyle = rgbaFrom(ctx, colors.dim, 0.6);
  ctx.fillRect(bars[0].x - 2, zeroY, barW * 2 + gap + 4, 1);
}

// One knob: a track around the dial, the travelled arc from the middle (each control's neutral)
// filled in the track's colour, and a pointer. Both knobs are the same shape because both are
// "how far either side of neutral" questions.
function drawMixerKnob(strip, knob, colors) {
  const ctx = knob.canvas.getContext('2d');
  const s = 30, cx = s / 2, cy = s / 2, r = 11;
  ctx.clearRect(0, 0, s, s);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const pos = mixerClamp(knob.spec.posOf(knob.value), 0, 1);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgbaFrom(ctx, colors.grid, 0.9);
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
  const mid = (a0 + a1) / 2;
  const at = a0 + pos * (a1 - a0);
  ctx.strokeStyle = strip.color;
  ctx.beginPath();
  if (at >= mid) ctx.arc(cx, cy, r, mid, at);
  else ctx.arc(cx, cy, r, at, mid);
  ctx.stroke();
  ctx.strokeStyle = colors.text;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(at) * 4, cy + Math.sin(at) * 4);
  ctx.lineTo(cx + Math.cos(at) * r, cy + Math.sin(at) * r);
  ctx.stroke();
}

// --- what one band means ---

/** A band's height on the plots: its level in dB, made up and clamped to the plot window. */
function mixerBandLevel(b) {
  return mixerSpecUnit(mixerDbOf(bandAmp(b)) + MIXER_SPEC_MAKEUP_DB);
}

/** Left/right balance, -1..1: the L/R power ratio. Which SIDE the band sits on. */
function mixerBandPan(b) {
  const l = bandL(b), r = bandR(b);
  const p = l * l + r * r;
  return p < 1e-12 ? 0 : mixerClamp((r * r - l * l) / p, -1, 1);
}

/**
 * The band's goniometer angle as a signed fraction of 90°, which is what the stereo image plots.
 *
 * A goniometer's angle is the mid/side ratio, not the pan pot's number: mono content (no side)
 * points straight up at 0, a hard-panned band has |mid| = |side| and sits at ±45° - the
 * goniometer's long-standing "safe lines", where channel correlation crosses zero (r = cos 2θ,
 * so 45° is exactly r = 0) - and content whose channels are out of phase has no mid at all and lies flat at
 * ±90°. So `atan2(side, mid)` IS the display angle, and the outer half of the fan means exactly
 * one thing: phase cancellation. This is also why the display can use its whole span, which an
 * L/R-magnitude plot never can - the widest such a plot can read is one channel silent, i.e. 45°.
 */
function mixerBandAngle(b) {
  const theta = Math.atan2(Math.abs(bandSide(b)), Math.abs(bandMid(b))) / (Math.PI / 2);
  const pan = mixerBandPan(b);
  return { theta, pan, sign: pan >= 0 ? 1 : -1 };
}

// Which display frames the plots draw: color-coded strips, or the master alone. `key` is what
// the freeze hold files its maxima under. A frame that has decayed to silence (a muted track)
// is dropped entirely - a dead-flat floor line per silent track is clutter, not information.
// `dim` marks the tracks a held fader/knob is not about; the focused one is sorted last so it
// draws over the faded ones.
function mixerPlotSources(colors) {
  const alive = (disp) => disp && disp.some((b) => bandAmp(b) > 1e-5);
  let out;
  if (mixerViewMode === 'overall') {
    const keep = mixerState.masterDisp
      && (alive(mixerState.masterDisp) || (mixerState.freeze && mixerState.freezeMax.has('*')));
    out = keep ? [{ key: '*', disp: mixerState.masterDisp, color: colors.accent }] : [];
  } else {
    out = [...mixerState.strips.values()]
      .filter((s) => alive(s.bandDisp) || (mixerState.freeze && mixerState.freezeMax.has(s.label)))
      .map((s) => ({ key: s.label, disp: s.bandDisp, color: s.color }));
  }
  if (mixerFocus && out.length > 1 && out.some((s) => s.key === mixerFocus)) {
    out = out.map((s) => ({ ...s, dim: s.key !== mixerFocus }));
    out.sort((a, b) => Number(!!b.dim) - Number(!!a.dim));
  }
  return out;
}

// How strongly a source draws: a faded one is still visible as context, not erased.
const mixerSrcAlpha = (src, base) => (src.dim ? base * 0.18 : base);

// A smooth curve through band points: quadratics through segment midpoints - the standard trick
// that stays inside the data's envelope, so the spectrum reads as a curve, never a bar chart.
function mixerSmoothPath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

function drawMixerSpectrum(colors) {
  const c = mixerSpectrumCanvas;
  const ctx = c.getContext('2d');
  const w = Number(c.dataset.w) || 0, h = Number(c.dataset.h) || 0;
  if (!w) return;
  ctx.clearRect(0, 0, w, h);
  const freqs = mixerState.bandFreqs;
  const n = freqs.length;
  const padB = 14, padT = 6;
  const ih = h - padT - padB;
  // The bands are log-spaced, so equal x steps ARE the log-frequency axis.
  const xOf = (i) => (i / Math.max(1, n - 1)) * w;
  const yOf = (u) => padT + (1 - u) * ih;
  // Everything the vertical axis does, in one place: makeup, then the gentle tilt around 1kHz.
  const dbAt = (amp, f) => mixerDbOf(amp) + MIXER_SPEC_MAKEUP_DB + MIXER_SPEC_TILT_DB * Math.log2(f / 1000);
  const curvePts = (ampOf) => {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: xOf(i), y: yOf(mixerSpecUnit(dbAt(ampOf(i), freqs[i]))) });
    return pts;
  };

  ctx.strokeStyle = rgbaFrom(ctx, colors.grid, 0.6);
  ctx.fillStyle = rgbaFrom(ctx, colors.dim, 0.9);
  ctx.font = '9px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (const db of [0, -12, -24, -36, -48, -60]) {
    const y = Math.round(yOf(mixerSpecUnit(db))) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  if (n > 1) {
    const logSpan = Math.log(freqs[n - 1] / freqs[0]);
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (f < freqs[0] || f > freqs[n - 1]) continue;
      const x = Math.round((Math.log(f / freqs[0]) / logSpan) * w) + 0.5;
      // Decade lines carry the label and a stronger stroke; the rest are just orientation.
      const major = f === 100 || f === 1000 || f === 10000;
      ctx.strokeStyle = rgbaFrom(ctx, colors.grid, major ? 0.85 : 0.4);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      if (major) ctx.fillText(f === 100 ? '100' : f === 1000 ? '1k' : '10k', x + 3, h - 4);
    }
  }
  if (!n) return;

  // Frozen, the hold is the ONLY curve: the point of a max-hold is to read a still picture, and
  // a live curve jittering under it is what you froze the display to get away from.
  const frozen = mixerState.freeze;
  for (const src of mixerPlotSources(colors)) {
    const held = frozen ? mixerState.freezeMax.get(src.key) : null;
    if (frozen && !(held && held.length === n)) continue; // nothing accumulated yet
    const pts = curvePts(held ? (i) => held[i] : (i) => bandAmp(src.disp[i]));
    ctx.beginPath();
    mixerSmoothPath(ctx, pts);
    ctx.strokeStyle = rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 1));
    ctx.lineWidth = src.dim ? 1 : 1.6;
    ctx.stroke();
    ctx.lineTo(w, h - padB);
    ctx.lineTo(0, h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 0.24)));
    grad.addColorStop(1, rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 0.02)));
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// The stereo image, drawn as a polar goniometer (see mixerBandAngle for why these angles are
// what they are): straight up is mono, the ±45° safe lines are hard left and hard right, and
// the outer wedges out to ±90° are out-of-phase content. Radius is level. Every band splats
// into an angular profile, so a mono track draws a narrow vertical petal, a wide pad a broad
// fan, a hard-panned shaker a spike leaning onto its safe line, and anything phasey spills past
// them; per-band dots ride on top for the detail (which frequencies sit where).
const MIXER_IMG_ANG = Math.PI / 2; // the display's half-span: the full ±90°
const MIXER_IMG_BINS = 61;
// Out-of-phase content has equal channel magnitudes, so its left/right balance says nothing.
// Below this it is drawn symmetrically into BOTH wedges rather than picked arbitrarily - which
// is exactly the flat horizontal smear a hardware goniometer shows for an inverted channel.
const MIXER_IMG_SIDE_DEADZONE = 0.15;

// `a` is a signed fraction of 90°: 0 up (mono), ±0.5 the safe lines (hard L/R), ±1 flat
// (inverted). `r01` is level.
function mixerImagerPoint(a, r01, cx, cy, R) {
  const ang = a * MIXER_IMG_ANG;
  return { x: cx + Math.sin(ang) * r01 * R, y: cy - Math.cos(ang) * r01 * R };
}

function drawMixerSpatial(colors) {
  const c = mixerSpatialCanvas;
  const ctx = c.getContext('2d');
  const w = Number(c.dataset.w) || 0, h = Number(c.dataset.h) || 0;
  if (!w) return;
  ctx.clearRect(0, 0, w, h);
  // A half-disc that spans the full width: the center sits on the bottom edge, so the ±90°
  // wedges run out along it.
  const cx = w / 2, cy = h - 14;
  const R = Math.min(h - 26, w / 2 - 18);
  const n = mixerState.bandFreqs.length;

  // The fan's grid: level arcs, spokes, and the safe lines called out - inside them is
  // in-phase, outside is not, which is the one thing this display is read for.
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgbaFrom(ctx, colors.grid, 0.8);
  for (const db of [0, -12, -24, -36, -48]) {
    const r = mixerSpecUnit(db) * R;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2 - MIXER_IMG_ANG, -Math.PI / 2 + MIXER_IMG_ANG);
    ctx.stroke();
  }
  for (const a of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
    const p = mixerImagerPoint(a, 1, cx, cy, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = rgbaFrom(ctx, colors.dim, 0.75);
  for (const a of [-0.5, 0.5]) {
    const p = mixerImagerPoint(a, 1, cx, cy, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = rgbaFrom(ctx, colors.dim, 0.9);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const label = (a, text, rr = 1.07) => {
    const p = mixerImagerPoint(a, rr, cx, cy, R);
    ctx.fillText(text, p.x, p.y + 3);
  };
  label(-0.5, 'L');
  label(0.5, 'R');
  label(0, 'M', 1.05);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = rgbaFrom(ctx, colors.dim, 0.6);
  label(-0.88, 'ø');
  label(0.88, 'ø');
  ctx.textAlign = 'left';
  if (!n) return;

  // Gaussian splat kernel, in bins. Max-combine, not sum: the profile's radius means "the level
  // at this angle", and two quiet bands pointing the same way are not one loud one.
  const kernel = [1, 0.88, 0.62, 0.34, 0.14, 0.04];
  for (const src of mixerPlotSources(colors)) {
    const bins = new Array(MIXER_IMG_BINS).fill(0);
    const dots = [];
    const splat = (a, level) => {
      const bi = Math.round(((a + 1) / 2) * (MIXER_IMG_BINS - 1));
      for (let k = -5; k <= 5; k++) {
        const b = bi + k;
        if (b < 0 || b >= MIXER_IMG_BINS) continue;
        bins[b] = Math.max(bins[b], level * kernel[Math.abs(k)]);
      }
      dots.push({ a, level });
    };
    for (let i = 0; i < n; i++) {
      const level = mixerBandLevel(src.disp[i]);
      if (level < 0.05) continue;
      const { theta, pan, sign } = mixerBandAngle(src.disp[i]);
      // Balance too even to mean anything (see MIXER_IMG_SIDE_DEADZONE): draw both ways.
      if (Math.abs(pan) < MIXER_IMG_SIDE_DEADZONE && theta > 0.5) {
        splat(-theta, level);
        splat(theta, level);
      } else {
        splat(sign * theta, level);
      }
    }
    // The petal: around the smoothed profile, then back through the center to close.
    const pts = bins.map((r, b) => mixerImagerPoint((b / (MIXER_IMG_BINS - 1)) * 2 - 1, r, cx, cy, R));
    ctx.beginPath();
    mixerSmoothPath(ctx, pts);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 0.18));
    ctx.fill();
    ctx.strokeStyle = rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 0.9));
    ctx.lineWidth = src.dim ? 1 : 1.5;
    ctx.stroke();
    // Per-band dots on top of the profile: which frequencies are sitting where, rather than
    // just the shape of the whole.
    ctx.fillStyle = rgbaFrom(ctx, src.color, mixerSrcAlpha(src, 1));
    for (const d of dots) {
      const p = mixerImagerPoint(d.a, d.level, cx, cy, R);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2 + d.level * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// --- wiring ---

mixerViewBtn.addEventListener('click', () => {
  mixerViewMode = mixerViewMode === 'tracks' ? 'overall' : 'tracks';
  localStorage.setItem('poptart-mixer-view', mixerViewMode);
  updateMixerViewBtn();
  // The freeze hold is filed per source, and the two views draw different sources - a hold
  // taken by track says nothing about the master's curve, so it starts again for what's now on
  // screen rather than showing a stale one.
  if (mixerState) mixerState.freezeMax.clear();
});
document.getElementById('mixerClose').addEventListener('click', closeMixer);
document.getElementById('mixerOpenBtn').addEventListener('click', openMixer);
mixerBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === mixerBackdrop) closeMixer();
});
document.addEventListener('keydown', (e) => {
  if (!mixerState || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeMixer();
}, true);
window.addEventListener('resize', () => { if (mixerState) sizeMixerCanvases(); });
// The spectrum's freeze-max hold: on = accumulate every raw frame's maximum and draw that;
// clicking again clears the hold and goes back to live. Fresh on every press, so a second
// freeze starts from silence rather than continuing the last one.
const mixerFreezeBtn = document.getElementById('mixerFreezeBtn');
function updateMixerFreezeBtn() {
  mixerFreezeBtn.classList.toggle('mixer-freeze-on', !!mixerState?.freeze);
}
mixerFreezeBtn.addEventListener('click', () => {
  if (!mixerState) return;
  mixerState.freeze = !mixerState.freeze;
  mixerState.freezeMax.clear();
  updateMixerFreezeBtn();
});
// Releasing anything restores the plots, wherever the release happens - a fader drag routinely
// ends with the pointer off the control (and a range input keeps DOM focus afterwards, which is
// why this can't be left to blur). One listener for every strip rather than three apiece.
for (const ev of ['pointerup', 'pointercancel']) {
  window.addEventListener(ev, () => {
    // Before the panel guard: this is the one place a held control is written and handed back, and
    // a mixer closed mid-drag must not leave the track pinned waiting for the lease to time out.
    // evaluate() reports its own failures, so there is nothing left for this to say.
    releaseMixerHold().catch(() => {});
    if (!mixerState) return;
    for (const strip of mixerState.strips.values()) {
      strip.dragGain = false;
      strip.dragBass = null;
      for (const knob of strip.knobs.values()) knob.drag = null;
    }
    if (mixerFocusFromPointer) {
      mixerFocus = null;
      mixerFocusFromPointer = false;
    }
  });
}
cm.on('change', scheduleMixerSync);

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
  engineStatus.title = loaded ? '' : 'engine down — see the console';
  if (!loaded && error && error !== lastEngineError) logLine(`engine down: ${error}`, true);
  lastEngineError = loaded ? null : error;
  return loaded;
}

function renderTracks(result) {
  // The mixer's memory of which labels are TRACKS (muted ones included) - what lets a strip
  // outlive its own mute button. See the mixer section.
  mixerKnownTracks = result.tracks.map((t) => t.label);
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
    confBtn.title = 'capture knobs you touch into .param(...) calls';
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
        uiBtn.title = "open the plugin's own window (this slot holds its preset until you click back in the code)";
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
  // The marks in the code were just re-anchored by the eval that got us here - draw them again.
  paintHeldPresets();
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
async function evaluate(start, { byHand = false } = {}) {
  // Running the buffer yourself is the "tidy it up and play it" gesture, so it puts back every
  // chip you had opened. The panels' own debounced evals don't pass byHand and so leave them be:
  // snapping a definitions run shut halfway through drawing into it is the whole reason folds are
  // remembered at all. Defaulting to false keeps that the safe way round - a call site that
  // forgets to say so leaves a chip open, rather than closing one under the player's hands.
  if (byHand) {
    forgetExpandedFolds();
    refoldAll();
  }
  migrateDefNames(); // a patch saved before the builders were privatised still says roll(...)
  convertLegacyStates(); // ...and one from before presets still pins `{ state }` onto its calls
  for (const reg of DEF_REGISTRIES) reg.materialize(); // a name said in a pianoroll()/lfo()/.preset() gets its definition first
  const code = cm.getValue();
  // Whatever auto-pin has written into the buffer is in THIS code, so this is the evaluation that
  // puts those programs where the scheduler reads them - and so the one that thaws their slots
  // (see pollPluginEdits). Taken before the request goes out: a capture written after this point
  // belongs to the next eval, not to this one.
  const filed = commitOnEval;
  commitOnEval = [];
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
    refoldAll();
    if (start) playing = true; // Update keeps the current play state; Play begins it
    const nActive = result.tracks.filter((t) => t.active).length;
    logLine(`${start ? 'playing' : 'updated'} (${nActive}/${result.tracks.length} pattern(s))`);
    loadChainParams();
    commitQueue.push(...filed); // the programs are in the store now; their slots can swap again
  } catch (e) {
    commitOnEval.push(...filed); // nothing was filed, so nothing is thawed
    logLine(e.message ?? String(e), true);
  }
  updateTransportButtons();
}

// Play button: state-aware. Playing -> stop; stopped -> evaluate and start.
function togglePlay() {
  if (playing) doStop();
  else evaluate(true, { byHand: true });
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
// Packs are folded shut by default so a big library reads as a scannable list of packs rather
// than thousands of file rows. This map holds the user's explicit open/shut clicks, which beat
// the default; it's cleared whenever the filter changes (see the input handler).
const packOverride = new Map(); // pack name -> open?
let sampleRowBudget = MAX_SAMPLE_ROWS; // grown by the "show more" note, reset with the filter

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
  let hidden = 0;
  let packsShown = 0;
  for (const pack of samplePacks) {
    const packMatches = !query || pack.name.toLowerCase().includes(query);
    // Indexes must be positions in the full pack, not the filtered view - attach before filtering.
    const files = pack.files
      .map((name, i) => ({ name, i }))
      .filter((f) => !query || packMatches || f.name.toLowerCase().includes(query));
    if (!files.length) continue;
    packsShown++;
    // A pack opens on click, or when the filter matched files *inside* it. A pack-NAME match
    // leaves it shut: a broad query then stays a list of packs instead of every file in them.
    const open = packOverride.get(pack.name) ?? (!!query && !packMatches);

    const head = document.createElement('div');
    head.className = 'slot-head sample-pack-head';
    head.title = 'click to open · copies s("pack")';
    head.textContent = `${open ? '▾' : '▸'} ${pack.name} · ${pack.files.length}`;
    head.onclick = () => {
      packOverride.set(pack.name, !open);
      copyText(`s("${pack.name}")`, 'pack');
      renderSamples();
    };
    sampleList.appendChild(head);
    if (!open) continue;

    const room = Math.max(0, sampleRowBudget - shown);
    hidden += files.length - Math.min(files.length, room);

    for (const f of files) {
      if (shown >= sampleRowBudget) break;
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

  if (hidden) {
    const more = document.createElement('div');
    more.className = 'more-note more-note-click';
    more.textContent = `…${hidden} more — click to show ${Math.min(hidden, MAX_SAMPLE_ROWS)}`;
    more.onclick = () => {
      sampleRowBudget += MAX_SAMPLE_ROWS;
      renderSamples();
    };
    sampleList.appendChild(more);
  }
  if (!packsShown) sampleList.textContent = 'no samples match';
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

// A new filter is a fresh browse: drop the hand-opened packs and the grown row budget so the
// list can't stay stuck open on packs the query no longer cares about.
sampleSearch.addEventListener('input', () => {
  packOverride.clear();
  sampleRowBudget = MAX_SAMPLE_ROWS;
  renderSamples();
});

// ---------------------------------------------------------------------------------------------
// Sidebar tabs (session | sounds | files | settings) + pattern file manager. Pattern files are
// whole editor buffers saved server-side (~/.poptart/patterns/<name>.js) via /api/patterns*:
// save the current buffer under a name, click a saved pattern to load it, rename/delete to
// organize.
// ---------------------------------------------------------------------------------------------

const sidebarToggle = document.getElementById('sidebarToggle');
const sessionTab = document.getElementById('sessionTab');
const soundsTab = document.getElementById('soundsTab');
const filesTab = document.getElementById('filesTab');
const settingsTab = document.getElementById('settingsTab');
const audioDeviceSelect = document.getElementById('audioDeviceSelect');
const audioChannelSelect = document.getElementById('audioChannelSelect');
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
  if (name === 'settings') { refreshAudioDevices(); refreshAudioInputs(); refreshSamplesDir(); refreshPreferVst3(); refreshWipRetention(); }
}

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}

// ---------------------------------------------------------------------------------------------
// Settings tab - audio output device and how many of its channels to use. Changing either
// restarts the engine server-side, so playing tracks stop and the user re-evaluates.
//
// The two are separate on purpose. The device list shows what each interface HAS; the channel
// count says how much of it you are listening to, which is the number .o(n) wraps at. They are
// usually different: six outputs on the back of an interface and two monitors on your desk is the
// ordinary case, and defaulting to all six is what makes .o(2) play to a jack with nothing in it.
// ---------------------------------------------------------------------------------------------

// "4" -> "4 ch · 2 pairs". Pairs, because a pair is what one .o(n) addresses.
function channelChoiceLabel(n) {
  return n === 2 ? '2 ch · stereo' : `${n} ch · ${n / 2} pairs`;
}

function renderChannelChoices(choices, current, audible) {
  const list = choices?.length ? choices : [2];
  audioChannelSelect.innerHTML = '';
  for (const n of list) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = channelChoiceLabel(n);
    audioChannelSelect.appendChild(opt);
  }
  audioChannelSelect.value = String(current ?? list[0]);
  // A stereo device has nothing to choose - leave the control readable rather than removing it,
  // so "output channels" doesn't appear and vanish as you switch interfaces.
  audioChannelSelect.disabled = list.length < 2;
  audioChannelSelect.title = list.length < 2
    ? `${audible === 2 ? 'this device is stereo' : `only ${audible} channels are audible here`} - every .o(n) plays to channels 1/2`
    : 'how many output channels .o(n) may play to - stereo folds every orbit onto channels 1/2; raise it to reach this interface\'s other pairs';
}

async function refreshAudioDevices() {
  try {
    const {
      devices, selected, outputChannels, outputChannelChoices, audibleChannels,
    } = await api('GET', '/api/audioDevices');
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
    renderChannelChoices(outputChannelChoices, outputChannels, audibleChannels);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

audioChannelSelect.addEventListener('change', async () => {
  const channels = Number(audioChannelSelect.value);
  audioChannelSelect.disabled = true;
  audioDeviceSelect.disabled = true;
  engineStatus.textContent = 'restarting engine…';
  engineStatus.className = 'status';
  logLine(`using ${channels} output channels - restarting the engine…`);
  try {
    const res = await api('POST', '/api/audioOutputChannels', { channels });
    stopHighlighting();
    playing = false;
    updateTransportButtons();
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    renderChannelChoices(res.outputChannelChoices, res.outputChannels, res.audibleChannels);
    logLine(res.outputChannels === 2
      ? 'every .o(n) now plays to channels 1/2 - re-evaluate (Cmd/Ctrl+Enter) to resume playback'
      : `.o(n) now wraps at ${res.outputChannels / 2} stereo pairs - re-evaluate (Cmd/Ctrl+Enter) to resume playback`);
  } catch (e) {
    logLine(e.message ?? String(e), true);
    refreshAudioDevices().catch(() => {}); // put the control back to what the engine actually has
  } finally {
    audioChannelSelect.disabled = false;
    audioDeviceSelect.disabled = false;
    refreshStatus().catch(() => {});
  }
});

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
    // A different interface has a different number of pairs, and the saved channel count is
    // clamped to it server-side - so re-read rather than leaving the old device's choices up.
    refreshAudioDevices().catch(() => {});
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

// How long unnamed sessions are kept. Off by default and deliberately so: a session file is the
// only copy of work that was never given a name. It does cost something - each one pins the
// captured plugin states it mentions, so the state store can only release what no session still
// names (see blobs.js) - which is why it is offered at all, and why the note below says what
// turning it on would delete BEFORE it deletes anything.
const wipRetentionSelect = document.getElementById('wipRetentionSelect');
const wipRetentionNote = document.getElementById('wipRetentionNote');

const sessionCost = (n, bytes) => `${n} session${n === 1 ? '' : 's'} (${(bytes / 1048576).toFixed(0)}mb)`;

async function refreshWipRetention() {
  try {
    const { months, preview } = await api('GET', '/api/patterns/wip/retention');
    wipRetentionSelect.value = String(months);
    wipRetentionNote.textContent = months
      ? `sessions older than ${months} month${months === 1 ? '' : 's'} are deleted; ${sessionCost(preview.sessions, preview.bytes)} would go on the next sweep`
      : 'every session is kept until you delete it in the files tab';
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

wipRetentionSelect.addEventListener('change', async () => {
  const months = Number(wipRetentionSelect.value);
  try {
    if (months > 0) {
      // Priced before it is agreed to: what this policy deletes depends on what is on disk right
      // now, and "sessions older than 3 months" means nothing until you know it is 271 of them.
      const { preview } = await api('GET', `/api/patterns/wip/retention?months=${months}`);
      const ok = preview.sessions === 0
        || confirm(`delete ${sessionCost(preview.sessions, preview.bytes)} older than ${months} month${months === 1 ? '' : 's'}?\n\nsaved patterns are not touched - only unnamed sessions. this keeps applying as sessions age.`);
      if (!ok) return refreshWipRetention(); // put the select back to the policy in force
    }
    const res = await api('POST', '/api/patterns/wip/retention', { months });
    logLine(months
      ? `keeping sessions for ${months} month${months === 1 ? '' : 's'} - deleted ${res.deleted}, freed ${(res.freed / 1048576).toFixed(0)}mb`
      : 'keeping every session until you delete it');
    refreshPatternFiles();
    refreshWipRetention();
  } catch (e) {
    logLine(e.message ?? String(e), true);
    refreshWipRetention();
  }
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
    pulse(el, 'saved-flash');
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
// file - which leaves the buffer nameless until the user saves it under one. `wipSession` is the
// autosave file the incoming code IS, when it came out of one: the buffer goes back to being that
// session rather than a copy of it.
async function openInEditor(code, name, wipSession = null) {
  await rollWipSession(wipSession);
  cm.setValue(code);
  // A reopened session is already exactly what its file holds, so nothing is written until the
  // code actually changes - which is what keeps the files tab, sorted by modified time, from
  // reshuffling the moment you look at something.
  if (wipSession) wipLastSent = code;
  forgetExpandedFolds();
  refoldAll();
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
    // Reopened as itself: this session goes on recording the buffer, and reaches the top of the
    // list on the first edit. An unnamed session stays unnamed until you keep it.
    await openInEditor(code, null, entry.id);
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
// The file is read in the browser and written out as DRAWN ROLLS, one per lane - each filed under
// the lane's own name, so the buffer reads as the parts and not as the data:
//
//   bass: pianoroll("bass")
//
//   _roll("bass", "36,0,4 47,9,3,0.5", { grid: 8, len: 16 })   <- folded into the block at the bottom
//
// A roll rather than mini-notation because it's the form that stays editable - double-click the
// `pianoroll` name and the notes are there on a grid to drag, retime and audition - and because
// nothing is given up by landing here: the roll's own →♪ writes the mini-notation whenever it's
// wanted, in scale degrees if the roll is folded to the key, which is the same rewrite an import
// straight to text used to do in one shot. NAMED rather than inline because a whole file's worth of
// note strings sitting in the middle of the code is unreadable - and because a named roll can be
// swapped, picked from the roll list and played by more than one lane.
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

/**
 * The name a lane's roll is filed under: the lane's own label, so the picker lists the parts of the
 * file by name. `$` (an anonymous lane) can't be a roll name - it has to survive being written
 * inside a mini pattern - so those fall back to the kind's own word. A name already taken by a roll
 * in the buffer (or in prebake) is bumped with an `_2` suffix rather than quietly overwritten.
 */
function midiRollId(label, taken) {
  const base = /^[A-Za-z_][\w]*$/.test(label) ? label : 'roll';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
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
  const takenRolls = new Set(rollDefs.allIds().map((r) => r.id));
  const lines = [];
  const names = [];
  const drawn = new Map(); // roll id -> the notes and grid it is defined with
  let unquantized = 0;
  try {
    const { entries } = st.midifile.midiLanesToPianoroll(st.parsed, {
      grid: chosen === 'auto' ? 'auto' : Number(chosen),
    });
    for (const entry of entries) {
      const label = midiLaneLabel(entry.name, taken);
      const rollId = midiRollId(label, takenRolls);
      names.push(label);
      lines.push(`${label}: pianoroll(${JSON.stringify(rollId)})`);
      drawn.set(rollId, entry.body);
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
  // Below the player's code, but ABOVE any definitions block already down there - that block is the
  // bottom of the buffer by construction, and the rolls this import is about to write join it.
  const at = firstDefRunStart(code) ?? code.length;
  const before = code.slice(0, at);
  // Exactly one blank line between the code and the import, counting whatever newlines are already
  // there - and one under it too when something (the definitions block) follows.
  const trailing = /\n*$/.exec(before)[0].length;
  const gap = before.trim() ? '\n'.repeat(Math.max(0, 2 - trailing)) : '';
  const text = `${gap}${lines.join('\n\n')}\n${at < code.length ? '\n' : ''}`;
  cm.replaceRange(text, cm.posFromIndex(at), cm.posFromIndex(at));
  // Park the cursor on the end of the last lane rather than the blank line under it - that's
  // where the `.synth("…")` it still needs goes. Held as a bookmark across the definitions write
  // below, which may go in above it.
  const caret = cm.setBookmark(cm.posFromIndex(at + text.replace(/\n+$/, '').length));
  // The notes themselves join the definitions block at the bottom - the same place every named
  // roll lives, folded to one chip - so the lanes above read as the parts they play.
  if (drawn.size) {
    const [defFrom, defTo, defText] = rollDefs.defsEdit(cm.getValue(), [...drawn.keys()], (id) => drawn.get(id));
    cm.replaceRange(defText, cm.posFromIndex(defFrom), cm.posFromIndex(defTo));
  }
  refoldAll(); // the block starts life hidden, like every other one
  const caretAt = caret.find();
  caret.clear();
  if (caretAt) {
    cm.setCursor(caretAt);
    cm.scrollIntoView(caretAt, 80);
  }
  cm.focus();

  closeMidiImport();
  logLine(
    `midi import: ${st.file.name} → ${names.length} piano roll${names.length === 1 ? '' : 's'} (${names.join(', ')})` +
      `${takeKey ? ` in ${key}` : ''} - the notes are in the pianorolls block at the bottom; double-click a` +
      ' pianoroll name to edit or convert one, and add a .synth() then Cmd/Ctrl+Enter to play',
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

// The state lives in one attribute on <html>, which index.html has already stamped from the same
// storage key before the first paint - so nothing here has to run early to keep a minimized panel
// minimized. The panel's width and its toggle's arrow are both drawn from that attribute (see
// style.css); this only flips it and remembers the flip.
function initCollapsible(attr, toggleBtn, storageKey) {
  const root = document.documentElement;
  const apply = (collapsed) => {
    root.toggleAttribute(attr, collapsed);
    localStorage.setItem(storageKey, collapsed ? '1' : '');
  };
  toggleBtn.addEventListener('click', () => apply(!root.hasAttribute(attr)));
  return apply; // so callers (e.g. the ctrl+p hotkey) can drive the collapse programmatically
}

const setSidebarCollapsed = initCollapsible('data-sidebar-collapsed', sidebarToggle, 'poptart-sidebar-collapsed');
initCollapsible('data-console-collapsed', consoleToggle, 'poptart-console-collapsed');

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
updateBtn.addEventListener('click', () => evaluate(false, { byHand: true }));
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
  setSidebarCollapsed(!document.documentElement.hasAttribute('data-sidebar-collapsed'));
}, 'toggle sidebar');

// ctrl+r - arm/stop MIDI recording (mirrors the ● rec button).
addHotkey(builtinHotkeys, 'ctrl+r', () => (recState ? cancelMidiRecord(true) : startMidiRecord()), 'toggle record');

// ctrl+b - bounce the block the cursor is in to audio (mirrors the record panel's button).
addHotkey(builtinHotkeys, 'ctrl+b', () => bounceBlockAtCursor(), 'bounce block to audio');

// ctrl+m - toggle the keyboard/tap instrument between off and midi.
addHotkey(builtinHotkeys, 'ctrl+m', () => setKbMode(kbMode === 'normal' ? 'midi' : 'normal'), 'toggle midi keyboard');

// ctrl+g - open/close the mixer (mirrors settings → open mixer…).
addHotkey(builtinHotkeys, 'ctrl+g', () => toggleMixer(), 'toggle mixer');

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
