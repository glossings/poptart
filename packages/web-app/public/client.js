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
let arrangeMod = null; // arrange.mjs - the arrangement painter's clip format and span math
let notesMod = null; // notes.mjs - pure music-theory helpers piped up to the userland prebake scope
let mixctlMod = null; // mixctl.mjs - the mixer's gain/pan trim reads and code edits
let recordMod = null; // record.mjs - a live take into a roll (the ● rec and capture paths)
// Resolves once pattern-core is loaded (or failed) - the startup prebake waits on it so a
// top-level noteToMidi()/etc. call in the prebake never races the import.
const coreReady = Promise.all([
  import('/pattern-core/mini.mjs'),
  import('/pattern-core/labels.mjs'),
  import('/pattern-core/shape.mjs'),
  import('/pattern-core/pianoroll.mjs'),
  import('/pattern-core/notes.mjs'),
  import('/pattern-core/mixctl.mjs'),
  import('/pattern-core/record.mjs'),
  import('/pattern-core/arrange.mjs'),
])
  .then(([m, l, s, pr, nt, mx, rc, ar]) => {
    miniMod = m;
    labelsMod = l;
    shapeMod = s;
    pianorollMod = pr;
    notesMod = nt;
    mixctlMod = mx;
    recordMod = rc;
    arrangeMod = ar;
    arSetClock(arClockSnap); // a clock snapshot that arrived before the module did gets its twin now
    initLfoEditor();
    initPianorollEditor();
    initArrangeEditor();
    initRecordPanel();
    initPresetPanel();
    initPackPanel();
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

// Hand-picked sample packs, for sp("kit"): a list of files under a name. There is nothing to draw
// and nothing to capture - a pack is chosen, file by file, off the disk - so its panel is a browser
// (see the pack panel section) rather than a canvas, and its argument is always names, like a
// preset's.
const packDefs = makeDefRegistry({
  kind: 'pack',
  section: 'packs',
  defCall: '_pack',
  useCall: 'sp',
  emptyBody: '[]',
  isData: () => false,
  library: () => prPrebakePacks.map((p) => p.id),
  libraryNote: 'prebake',
  panel: {
    current: () => packState?.id ?? null,
    open: (id) => openPackById(id),
    close: () => closePackPanel(),
    carry: () => null, // nothing to carry: the panel is the whole view
    sourceCall: () => null, // a rename is always a plain rename, never a fork
    setCurrent: (from, to) => {
      if (packState?.id === from) packState.id = to;
    },
    syncHead: () => packSyncHead(),
    scheduleEval: () => packScheduleEval(),
  },
});

// Every registry, for the passes that have to run over all of them (folding, auto-naming).
const DEF_REGISTRIES = [rollDefs, shapeDefs, presetDefs, packDefs];

// The ★ library: what ~/.poptart/prebake/pinned.js holds, as last fetched (see prRefreshRollList) -
// [{ kind, id, scope, code }]. Every registry reads it to draw its stars; see makeDefRegistry's pin.
let pinnedDefs = [];

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

/**
 * A line on the in-app console. `level` is falsy for an ordinary line, 'warn' for something that
 * went differently than you'd expect but still works, and true (or 'error') for something that
 * did not happen at all.
 *
 * The middle one earns its own level rather than borrowing the red: a rig whose channel numbers
 * have shifted is still playing, and a console that shouts the same way about that as it does
 * about a refusal teaches you to stop reading it. `true` stays the error spelling because most of
 * the calls in this file predate the third level.
 */
function logLine(text, level = false) {
  const kind = level === 'warn' ? 'warn' : level ? 'error' : '';
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  log.prepend(line);
  // Newest first, so the tail is what gets dropped. A .log()'d track writes a line per event -
  // tens a second - and this panel is a scrollback, not a record: devtools below keeps the lot.
  while (log.childElementCount > LOG_MAX_LINES) log.lastElementChild.remove();
  // Mirror everything to the devtools console too, so the log is still there when the in-app
  // console is minimized (and gets devtools' filtering/timestamps).
  (kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log)(`[poptart] ${text}`);
  // With the console collapsed, a refusal is silent - you press a button, nothing happens, and the
  // line saying why is behind a panel you aren't looking at. So pulse the buffer red: not the
  // message, just the fact that there IS one, and somewhere to go for it. Open, the line is already
  // on screen (newest first, at the top) and a flash would be noise on top of it. A warning does
  // not pulse: nothing was refused, and it has already been said where it matters (the settings
  // tab carries the short version beside the control it is about).
  if (kind === 'error' && document.documentElement.hasAttribute('data-console-collapsed')) {
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
    'Cmd-.': () => doStop('a'), // in DJ mode: this pane's deck only; otherwise a full stop
    'Ctrl-.': () => doStop('a'),
    'Cmd-S': () => savePatternFile(),
    'Ctrl-S': () => savePatternFile(),
    'Shift-Cmd-S': () => savePatternFileAs(),
    'Shift-Ctrl-S': () => savePatternFileAs(),
    'Shift-Alt-Down': (cm) => copyLines(cm, 'down'),
    'Shift-Alt-Up': (cm) => copyLines(cm, 'up'),
    'Alt-Up': 'swapLineUp',
    'Alt-Down': 'swapLineDown',
    'Ctrl-Space': (ed) => showPoptartHint(ed),
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
    // Whichever deck was clicked into last (see djSetActiveDeck): its song if it holds one, its
    // code if it doesn't. Outside DJ mode that is always the one editor there is.
    if (mixModeOn) djPlayActive();
    else evaluate(true, { byHand: true });
  } else if (e.key === '.' && !e.shiftKey) {
    e.preventDefault();
    // The active deck alone; outside DJ mode (no deck) it is the whole set, as ever.
    doStop(mixModeOn ? djActiveDeck : null);
  } else if ((e.key === '>' || e.key === '.') && e.shiftKey) {
    e.preventDefault();
    stepDeckBQueue(); // mix mode: load the active set's next song into deck B
  } else if ((e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_') && mixModeOn && songActiveDeck()) {
    // Cmd ± zooms the active song pane's waveform (the piano roll's own handler takes these
    // first when it has focus; this is the pane's turn).
    e.preventDefault();
    songPanes[songActiveDeck()].zoomBy(e.key === '-' || e.key === '_' ? 1 / PR_BTN_ZOOM : PR_BTN_ZOOM);
  } else if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey
    && songCueTarget(e)) {
    // Ctrl+C is the CUE button, held until the key comes up. Ctrl specifically, and only where
    // the gesture has a target that isn't someone trying to copy - Cmd+C is never touched.
    e.preventDefault();
    if (!e.repeat) songCueKeyDown(e);
  } else if (e.key.toLowerCase() === 'l' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    arrangeUnlock(); // release the loop region the arrangement is in (see the arrange section)
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault(); // the browser's own "save page" is never what's wanted here
    if (e.shiftKey) savePatternFileAs();
    else savePatternFile();
  } else if (e.key.toLowerCase() === 'x' && e.shiftKey) {
    e.preventDefault();
    toggleMixMode(); // the performance mixer's split (see the mix section at the foot of this file)
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
    arrange: 'arrangement clips — click to expand, or double-click arrange to paint',
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
  // arrange(...): the WHOLE argument list folds - clips, loop length and lane names are all the
  // painter's, and none of it is meant to be edited by hand.
  const arrangeRe = /\barrange\s*\(/g;
  while ((m = arrangeRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0 || !code.slice(open + 1, close).trim()) continue;
    foldSpan(open + 1, close, '⋯', DATA_ARG_TITLES.arrange, `data@${m.index}`);
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

// Applies [from, to, text] edits to the buffer as ONE undo step, last-first so every offset still
// holds against the `code` they were computed from.
//
// Two of them can land on the SAME offset: a chain call that ends at the very end of the buffer is
// exactly where defsEdit appends a new definition, and then nothing about the offsets says which
// text comes first. Array order breaks the tie - an earlier entry goes in first and so ends up
// LOWER in the document - which is why the definition is always listed before the `.preset(...)`
// that names it. Sorted the other way, the definition was threaded through the middle of the
// `.preset(…)` call and the call came out dangling off the definition instead of off the .fx():
// `_preset("bass", "ValhallaRoom", "@…").preset("bass")` on one line, with the track above it
// untouched. A buffer whose last line had no newline after it was all it took.
//
// The `+`-prefixed origin is what makes CodeMirror merge consecutive writes into a single undo
// step (same trick as the copy-line edits): a knob drag can't bury your last real edit under a run
// of them.
function applyBufferEdits(edits, origin) {
  const order = new Map(edits.map((e, i) => [e, i]));
  const inOrder = [...edits].sort((a, b) => (b[0] - a[0]) || (order.get(a) - order.get(b)));
  cm.operation(() => {
    for (const [from, to, text] of inOrder) {
      cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to), origin);
    }
  });
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
  // Definition first, `.preset(...)` second - see applyBufferEdits for what rides on that order.
  const edits = [
    presetDefs.defsEdit(code, [id], () => `${JSON.stringify(plugin ?? '')}, ${JSON.stringify(state)}`),
    [call.closeParen + 1, call.closeParen + 1, `.preset(${JSON.stringify(id)})`],
  ];
  // The legacy `{ state }` argument, if this call still carries one.
  if (call.afterFirstArg < call.closeParen) edits.push([call.afterFirstArg, call.closeParen, '']);
  applyBufferEdits(edits, '+autopin');
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
    applyBufferEdits(edits, '+legacyState');
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
// preset, a recorded roll. A muted copy (`pluck_: …`) and a playing one (`pluck: …`) carry the
// same label, and the engine only knows the one that is playing: the gesture came out of ITS
// plugin, so that is the block the write belongs in. The muted one is only the fallback when
// nothing by that name plays (a capture landing just after the track was muted).
//
// The LAST such block, not the first, because that is the one the engine is playing: a label is a
// key, and /api/evaluate walks the buffer in document order calling setPattern on one scheduler
// per key - so writing `bass:` a second time to try something else overrides the first, exactly
// the way redeclaring anything else does. Taking the first instead aimed every write at the
// version that had been overridden, which is what made a `bass:` re-stated as a pianoroll report
// "auto-pin: no synth(...) call" against the line above it.
function blockForTrack(code, label) {
  const named = labelsMod.splitLabeledBlocks(code).filter((b) => b.label === label);
  const live = named.filter((b) => !b.muted);
  return live[live.length - 1] ?? named[named.length - 1] ?? null;
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
// `editor` is whichever pane is being completed in - the main buffer, or deck B's in DJ mode.
function blockAtCursor(editor = cm) {
  if (!labelsMod) return null;
  const idx = editor.indexFromPos(editor.getCursor());
  const blocks = labelsMod.splitLabeledBlocks(editor.getValue());
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

function paramHints(cur, typed, textBefore, editor) {
  // A `.param(` call targets whatever is last in the chain at that point of the method chain:
  // slot 0 (the instrument) before any .fx(), then slot 1, 2, … after each. Count `.fx(`
  // occurrences between the block start and the cursor to mirror that rule.
  const block = blockAtCursor(editor);
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

// Named packs for sp(" - what this buffer defines and what the library holds (see packDefs).
function packNameHints(cur, typed, editor) {
  const token = typed.match(/[A-Za-z0-9_:#-]*$/)[0];
  const word = token.split(':')[0];
  // Buffer-local packs come from the pane being typed in: deck B's `sp("` must offer deck B's
  // own definitions, not the main editor's.
  const code = editor.getValue();
  const pool = packDefs.allIds(null, code).map((r) => {
    const files = r.own
      ? packEntriesOf(code, packDefs.findDef(code, r.id)) ?? []
      : prPrebakePacks.find((p) => p.id === r.id)?.files ?? [];
    return { key: r.id, count: files.length, note: r.note };
  });
  let matches = rankedMatches(pool, word, 40);
  if (matches.length === 0) matches = pool.slice(0, 40);
  return Promise.resolve(hintResult(cur, token, matches.map((item) => ({
    text: item.key,
    displayText: `${item.key} · ${item.count}${item.note ? ` · ${item.note}` : ''}`,
  }))));
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

// CodeMirror hands the hint source the editor asking for completions, so every branch below
// reads (and completes into) whichever pane has focus - the main buffer or deck B's.
function poptartHint(editor) {
  const cur = editor.getCursor();
  const before = editor.getRange(CodeMirror.Pos(0, 0), cur);

  // Inside the name string of .param(" → real VST parameter names.
  let m = before.match(/\.param\s*\(\s*["']([^"']*)$/);
  if (m) return paramHints(cur, m[1], before, editor);

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

  // Inside sp(" → named packs, this buffer's and the library's. Like s(", the string is mini
  // notation, so only the word under the cursor is completed, and the method form is allowed.
  m = before.match(/(?<![\w$])\.?sp\s*\(\s*["']([^"']*)$/);
  if (m) return packNameHints(cur, m[1], editor);

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

function showPoptartHint(editor = cm) {
  editor.showHint({ hint: withDocPanel(poptartHint), completeSingle: false });
}

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
function docAtCoords(editor, clientX, clientY) {
  const pos = editor.coordsChar({ left: clientX, top: clientY }, 'window');
  const line = editor.getLine(pos.line);
  if (line == null) return null;
  let token = editor.getTokenAt(pos, true);
  // getTokenAt returns the token ENDING at pos, so on the left edge of a name we get whatever
  // precedes it (the dot, a space) - look one character right before giving up.
  if ((!token || !IDENTIFIER_RE.test(token.string)) && pos.ch < line.length) {
    token = editor.getTokenAt(CodeMirror.Pos(pos.line, pos.ch + 1), true);
  }
  if (!token || !IDENTIFIER_RE.test(token.string)) return null;
  const startBox = editor.charCoords(CodeMirror.Pos(pos.line, token.start), 'window');
  const endBox = editor.charCoords(CodeMirror.Pos(pos.line, token.end), 'window');
  if (clientY < startBox.top || clientY > startBox.bottom) return null;
  if (clientX < startBox.left || clientX > endBox.left) return null;
  const context = /\.\s*$/.test(line.slice(0, token.start)) ? 'method' : 'builder';
  const doc = lookupDoc(token.string, context);
  return doc ? { doc, key: `${token.string}:${context}`, box: startBox } : null;
}

// The pane the pointer was last over, so holding ctrl without moving the mouse still opens the
// tooltip - and opens it over the right editor when two are on screen.
let lastHover = null; // { editor, x, y }

function updateHoverDoc(editor, point, ctrlHeld) {
  lastHover = point ? { editor, x: point.x, y: point.y } : null;
  if (!point || !ctrlHeld || !docTooltipsEnabled || editor.state.completionActive) {
    hideHoverDoc();
    return;
  }
  const hit = docAtCoords(editor, point.x, point.y);
  if (!hit) hideHoverDoc();
  else showHoverDoc(hit.doc, hit.key, hit.box);
}

// Ctrl pressed with the pointer already parked over a name, and released again.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control' && lastHover) updateHoverDoc(lastHover.editor, { x: lastHover.x, y: lastHover.y }, true);
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || !e.ctrlKey) hideHoverDoc();
});

// ---------------------------------------------------------------------------------------------
// Everything that makes a CodeMirror instance a poptart live-coding pane rather than a text box -
// the completion popup, the ctrl-hover docs, and the focus bookkeeping activeCM() reads - wired
// onto ONE editor. All of it is per-editor state (the buffer, the cursor, the wrapper's box), so
// DJ mode's deck B gets the same treatment the moment its CodeMirror is built (see openMixMode).
// ---------------------------------------------------------------------------------------------
let lastFocusedCM = null; // the caret's last home; see activeCM

function attachEditorWiring(editor) {
  editor.on('focus', () => { lastFocusedCM = editor; });
  // Auto-open the hint popup while typing (quotes/parens/word chars, plus spaces so multi-word
  // param names like "Filter 1 Freq" keep the popup alive).
  editor.on('inputRead', (ed, change) => {
    if (ed.state.completionActive) return;
    const typedChar = change.text[change.text.length - 1].slice(-1);
    if (/[\w"'( ]/.test(typedChar)) showPoptartHint(ed);
  });
  // Backstop for show-hint's asymmetry: a completion session that already lost its popup closes
  // without signalling its result, so hang the panel's last word on the editor-level event.
  editor.on('endCompletion', hideHintDoc);
  editor.on('scroll', hideHoverDoc); // the code moved out from under the pointer
  const wrapper = editor.getWrapperElement();
  wrapper.addEventListener('mousemove', (e) => updateHoverDoc(editor, { x: e.clientX, y: e.clientY }, e.ctrlKey));
  wrapper.addEventListener('mouseleave', () => updateHoverDoc(editor, null, false));
}

attachEditorWiring(cm);

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
  const arr = arrangeMod && findArrangeCallAt(code, idx);
  if (arr?.onName) {
    if (!arState || arr.start !== arState.callStart) openArrangeEditor(arr);
    arCanvas.focus({ preventScroll: true }); // the keys (delete, undo) belong to the clips now
    return true;
  }
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
  const packCall = findSpCallAt(code, idx);
  if (packCall?.onName) {
    // An empty sp() has no name yet. Give it one, then open whatever it became - the same bookmark
    // dance as the roll's, since the definition is written below and moves nothing above it.
    if (!code.slice(packCall.open + 1, packCall.close).trim()) {
      const at = cm.setBookmark(cm.posFromIndex(idx));
      const named = packDefs.materialize();
      const back = at.find();
      at.clear();
      if (named && back) return openWidgetAt(cm.getValue(), cm.indexFromPos(back));
    }
    openPackFromCall(packCall, code);
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
  // Read but never authored by the panel: the playhead has to count from the same offset the
  // engine does, and both of these have to survive a rate/mode edit instead of being written away
  // by one (see lfoCfgText).
  const num = (key) => Number((new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(-?[\\d.]+)`).exec(inner) ?? [])[1]) || 0;
  const phase = num('phase');
  const glide = num('glide');
  let points = null;
  try {
    if (shapeMatch?.[2]?.trim()) points = shapeMod.parseShapePoints(shapeMatch[2]);
  } catch {
    // unparseable shape string - fall back to the default below
  }
  if (!points) points = shapeMod.parseShapePoints('0,0 0.5,1 1,0');
  return { points, rate, rateHz, phase, glide, mode: ['free', 'retrigger', 'envelope'].includes(mode) ? mode : 'free' };
}

// The options an lfo() call carries - the half that belongs to the CALL rather than to the shape.
function lfoCfgText({ rate, rateHz, mode, phase, glide }) {
  const parts = [`rate: ${rateHz ? `"${rate}hz"` : String(rate)}`];
  if (mode !== 'free') parts.push(`mode: '${mode}'`);
  // Options the panel has no control for are carried through rather than rewritten away: an edit
  // to the rate is an edit to the rate.
  if (phase) parts.push(`phase: ${phase}`);
  if (glide) parts.push(`glide: ${glide}`);
  return `{ ${parts.join(', ')} }`;
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
  const { rate, rateHz, mode, phase, glide } = parseLfoCall(parts.opts);
  return { callSource: lfoState.callSource, options: { rate, rateHz, mode, phase, glide } };
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
  const { rate, rateHz, mode, phase, glide } = parseLfoCall(code.slice(call.open + 1, call.close));
  if (openShapeById(id, { callSource, options: { rate, rateHz, mode, phase, glide } })) return true;
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
    lfoState.phase = parsed.phase;
    lfoState.glide = parsed.glide;
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

// The track whose notes gate this shape: the region containing the lfo() call the panel was opened
// through (or the inline lfo() itself). Null for a definition opened straight from the picker -
// a _shape(...) on its own belongs to no track, and several calls may be playing it at once.
function lfoGateRegion() {
  const range = (lfoState?.callSource ?? lfoState?.marker)?.find();
  if (!range) return null;
  const from = cm.indexFromPos(range.from);
  const to = cm.indexFromPos(range.to);
  for (const r of patternRegions) {
    if (r.deck !== 'a') continue; // panels live on the main editor; deck B's offsets are another doc's
    const a = r.anchor.find();
    if (!a) continue;
    if (cm.indexFromPos(a.from) <= from && cm.indexFromPos(a.to) >= to) return r;
  }
  return null;
}

// The last note onset at or before `cyclePos` on `region`, in absolute cycles, or null if the grid
// holds none (nothing has played yet, or the look-back ran off the loaded window). Bounded, since
// a track that has stopped emitting - a `.when()` gone quiet - would otherwise walk to gridFrom
// every frame.
const LFO_GATE_LOOKBACK = 16; // cycles
function lastGateBefore(region, cyclePos) {
  const cycle = Math.floor(cyclePos);
  for (let k = 0; k <= LFO_GATE_LOOKBACK; k++) {
    const cyc = cycle - k;
    if (cyc < gridFrom) break;
    const gates = region.gates.get(cyc);
    if (!gates?.length) continue;
    // Sorted ascending, so the last one that has happened is the one this note is playing from.
    for (let i = gates.length - 1; i >= 0; i--) {
      if (cyc + gates[i] <= cyclePos) return cyc + gates[i];
    }
  }
  return null;
}

// The LFO's phase at this instant, 0..1, or null when there is nothing honest to draw (the panel
// is closed, the clock is stopped, or a note-gated shape has no note to count from yet).
//
// The count is pattern-core's lfoPhaseCount, read the same way the engine's own anchor reads it
// (see scheduler _anchorLFOs): a synced rate counts CYCLES off the transport grid, a "0.5hz" one
// counts seconds and ignores the grid. In the note-gated modes the count starts at the last note
// onset instead, exactly as the engine's t_trig does - a retrigger wraps, an envelope plays once
// and holds its final level, so its line parks at the right edge until the next note.
//
// One thing it does not follow: a patterned lfo("<a b>") restarts its shape at each swap, and the
// swap cycle lives on the scheduler (see _scheduleShapeSwaps). The line is right wherever a swap
// lands on a period boundary - one shape per pass, which is what a shape pattern is usually for -
// and drifts within a pass otherwise.
function lfoPhaseNow() {
  if (!lfoState || transport.paused) return null;
  const pos = currentCyclePos();
  let turns;
  if (lfoState.mode === 'free') {
    turns = lfoState.rateHz ? (Date.now() / 1000) * lfoState.rate : pos * lfoState.rate;
  } else {
    const region = lfoGateRegion();
    const gate = region && playing ? lastGateBefore(region, pos) : null;
    if (gate == null) return null;
    const sinceCycles = pos - gate;
    turns = lfoState.rateHz ? (sinceCycles / transport.cps) * lfoState.rate : sinceCycles * lfoState.rate;
    // An envelope plays the shape once and holds its final level - and takes no phase offset, the
    // one mode that doesn't (poptart.scd's shape def sweeps it as `Sweep.min(1)`), since starting
    // a one-shot part-way in is what a shorter shape is for.
    if (lfoState.mode === 'envelope') return Math.min(1, turns);
  }
  const total = turns + (lfoState.phase ?? 0);
  return ((total % 1) + 1) % 1;
}

// One repaint per frame while the panel is open and the clock is running. Stops itself when the
// panel closes, like the piano roll's own loop.
let lfoRaf = null;
// The breakpoint being dragged, if any. Module-level rather than initLfoCanvas's own, because the
// follow loop has to know: swapping the shape out from under a pointer that is bending it would
// land the drag on whichever shape the pattern moved on to.
let lfoDrag = null; // { kind: 'point'|'curve', index }

let lfoPlayheadOn = false; // whether the last frame drew a line, so a stop clears it exactly once

function lfoPlayheadLoop() {
  if (!lfoState) { lfoRaf = null; return; }
  lfoFollowPlayingShape();
  // Stopped with a line still on the canvas: one more pass to wipe it, then idle (the loop keeps
  // spinning cheaply, like the piano roll's own).
  if (!transport.paused || lfoPlayheadOn) drawLfoShape();
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

  // Where the shape is right now, as a line down the canvas - on the transport's own grid in free
  // mode, and counted from the last note that gated it in the other two (see lfoPhaseNow).
  const phase = lfoPhaseNow();
  lfoPlayheadOn = phase != null;
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

// sp("kit") names a pack, in builder or method form alike (note("c e").sp("kit")); the
// lookbehind keeps `.speed(` - whose name merely starts with the same letters - from matching.
function findSpCallAt(code, idx) {
  return findNamedCallAt(code, idx, /(?<![\w$])\.?\s*sp\s*\(/g, 'sp');
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
// snaps to the height you're holding it at (see prPaintLane). Right-click the lane for randomize /
// reset of the channel - the selection, or the roll. A note dropped on one already sounding at that pitch keeps its own
// length and the one underneath gives way - cut short, or hidden if it was landed on square - and
// gets everything back the moment the note on top moves away (see prClipOverlaps). ctrl+Q
// QUANTIZES - a dialog asks which division (the roll's grid one notch coarser, by default), onsets
// snap onto it and every drawn nudge goes back to 0. It is also the one edit that settles the
// overlap rule for keeps: buried notes are deleted outright and a clipped one gives up the tail
// that was hiding behind the note in front of it, so afterwards the roll says exactly what it
// plays (see prQuantize). Wheel scrolls
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
// synth; →♪ rewrites the whole roll as an equivalent mini-notation note("…"). ⌨ turns the typing
// keyboard into a piano aimed at this roll's track (see the computer-keyboard section), the
// header's ● rec records what you play INTO the roll - the take lands on the grid as you play it,
// over itself if the roll is shorter, and the count-in's notes before cell 0 - and `capture` does
// the same after the fact for whatever was just played (see the MIDI record section). Every change is
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
const prMenu = document.getElementById('pianorollMenu'); // right-click menu over the value lane
const prToMiniBtn = document.getElementById('pianorollToMini');
const prKeysBtn = document.getElementById('pianorollKeys'); // ⌨ - the computer keyboard plays this roll's track
const prCaptureBtn = document.getElementById('pianorollCapture'); // what was just played, into the roll
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
// Top row when a fresh/empty roll opens - a MIDI note, framed 24 rows down to 60, so the window is
// the two octaves starting at middle C. The bottom row is the sampler's native pitch: MIDI 60 is
// where a sample plays as recorded (DEFAULT_SYNTH_NOTE, and the engine's repitch anchor), so on a
// sampler roll the "as recorded" row is the floor of the window rather than somewhere off the
// bottom of it. Repitching DOWN now has room below that floor (5 octaves of it, where the old
// anchor at 24 left only 2) - scroll to reach it. A roll that already HAS notes ignores this and
// frames its own (prFramePitch), so this is only what an empty one opens at.
const PR_DEFAULT_TOP = 83;
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
const PR_PUSH_COALESCE_MS = 60;  // ...and fastest a held gesture re-files the roll with the player
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

// Cursors that echo the tool under the pointer (a pencil, a bracket, an up-down arrow), as inline
// SVGs so no asset files are needed. The trailing two numbers are the hotspot.
const svgCursor = (svg, x, y, fallback) => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CUR_PENCIL = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2.5 17.5l1.2-3.2 9-9 2 2-9 9-3.2 1.2z" fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/><path d="M13 4.5l2-2 2 2-2 2z" fill="#7aa2ff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  2, 18, 'crosshair',
);
// The trim cursors are ONE bracket each, facing the edge under the pointer: `[` on a left edge,
// `]` on a right one. A symmetric double arrow says "this resizes" but not which end you have
// hold of, and with notes, clips and loop regions all trimming from either side, that is the
// half of the answer worth showing.
const CUR_BRACKET_L = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="20" viewBox="0 0 18 20"><path d="M11 3H7v14h4" fill="none" stroke="#111" stroke-width="3.2" stroke-linejoin="round"/><path d="M11 3H7v14h4" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  7, 10, 'ew-resize',
);
const CUR_BRACKET_R = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="20" viewBox="0 0 18 20"><path d="M7 3h4v14H7" fill="none" stroke="#111" stroke-width="3.2" stroke-linejoin="round"/><path d="M7 3h4v14H7" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  11, 10, 'ew-resize',
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
let prPrebakePacks = []; // ...and for sample packs: [{ id, files }] - the files, since the pack panel shows them
let prRaf = null; // requestAnimationFrame handle for the playhead sweep
let prPlayheadOn = false; // whether the last frame drew a playhead (so we clear it once on stop)
let prPointer = { px: -1, py: -1 }; // last pointer position, for live cursor updates on cmd-key changes
let prRefreshCursor = () => {}; // re-derives the canvas cursor in place (set by initPianorollCanvas)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// c3 = 60 (see notes.mjs), so the octave number is two below the raw MIDI octave: 60 -> C3,
// and the bottom of the range reads C-2, which is what plugin displays show there too.
const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`;
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
  prSyncKeyboardBtn(); // the ⌨ tooltip names the tonic when the keyboard is transposed to the key
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
      // `intervals` (semitones above the root, ascending from 0) is what the ⌨'s in-key layout is
      // built from; `pcs` is what the roll's lanes are coloured by.
      info = { tonic: pitchClass(rootMidi), intervals, pcs: new Set(intervals.map((iv) => pitchClass(rootMidi + iv))) };
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
 * change - and a selection is a set of those same events, so what you had selected stays selected
 * on the other axis.
 */
function prSetMode(mode) {
  if (!prState || prState.mode === mode) return;
  prState.mode = mode;
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

/**
 * The track that PLAYS the roll on screen - what a preview sounds through, what the ⌨ keys play, and
 * whose live notes a recording or a capture writes in here. An inline pianoroll() is in its track's
 * block. A named roll's definition sits in the definitions block at the foot, so its track is the
 * one whose pianoroll("<…>") the panel was opened through (the `source` marker), or failing that
 * the first call in the buffer that names it. Null when nothing plays it.
 */
function prPlayingTrack() {
  if (!prState || !labelsMod) return null;
  const code = cm.getValue();
  const labelAt = (idx) => labelsMod.splitLabeledBlocks(code).find((b) => idx >= b.start && idx < b.end)?.label ?? null;
  const src = prState.source?.find();
  if (src) return labelAt(cm.indexFromPos(src.from));
  if (prState.rollId != null) {
    const call = rollDefs.refCalls(code, prState.rollId)[0];
    if (call) return labelAt(call.start);
  }
  return prState.trackLabel;
}

// --- note preview: play the drawn note through the track's own synth (if the 🎧 toggle is on and
// the track has been evaluated with an instrument). One note at a time; always paired with an off.
function prPreviewSend(note, isOn) {
  const trackId = prPlayingTrack();
  if (!trackId) return;
  api('POST', '/api/previewNote', { trackId, note, vel: PR_DEFAULT_VEL, isOn }).catch(() => {});
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
  // start: where the loop window opens, in cells - negative when it has been slid back over the
  // notes before 0. 0 (the default) is left out of the code entirely.
  const startM = /\bstart\s*:\s*(-?\d+)/.exec(inner);
  const start = startM ? Math.round(Number(startM[1])) : 0;
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
/**
 * The roll's options as the OBJECT the builder takes, defaults left out. The call text below and
 * the live push (prPushRoll) are both formed from this, so what a drag SOUNDS like can't drift from
 * what the code says once the drag is written down.
 */
function prCallOpts({ grid, len, start, mode, swing, swinggrid }) {
  const opts = { grid, len };
  if (start) opts.start = start; // a window that opens at 0 is the default - don't write it
  if (mode === 'index') opts.mode = 'index'; // notes are the default - don't write it
  // A straight roll writes no swing at all, and one swinging its own grid writes no division: both
  // are what the builder assumes, and a roll that says nothing about groove should look like one.
  if (swing) opts.swing = Math.round(swing * 100000) / 100000;
  if (swing && swinggrid && swinggrid !== grid) opts.swinggrid = swinggrid;
  return opts;
}

const prOptsText = (opts) =>
  Object.entries(opts).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join(', ');

function serializePianorollCall(state) {
  const { notes, idLiteral } = state;
  const body = `"${pianorollMod.serializePianoRoll(prLiveNotes(notes))}", { ${prOptsText(prCallOpts(state))} }`;
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
  function allIds(sc = null, code = cm.getValue()) {
    const own = defsInBuffer(code).map((d) => ({ id: d.id, scope: d.scope, note: '', own: true }));
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

  // ★ - the library. A definition lives and dies with the buffer it was drawn in; pinning one copies
  // it into a prebake source the server keeps (see server.js's PINNED_FILE), so the name is a
  // library name in every project from then on - an option in every picker, and a name patterns
  // can say. The buffer keeps its own copy, which shadows the library's exactly as any buffer
  // definition shadows prebake, so pinning changes nothing about what is playing now.
  const pinnedEntry = (id, sc) => pinnedDefs.find((e) => e.kind === kind && e.id === String(id) && sameScope(e.scope, sc ?? '')) ?? null;
  const defText = (code, def) => code.slice(def.start, def.close + 1);

  /**
   * Where `id` stands with the library: 'none' (not pinned), 'same' (pinned, and this buffer's
   * copy is that copy), 'differs' (pinned, but this buffer's copy has moved on - drawn into since),
   * or 'library' (pinned, and nothing in this buffer defines it - the library is where it lives).
   */
  function pinState(id, sc = null) {
    const e = pinnedEntry(id, sc);
    if (!e) return 'none';
    const code = cm.getValue();
    const def = findDef(code, id, sc);
    if (!def) return 'library';
    return defText(code, def) === e.code ? 'same' : 'differs';
  }

  /** Copies this buffer's definition of `id` into the library (over an older pinned copy, if any). */
  async function pin(id, sc = null) {
    const code = cm.getValue();
    const def = findDef(code, id, sc);
    if (!def) return say(`can't pin ${kind} "${id}": its definition is not in this buffer`, true);
    const had = pinnedEntry(id, def.scope);
    try {
      const res = await api('POST', '/api/pinned', { kind, id: String(id), scope: def.scope ?? '', code: defText(code, def) });
      pinnedDefs = res.pinned ?? pinnedDefs;
      for (const msg of res.errors ?? []) say(`library: ${msg}`, true);
      say(had
        ? `★ ${kind} "${id}" in your library updated to this buffer's copy`
        : `★ ${kind} "${id}" is in your library - every project can play it now`);
      prRefreshRollList();
    } catch (err) {
      say(`can't pin ${kind} "${id}": ${err.message ?? err}`, true);
    }
  }

  /**
   * Takes `id` out of the library. When nothing in this buffer defines it, a copy goes into the
   * buffer FIRST - taking a library name away from the patterns here that say it would silence
   * them, and "not in the library any more" was never meant to mean "gone".
   */
  async function unpin(id, sc = null) {
    const e = pinnedEntry(id, sc);
    if (!e) return;
    const code = cm.getValue();
    let copied = false;
    if (!findDef(code, id, e.scope)) {
      const inner = e.code.slice(e.code.indexOf('(') + 1, e.code.lastIndexOf(')'));
      const body = splitFirstArg(inner)[1].trim();
      const [from, to, text] = defsEdit(code, [{ id: String(id), scope: e.scope }], () => body);
      cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to));
      refoldAll();
      copied = true;
    }
    try {
      const res = await api('POST', '/api/pinned/remove', { kind, id: String(id), scope: e.scope ?? '' });
      pinnedDefs = res.pinned ?? pinnedDefs;
      for (const msg of res.errors ?? []) say(`library: ${msg}`, true);
      say(`${kind} "${id}" is out of your library${copied ? ' - this buffer keeps its own copy' : ''}`);
      prRefreshRollList();
      if (copied) panel.scheduleEval();
    } catch (err) {
      say(`can't take ${kind} "${id}" out of your library: ${err.message ?? err}`, true);
    }
  }

  return { kind, section, defCall, useCall, legacyCall, libraryNote, isIdString, isIdCall, defsInBuffer, findDef, idCalls, refCalls, runs, removalRange, defsEdit, allIds, materialize, create, remove, rename, duplicate, pinState, pin, unpin };
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
    ghost: [], // keys still down in a take being recorded into this roll, drawn where they will land (see prRecGhosts); never serialized
    take: null, // the recording under way's books - which events are in, which notes are the take's (see prRecTake)
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
  prSyncKeyboardBtn(); // ⌨ carries over a follow-switch (same track), and is off on a fresh open
  prRecGhosts(); // a recording already under way shows in the roll it just opened on
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
    if (r.deck !== 'a') continue; // panels read main-editor offsets; deck B's are another doc's
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

// The ★ on a picker row (see makeNamePicker): outline for an unpinned one, filled once it is in the
// library - one shape, the CSS decides the fill.
const DEF_PICK_STAR_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.5.8-4.8 4.5 1.3 6.4L12 17.3l-5.8 3.1 1.3-6.4-4.8-4.5 6.5-.8z"/></svg>';

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
      // In an inline list the rows ARE the panel, so the open one's name is also where it is
      // renamed: click it and type (the same rename as the head's box - the definition and every
      // call that names it move together). A row that isn't open opens on click, as ever.
      if (inline && row.act === 'open' && row.own && row.id === current()) {
        name.title = 'click to rename';
        name.classList.add('def-pick-renamable');
        name.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          idx = i;
          renameInline(el, name, row);
        });
      }
      el.appendChild(name);
      // ★ - in the library or not (see makeDefRegistry's pin). On this buffer's own rows, and on
      // library rows that are pinned; a library row that comes from prebake.js by hand has no star,
      // since the file it lives in is already every project's.
      const pinned = row.act === 'open' ? reg.pinState(row.id, row.scope) : 'none';
      if (row.act === 'open' && (row.own || pinned !== 'none')) {
        const star = document.createElement('span');
        star.className = `def-pick-star ${pinned}`;
        star.innerHTML = DEF_PICK_STAR_SVG; // drawn, not typed: the text ☆ is a runt next to ⧉ → ×
        star.title = {
          none: `add ${row.id} to your library - every project gets it`,
          same: `${row.id} is in your library - click to take it out`,
          differs: `${row.id} is in your library, but this buffer's copy has changed - click to update it (⇧click takes it out)`,
          library: `${row.id} comes from your library - click to take it out (this buffer keeps a copy)`,
        }[pinned];
        star.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          e.stopPropagation(); // the row's own handler opens it instead
          idx = i;
          if (pinned === 'none' || (pinned === 'differs' && !e.shiftKey)) await reg.pin(row.id, row.scope);
          else await reg.unpin(row.id, row.scope);
          if (isOpen()) renderList();
          if (isOpen()) els.search.focus();
        });
        el.appendChild(star);
      }
      // A filled star already says "library"; the note is for what the star can't - a hand-written
      // prebake definition (no star), or the create row's "new".
      if (row.note && !(row.note === reg.libraryNote && pinned !== 'none')) {
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

  // The row's name swapped for a box holding it: Enter or leaving commits, Escape puts it back.
  function renameInline(el, name, row) {
    const box = document.createElement('input');
    box.className = 'def-pick-rename';
    box.type = 'text';
    box.value = row.id;
    box.spellcheck = false;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const to = box.value.trim();
      if (commit && to && to !== row.id) reg.rename(row.id, to, row.scope);
      if (isOpen()) renderList();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation(); // the list's own arrows/delete must not fire while typing a name
    });
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    box.addEventListener('blur', () => finish(true));
    el.replaceChild(box, name);
    box.focus();
    box.select();
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
      prPrebakePacks = (res.packs ?? [])
        .filter((r) => r.layer === 'prebake')
        .map((r) => ({ id: String(r.id), files: (r.files ?? []).map(String) }));
      pinnedDefs = res.pinned ?? pinnedDefs; // the ★s every picker draws
      if (prState?.rollId && !prPicker.classList.contains('hidden')) prRenderPickList();
      if (packState) packRenderList();
    })
    .catch(() => {}); // the picker still lists this buffer's rolls without it
}

function closePianorollEditor() {
  prClosePicker();
  prCloseLaneMenu();
  prPreviewOff();
  // The keyboard plays the roll on screen; no roll, nothing for it to play - and no lit ⌨ to
  // tell you your typing is being eaten.
  if (prKbOn) { prKbOn = false; kbReleaseAll(); prSyncKeyboardBtn(); }
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
  prPushFlush(); // whatever the gesture last pushed is now what the code says - land it either way
  writePianorollCall();
}

// ---------------------------------------------------------------------------------------------
// The live channel: re-file the roll with the PLAYER, without touching the code.
//
// A roll played by name is resolved once per cycle (see rollPattern in signal.mjs), so registering
// new notes under the id a pattern already names is heard on the next cycle - no buffer rewrite, no
// re-transpile of the patch, no history entry, no autosave. That is what a held gesture wants: the
// value you are dragging should SOUND now, while the code, the undo step and the eval belong to the
// moment you let go.
//
// Only a NAMED roll can be pushed - _roll("lead", …), which is what the panel writes and what
// auto-naming gives an empty pianoroll(). A hand-written pianoroll("60,0,4 …") carries its notes
// in the call itself, with nothing to re-file, so it falls back to the old write-the-code path and
// is simply heard when the drag settles.
// ---------------------------------------------------------------------------------------------
let prPushTimer = null;
function prPushRoll() {
  if (!prState?.idLiteral) return;
  const id = idLiteralValue(prState.idLiteral);
  if (id === null) return; // an id built from a variable - not a name we can put on the wire
  api('POST', '/api/liveRoll', {
    id,
    notes: pianorollMod.serializePianoRoll(prLiveNotes(prState.notes)),
    opts: prCallOpts(prState),
  }).catch(() => {}); // one dropped frame of a drag is not worth a console line; the write settles it
}

function prPushSoon() {
  if (prPushTimer) return; // already on the way - it will pick up whatever the state says by then
  prPushTimer = setTimeout(() => { prPushTimer = null; prPushRoll(); }, PR_PUSH_COALESCE_MS);
}

/** Send the push a coalescing timer is still sitting on, so the last frame of a drag isn't lost. */
function prPushFlush() {
  if (!prPushTimer) return;
  clearTimeout(prPushTimer);
  prPushTimer = null;
  prPushRoll();
}

/**
 * What a HELD gesture calls on every frame that changed something: the player hears it now, and the
 * code is left alone until the gesture ends (see prWriteNow).
 */
function prLiveSync() {
  if (prState?.idLiteral) prPushSoon();
  else prWriteSoon(); // legacy inline roll: its notes only exist in the call, so the call is the channel
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
    // Typed `mode: "index"` into the call by hand - the same change of view the button makes,
    // selection included (see prSetMode).
    prState.mode = parsed.mode;
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

// Rendered columns: the loop window's end - or the end of the last note, whichever is further -
// rounded up to its next whole bar, plus a little headroom to drag into. Notes are not fenced in by
// the window (they can be moved out of it and back, and a take records before it), so the grid
// shows wherever they are. Frozen (prState._dragCols) for the length of any drag that moves
// notes or the window, so the cell width - and thus the drag mapping - stays put instead of feeding
// back on itself as the thing being dragged changes.
const prRenderCols = () => {
  let end = prLoopEnd();
  for (const nt of prState.notes) if (!nt.hidden && nt.start + nt.len > end) end = nt.start + nt.len;
  for (const g of prState.ghost) if (g.start + g.len > end) end = g.start + g.len;
  return (Math.floor(end / prState.grid) + 1) * prState.grid + 4;
};

// The leftmost rendered column: 0, or - when the roll holds notes BEFORE its own time (a recorded
// count-in, which record.mjs writes at negative cells; a take being recorded, still a ghost), or the
// window has been slid back over them - the bar line at or before the earliest of those, so they
// are on screen. Frozen during a drag like the right edge (prState._dragMin), for the same reason.
const prMinCell = () => {
  let min = Math.min(0, prState.start);
  for (const nt of prState.notes) if (!nt.hidden && nt.start < min) min = nt.start;
  for (const g of prState.ghost) if (g.start < min) min = g.start;
  return Math.floor(min / prState.grid) * prState.grid;
};

// The loop window: `len` cells from `start` (negative when slid back before 0). Notes outside it
// are drawn (dimmed) but never sound. Drawing starts inside it; dragging and nudging move notes
// freely across it, and duplicating/pasting lands copies within it.
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
  const c0 = Math.max(m.minCell, Math.floor(m.scroll));
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
  const minCell = prState._dragMin ?? prMinCell(); // <= 0: the rendered span runs minCell..cols
  const cellW = (gridW / (cols - minCell)) * prState.zoom;
  const visibleCells = gridW / cellW; // = (cols - minCell) / zoom
  const maxScroll = Math.max(minCell, cols - visibleCells);
  const scroll = Math.min(maxScroll, Math.max(minCell, prState.scrollCells));
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
  return { W: prW, H: PR_CH, gridTop: PR_TOPBAR, gridH: PR_GRIDH, laneTop: PR_TOPBAR + PR_GRIDH, laneH: PR_LANEH, gridW, cols, minCell, cellW, rowH, visibleCells, maxScroll, scroll, lanes, laneOf, laneMax, bottomPos: prState.pitchTop - PR_ROWS };
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
  return cell >= m.minCell && cell < m.cols ? cell : null;
}

const prClampCell = (px, m) => Math.max(m.minCell, Math.min(m.cols - 1, Math.floor(prCellFloat(px, m))));

// How far a dragged SELECTION may move, asked for `by` cells: the whole group shifts by one number,
// clamped so that its first note stays on the rendered grid (the frozen one, during a drag) - never
// per note, which would pile the leading notes up against an edge and change the timing between
// them. Notes are free to leave the loop window (and come back): the window is what PLAYS, not a
// fence, and a take recorded before it has to be draggable into it.
const prGroupShift = (starts, by, m) => {
  const lo = Math.min(...starts);
  const hi = Math.max(...starts);
  return Math.max(m.minCell - lo, Math.min(m.cols - 1 - hi, by));
};
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
  for (let c = m.minCell; c <= m.cols; c += prState.grid) { // minCell is a bar line (see prMinCell)
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
// dragged anywhere on the timeline - back over the notes before 0 too - and the window never
// closes below one cell).
function prSetLoopEdge(edge, cell) {
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

/** Whatever outside the canvas names the lane's channel - nothing, now the lane's menu reads it live. */
function prSyncLaneChannel() {}

/** What a channel goes back to when reset: full velocity, certain to play, on its cell. */
const PR_LANE_DEFAULT = { vel: 1, prob: 1, nudge: 0 };

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

/** The notes a lane-wide edit acts on: the selection if there is one, otherwise the whole roll. */
const prLaneTargets = () => (prState.sel.size ? [...prState.sel].filter((nt) => !nt.hidden) : prLiveNotes(prState.notes));

/**
 * Set the lane's channel on every target note from `valueFor(note)` - the one edit behind the lane
 * menu's randomize (uniform across the channel's own range: 0..1 for vel and prob, half a cell
 * either way for nudge, which is what a die does) and reset (PR_LANE_DEFAULT - which is how a
 * quantized take gets its nudges, kept on record, snapped away: see recordingToRoll).
 */
function prSetLane(valueFor) {
  if (!prState) return;
  const key = prLaneKey();
  const targets = prLaneTargets();
  if (!targets.length) return;
  for (const nt of targets) nt[key] = valueFor(nt);
  writePianorollCall();
  drawPianoroll();
}

/**
 * Right-click on the value lane (or its channel label): a small menu to randomize or reset the
 * channel on show, over the selection if there is one and the whole roll otherwise - the menu says
 * which. The only place those two live; a lane is what you'd reach for to do either.
 */
function prOpenLaneMenu(clientX, clientY) {
  if (!prState) return;
  const key = prLaneKey();
  const n = prLaneTargets().length;
  const scope = prState.sel.size ? `selection (${n})` : `all notes (${n})`;
  openCtxMenu(prMenu, clientX, clientY, {
    head: `${key} · ${scope}`,
    after: () => prRefocus(),
    items: [
      [`randomize ${key}`, () => prSetLane(() => prLaneDenorm(Math.random(), key))],
      [`reset ${key} to ${PR_LANE_DEFAULT[key]}`, () => prSetLane(() => PR_LANE_DEFAULT[key])],
    ],
  });
}

function prCloseLaneMenu() {
  prMenu.classList.add('hidden');
}

/**
 * Fills one of the app's context menus and puts it on screen under the pointer. Two callers so far
 * - the piano roll's value lane and the editor's own menu - and the widget, the placement and the
 * dismissal are the same for both; only the items differ.
 *
 *   head   the small uppercase line above the items (optional)
 *   items  [label, fn, title?] entries, or the string '-' for a rule between groups
 *   after  run once an item has been chosen, for a caller that has focus to give back
 */
function openCtxMenu(el, clientX, clientY, { head = '', items = [], after = null } = {}) {
  el.innerHTML = '';
  if (head) {
    const h = document.createElement('div');
    h.className = 'ctx-menu-head';
    h.textContent = head;
    el.appendChild(h);
  }
  for (const entry of items) {
    if (entry === '-') {
      el.appendChild(document.createElement('hr'));
      continue;
    }
    const [label, fn, title] = entry;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', () => { el.classList.add('hidden'); fn(); after?.(); });
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  // On screen where the pointer is, nudged back in if that would run off the window's edge.
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.min(clientX, window.innerWidth - w - 8)}px`;
  el.style.top = `${Math.min(clientY, window.innerHeight - h - 8)}px`;
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

  // A take being recorded into this roll, as it happens (see prRecGhosts): the notes the recorder
  // has so far, where they will land - count-in notes in the armed colour, the window's in the
  // recording colour, a key still down drawn hollow. Ghosts until the take is written.
  if (prState.ghost.length) {
    const armCol = col('--warn');
    const liveCol = col('--err');
    for (const g of prState.ghost) {
      const pos = prPosOf(index ? g.index : g.midi, m);
      if (pos > prState.pitchTop + 1 || pos < m.bottomPos) continue;
      const x = prCellToX(g.start, m);
      const x2 = prCellToX(g.start + g.len, m);
      if (x2 <= PR_GUTTER || x >= W) continue;
      const dx = Math.max(PR_GUTTER + 0.5, x);
      const dx2 = Math.min(W, x2);
      const y = prPosToY(pos, m);
      const w = Math.max(2, dx2 - dx - 1);
      ctx.fillStyle = ctx.strokeStyle = g.countIn ? armCol : liveCol;
      ctx.lineWidth = 1;
      ctx.setLineDash(g.held ? [3, 2] : []);
      ctx.globalAlpha = g.held ? 0.25 : 0.35 + 0.4 * g.vel;
      prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.fill();
      ctx.globalAlpha = 0.9;
      prRoundRect(ctx, dx + 1, y + 1.5, w, rowH - 3, 3); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
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
    const edge = prLoopEdgeAt(px, m);
    return edge === 'move' ? 'grab' : edge === 'start' ? CUR_BRACKET_L : CUR_BRACKET_R;
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
  if (px >= prCellToX(nt.start + nt.len, m) - PR_EDGE_PX) return CUR_BRACKET_R; // right-edge = length
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

// The names the quantize dialog puts on a division, by cells per cycle. A grid with no name (an
// unusual roll) is offered as its own count, which is the honest thing to call it.
const PR_DIV_NAMES = { 1: '1/1', 2: '1/2', 3: '1/2T', 4: '1/4', 6: '1/4T', 8: '1/8', 12: '1/8T', 16: '1/16', 24: '1/16T', 32: '1/32', 48: '1/32T', 64: '1/64' };
const prDivLabel = (n) => PR_DIV_NAMES[n] ?? `${n}/cycle`;

/**
 * ctrl+Q: straighten the roll out. A small dialog asks which division to snap to - the roll's own
 * grid one notch coarser, by default, since quantizing to the grid you drew on moves nothing - and
 * quantizePianoRoll does the rest: onsets snap, nudges go back to 0, buried notes are deleted and
 * clipped ones lose the tail that was hiding behind the note in front of them.
 *
 * The selection is what moves when there is one, like every other edit here; with nothing selected
 * it is the whole roll. Deleting is the one thing this does that no other roll edit does - the
 * overlap rule is otherwise always recoverable - which is why it asks first rather than being a
 * bare keystroke, and why it lands as one undo step like anything else.
 */
async function prQuantize() {
  if (!prState || !pianorollMod) return;
  const sel = [...prState.sel];
  const count = sel.length || prLiveNotes(prState.notes).length;
  const scope = `${sel.length ? 'the selection' : 'the whole roll'} (${count} note${count === 1 ? '' : 's'})`;
  const grid = prState.grid;
  const div = await askSelect(`Quantize ${scope}`, {
    label: 'to',
    options: pianorollMod.pianoRollQuantizeDivs(grid).map((d) => [d === grid ? `${prDivLabel(d)} (the roll's grid)` : prDivLabel(d), d]),
    value: pianorollMod.pianoRollDefaultQuantizeDiv(grid),
    confirm: 'quantize',
  });
  prRefocus(); // the dialog took the keyboard - the grid gets it back either way
  if (div == null || !prState) return; // cancelled, or the panel closed while the dialog was up
  const { notes, dropped, snipped } = pianorollMod.quantizePianoRoll(prState.notes, {
    grid,
    div,
    only: sel.length ? sel : null, // ...and the tidy-up is the whole roll regardless; see there
  });
  prState.notes = notes;
  const kept = new Set(notes);
  for (const n of [...prState.sel]) if (!kept.has(n)) prState.sel.delete(n); // deleted for good
  writePianorollCall();
  drawPianoroll();
  const lost = [
    dropped ? `${dropped} note${dropped === 1 ? '' : 's'} deleted` : null,
    snipped ? `${snipped} shortened` : null,
  ].filter(Boolean);
  if (lost.length) logLine(`piano roll: quantized to ${prDivLabel(div)} - ${lost.join(', ')} (cmd-Z with the grid focused puts them back)`);
  // The notes are on the grid now, and the knob still pushes them off it as they play - which is
  // worth saying, since "quantize" and "still swinging" look like a contradiction on screen.
  if (prState.swing) logLine(`piano roll: the swing knob is still at ${prState.swing} - the notes are quantized, but the roll's groove is still applied to them as they play.`);
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
      ? (d.edge === 'move' ? 'grabbing' : d.edge === 'start' ? CUR_BRACKET_L : CUR_BRACKET_R)
      : { vel: CUR_UPDOWN, lane: CUR_UPDOWN, paint: CUR_PENCIL, resize: CUR_BRACKET_R, move: 'grabbing', create: CUR_PENCIL, marquee: 'crosshair', audition: 'pointer' }[d.kind] ?? 'default');

  // ctrl-drag (mac) = velocity, not a menu - except over the value lane, which has one of its own
  // (randomize / reset the channel it shows; see prOpenLaneMenu).
  prCanvas.addEventListener('contextmenu', (e) => {
    if (!prState) return;
    e.preventDefault();
    const { py } = prCanvasPos(e);
    if (py >= prMetrics().laneTop) prOpenLaneMenu(e.clientX, e.clientY);
  });
  // The menu goes away on any press outside it (its items act on click, so a press ON it must not
  // hide them first), and on Escape.
  document.addEventListener('pointerdown', (e) => { if (!prMenu.contains(e.target)) prCloseLaneMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !prMenu.classList.contains('hidden')) { prCloseLaneMenu(); e.stopPropagation(); } }, true);

  prCanvas.addEventListener('pointerdown', (e) => {
    if (!prState) return;
    // Left button only. The right button is the lane menu's (contextmenu fires AFTER pointerdown, so
    // without this a right-click would first clear the selection the menu is about to offer to act
    // on - or, with the pencil, paint the lane on the way to opening it). ctrl-click stays a left
    // click here, which is what makes ctrl-drag velocity.
    if (e.button !== 0) return;
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
        prState._dragMin = m.minCell;
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
      // The grid's extent follows the notes, so a drag that moves or lengthens them would otherwise
      // re-mesh the columns under the pointer as it went (see prRenderCols).
      if (drag.kind !== 'vel') { prState._dragCols = m.cols; prState._dragMin = m.minCell; }
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
      prState._dragCols = m.cols; // see the move/resize drags above
      prState._dragMin = m.minCell;
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
      if (drag.edge === 'move') prState.start = at;
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
      const shift = prGroupShift(drag.orig.map((o) => o.start), dCell, m);
      for (const o of drag.orig) {
        o.n.start = o.start + shift;
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
      if (d) prLiveSync(); // live: what you are holding is what the next hit plays
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
      if (d) prLiveSync(); // live, like the vel drag above
    } else if (drag.kind === 'paint') {
      // Sweep from where the pointer was to where it is, so nothing between two frames is missed.
      const painted = prPaintLane(drag.lastPx, px, py, m);
      drag.painted += painted;
      drag.lastPx = px;
      if (painted) prLiveSync();
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

  // Letting go writes the gesture down: the code, the one undo step, and the eval that makes the
  // player agree with the code again. A lane drag has been pushing its values straight to the
  // player as it went (prLiveSync), so this is also the moment the two stop being able to differ.
  const endDrag = (e) => {
    if (drag && prState) {
      if (drag.kind === 'marquee') prState.marquee = null;
      // A pencil click that landed on empty lane changed nothing - and a write that changes nothing
      // still costs the buffer a re-eval, so it doesn't get one.
      // prWriteNow, not writePianorollCall: it flushes whatever the gesture last pushed and cancels
      // the coalesced write behind it, which would otherwise land after this one.
      else if (drag.kind === 'paint') { if (drag.painted) prWriteNow(); }
      else if (drag.kind !== 'audition') {
        prClipOverlaps(); // already clipped live on every frame; this settles the final position
        prWriteNow();
      }
      prState._dragCols = null; // unfreeze the column range
      prState._dragMin = null;
      prState._laneDrag = null; // the lane readout only follows an active drag
    }
    prPreviewOff();
    drag = null;
    try { prCanvas.releasePointerCapture(e.pointerId); } catch {}
    drawPianoroll();
  };

  prCanvas.addEventListener('pointerup', endDrag);
  // A gesture the system takes away (a touch turned into a scroll, the window going away under the
  // hand) never gets its pointerup. Settled exactly like a release rather than dropped: the values
  // pushed to the player mid-drag are real and already sounding, and abandoning the write here is
  // what would leave the player and the code disagreeing until the next eval.
  prCanvas.addEventListener('pointercancel', endDrag);

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
        for (const n of sel) n.full = Math.max(1, n.len + dir);
      } else {
        // The whole selection steps together, unfenced - out of the window, past the grid's edge
        // (which grows to keep up) - so the timing between the notes is never touched.
        for (const n of sel) n.start += dir;
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
    if (live) prLiveSync(); else prWriteNow();
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

  // ⌨ - the typing keyboard plays this roll's track (see the computer-keyboard section).
  prSyncKeyboardBtn();
  prKeysBtn.addEventListener('click', () => { prSetKeyboard(!prKbOn); prRefocus(); });

  // capture - what was just played on this roll's track, into the roll, as if record had been on.
  prCaptureBtn.addEventListener('click', () => { prCapture(); prRefocus(); });

  prCloseBtn.addEventListener('click', () => closePianorollEditor());

  // Click anywhere off the panel - the code, the console, the toolbar - and the roll gets out of
  // the way: it's a big opaque thing parked over the buffer, and reaching for the code you were
  // writing is the same gesture as dismissing it. Capture phase, so a click that never bubbles
  // still counts. Reopening is unaffected: the double-click on the `pianoroll` name lands outside
  // the panel too, but its second mousedown reaches openWidgetAt, which opens the roll again.
  // The header's recorder (● rec and its options) is the one outside thing that is ABOUT the open
  // roll - arming a take you then watch land on it - so reaching for it leaves the roll up. The lane
  // menu is the roll's OWN ui and only sits outside the panel so it can position itself against the
  // viewport (see index.html), so it doesn't count as off the panel either - and neither does the
  // app's modal (askShell), which ctrl+Q puts up ABOUT the roll: clicking its `quantize` button
  // would otherwise close the roll out from under the answer.
  document.addEventListener('pointerdown', (e) => {
    if (prState && !prPanel.contains(e.target) && !prMenu.contains(e.target) && !askEl?.contains(e.target) && !e.target.closest?.('.rec-wrap')) closePianorollEditor();
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
// Each region carries the editor it lives in: deck A's regions mark the main cm, deck B's mark
// the split pane's (mix mode) - one ticker lights both. `label` is the SERVER key ("b:kick" for
// deck B), which is how /api/highlight top-ups find their region again.
let patternRegions = []; // { label, deck, cm, anchor, grid: Map<cycle, steps>, gates: Map<cycle, [pos]>, maxEnd, lastKey, marks: [] }
let gridFrom = 0; // first cycle covered by every region's grid
let gridTo = 0; // one past the last covered cycle (extended by /api/highlight top-ups)
let gridCount = 32; // window size the server ships (mirrored from the eval response)
let gridFetching = false; // a top-up request is in flight - don't stack another

function clearPatternRegions(deck = null) {
  const kept = [];
  for (const r of patternRegions) {
    if (deck && r.deck !== deck) {
      kept.push(r); // the other deck's eval must not blank this one's highlights
      continue;
    }
    r.anchor.clear();
    for (const mk of r.marks) mk.clear();
  }
  patternRegions = kept;
}

// Builds the per-track highlight regions from an /api/evaluate response: each active track carries
// its grid (sounding steps per cycle, atom spans block-relative) plus its block [start,end], which
// we anchor a marker to so highlights track edits until the next eval. No source-text parsing - the
// server already did the real evaluation.
function setupHighlighting(tracks, from, count, deck = 'a', editor = cm) {
  clearPatternRegions(deck);
  gridFrom = from;
  gridTo = from + count;
  gridCount = count;
  gridFetching = false;
  for (const t of tracks) {
    if (!t.active || !t.grid) continue;
    const anchor = editor.markText(editor.posFromIndex(t.start), editor.posFromIndex(t.end), {});
    const region = {
      label: t.key ?? t.label, deck, cm: editor,
      anchor, grid: new Map(), gates: new Map(), maxEnd: 1, lastKey: '', marks: [],
    };
    ingestGrid(region, t.grid);
    patternRegions.push(region);
  }
}

// Folds a grid window ([{ cycle, steps }]) into a region, tracking the longest step end so the
// look-back in highlightTick reaches a note still ringing from an earlier cycle (clip/tie/echo).
function ingestGrid(region, grid) {
  for (const g of grid) {
    region.grid.set(g.cycle, g.steps);
    // The track's note onsets, kept apart from the lit spans: they are what a note-gated lfo()
    // shape restarts on, and nothing else on this side needs them (see lfoPhaseNow).
    region.gates.set(g.cycle, g.gates ?? []);
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
        for (const c of r.gates.keys()) if (c < pruneBefore) r.gates.delete(c);
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

    const base = r.cm.indexFromPos(range.from);
    // A held slot is not playing its `.preset(...)` names - its plugin window is open, or the panel
    // has it - and the grid deliberately says nothing about that: a grid is computed in windows and
    // shipped ahead of the sound, while a hold comes and goes between them (see server.js's
    // patternSigs). Dropping those spans HERE is what lets a hold start and stop being drawn within
    // half a second instead of surviving until the next evaluation. Held ranges are main-editor
    // offsets, so only deck A's regions filter by them.
    const lit = heldRanges.length && r.deck === 'a'
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
      r.cm.markText(r.cm.posFromIndex(base + loc[0]), r.cm.posFromIndex(base + loc[1]), {
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
// MIDI record - capture what's being played live (a midikeys() route, or the roll's ⌨ keyboard)
// and write it into a PIANO ROLL. The server owns the recording window (/api/midiRecord/*): it
// arms at the next phrase boundary (the wait is the count-in - watch the circles), records for the
// chosen number of cycles, and serves the events as absolute cycle times; this side turns them
// into roll notes (pattern-core's record.mjs), draws the take into the open roll AS IT HAPPENS, and
// on 'done' writes each track's take into that track's roll - the open roll, the block's own
// pianoroll(...) or the definition it names, or a fresh roll in place of the kb()/midikeys() call
// - and re-evaluates so the loop takes over from the live keys seamlessly. Where the roll was
// playing when a note sounded is the cell it lands on, so a take longer than the roll overdubs
// (see recordingToRoll), and what was played during the count-in goes in before cell 0.
// ---------------------------------------------------------------------------------------------

const recBtn = document.getElementById('recBtn');
const recOptsBtn = document.getElementById('recOptsBtn');
const recPanel = document.getElementById('recPanel');
const recCycles = document.getElementById('recCycles');
const recGrid = document.getElementById('recGrid');

let recState = null; // latest /api/midiRecord status while armed/recording, else null
let recPollTimer = null;
const REC_POLL_MS = 120; // the take is drawn into the open roll from these, so brisk

recOptsBtn.addEventListener('click', () => recPanel.classList.toggle('hidden'));
recBtn.addEventListener('click', () => (recState ? cancelMidiRecord(true) : startMidiRecord()));

/** The quantize the rec options ask for: slots per cycle, 0 = off. */
const recQuantize = () => Number(recGrid.value) || 0;

async function startMidiRecord() {
  recPanel.classList.add('hidden');
  try {
    recState = await api('POST', '/api/midiRecord/start', {
      cycles: Number(recCycles.value),
      grid: recQuantize(),
    });
    if (recState.transport) transport = recState.transport;
    recPollTimer = setInterval(pollMidiRecord, REC_POLL_MS);
    prRecGhosts();
    logLine(
      `midi record armed: ${recState.cycles} cycle(s), quantize ${recGrid.selectedOptions[0].textContent} - recording starts at cycle ${recState.startCycle}`,
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
  prRecGhosts();
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
      const take = recState;
      recState = null;
      prRecGhosts();
      api('POST', '/api/midiRecord/cancel').catch(() => {}); // ack: clear the served results
      applyRecording(s.results ?? [], { ...take, ...s });
    } else if (s.phase === 'idle') {
      // server restarted / lost the recording
      clearInterval(recPollTimer);
      recPollTimer = null;
      recState = null;
      prRecGhosts();
      logLine('midi record: the server dropped the recording', true);
    } else {
      recState = s;
      prRecGhosts();
    }
  } catch {
    // transient fetch error - keep polling
  }
}

function updateRecButton() {
  const say = (text) => { if (recBtn.dataset.text !== text) { recBtn.dataset.text = text; recBtn.innerHTML = `<span class="ico">●</span> ${text}`; } };
  if (!recState) {
    say('rec');
    recBtn.classList.remove('rec-armed', 'rec-live');
    return;
  }
  const pos = currentCyclePos();
  if (pos < recState.startCycle) {
    say(`in ${Math.max(0, recState.startCycle - pos).toFixed(1)}`);
    recBtn.classList.add('rec-armed');
    recBtn.classList.remove('rec-live');
  } else {
    say(`${Math.min(recState.cycles, pos - recState.startCycle).toFixed(1)}/${recState.cycles}`);
    recBtn.classList.add('rec-live');
    recBtn.classList.remove('rec-armed');
  }
}

/**
 * The take so far, INTO the open roll, as it happens. Every poll, the events the recorder has
 * completed since the last one (keys that have come back up) are written into the roll for real -
 * through the same conversion that 'done' uses - and the buffer re-evaluated on the panel's usual
 * debounce, so what you played on the first pass is PLAYING by the second: the overdub you hear is
 * the overdub you get. Keys still down are drawn as ghosts in the meantime - where they will land,
 * growing, count-in ones in the armed colour, the window's in the recording colour - and become
 * notes the moment they are released. The notes of the take stay selected as one, so it can be
 * moved or undone together; the roll's history takes it as a single step at 'done' (prRecFinish).
 *
 * The status carries every track's events; only the open roll's track is drawn/written here - the
 * others are written at 'done' (see applyRecording). prState.take remembers which events have been
 * written (keyed by track, pitch and onset), so a poll never writes one twice and 'done' only adds
 * what is left. A finer quantize than the roll's grid re-meshes the roll on the first note it
 * writes (see recordingToRoll), and the ghosts are scaled back from the scratch grid to the roll's.
 */
function prRecGhosts() {
  if (!prState) return;
  const was = prState.ghost.length;
  prState.ghost = [];
  const track = recState?.events && prPlayingTrack();
  const events = track ? recState.events[track] : null;
  if (events?.length && recordMod) {
    const take = prRecTake(track);
    const opts = { window: [recState.startCycle, recState.endCycle], quantize: recState.grid };
    // 1. completed since the last poll: into the roll
    const fresh = events.filter((ev) => !ev.held && !take.keys.has(prRecKey(ev)));
    if (fresh.length) {
      prRecWrite(fresh, opts, take, false);
      writePianorollCall(false); // one history step for the whole take, at the end
    }
    // 2. still down: ghosts, where they will land
    const held = events.filter((ev) => ev.held);
    if (held.length) {
      const scratch = { notes: [], grid: prState.grid, len: prState.len, start: prState.start };
      const out = recordMod.recordingToRoll(held, scratch, opts);
      const scale = prState.grid / out.grid;
      out.added.forEach((nt, i) => {
        const ev = out.sources[i];
        prState.ghost.push({
          midi: nt.midi,
          index: nt.index,
          start: nt.start * scale,
          len: Math.max(0.25, nt.len * scale),
          vel: nt.vel,
          countIn: ev.start < recState.startCycle,
          held: true,
        });
      });
    }
  }
  if (was || prState.ghost.length) drawPianoroll();
}

/** An event's identity across polls: the recorder hands the same start back each time. */
const prRecKey = (ev) => `${ev.note}|${ev.index ?? ''}|${ev.start}`;

/** The open roll's bookkeeping for the recording under way - fresh per arming, and per track. */
function prRecTake(track) {
  const arm = recState?.armCycle ?? null;
  if (!prState.take || prState.take.arm !== arm || prState.take.track !== track) {
    prState.take = { arm, track, keys: new Set(), notes: [] };
  }
  return prState.take;
}

/**
 * Write `events` into the open roll and keep the take's books: the roll's grid/len/start follow the
 * conversion (a re-mesh for a fine quantize), the new notes join the take and the selection.
 */
function prRecWrite(events, opts, take, scroll = true) {
  const out = recordMod.recordingToRoll(events, prState, opts);
  prState.grid = out.grid;
  prState.len = out.len;
  prState.start = out.start;
  for (const ev of events) take.keys.add(prRecKey(ev));
  take.notes.push(...out.added);
  prState.sel = new Set(take.notes.filter((nt) => !nt.hidden));
  prSyncGridLenInputs();
  if (scroll) prScrollTo(out.added); // bring the take into the pitch window without throwing the view away
  return out;
}

/**
 * 'done': write each track's take into its roll. Three places a take can go, tried in order:
 *   1. the OPEN roll, when it is this track's - straight into the panel's notes (selected, so
 *      they can be moved or deleted as one), and out to the code through the panel's own write;
 *   2. the block's own roll - an inline pianoroll("…") in the block, or the definition a
 *      single-name pianoroll("<name>") plays - rewritten in place;
 *   3. a FRESH roll in place of the block's kb()/midikeys() call, sized to the take
 *      (the old mini-notation replacement, as a roll).
 * A fresh roll takes the quantize as its grid (UNQUANTIZED_ROLL_GRID with quantize off); an
 * existing roll keeps its own, re-meshed only if the quantize is finer (see recordingToRoll).
 */
function applyRecording(results, take) {
  if (!results.length) {
    logLine('midi record: no notes were played during the recording window', true);
    return;
  }
  if (!recordMod || !pianorollMod) {
    logLine('midi record: pattern-core is not loaded - nothing written', true);
    return;
  }
  const window = [take.startCycle, take.endCycle];
  const quantize = take.grid;
  let evalNeeded = false;
  for (const r of results) {
    const { label, events } = r;
    const n = events.length;
    const countIn = events.filter((ev) => ev.start < take.startCycle).length;
    const what = `${n} note${n === 1 ? '' : 's'}${countIn ? ` (${countIn} from the count-in, before cell 0)` : ''}`;
    // 1. the open roll - this track's, or the very call the take would otherwise be written under
    // (a definition two tracks share, opened through the other one)
    const target = rollTargetForTrack(label);
    if (prState && (prPlayingTrack() === label || (target && prState.callStart === target.start))) {
      // Most of it is already in (prRecGhosts wrote each note as its key came up); this adds what
      // was still down when the window closed, and files the whole take as one undo step.
      const take = prRecTake(label);
      const rest = events.filter((ev) => !take.keys.has(prRecKey(ev)));
      const out = rest.length ? prRecWrite(rest, { window, quantize }, take) : null;
      prState.sel = new Set(take.notes.filter((nt) => !nt.hidden));
      prState.take = null;
      writePianorollCall();
      drawPianoroll();
      logLine(`midi record: ${what} into the open roll ("${label}")${out?.regridded ? ` - re-meshed to a ${out.grid} grid for the quantize` : ''}`);
      continue;
    }
    // 2. the block's roll
    if (target) {
      const code = cm.getValue();
      const inner = code.slice(target.open + 1, target.close);
      const parsed = parsePianorollCall(target.idLiteral ? splitFirstArg(inner)[1] : inner);
      const out = recordMod.recordingToRoll(events, parsed, { window, quantize });
      const text = serializePianorollCall({ ...parsed, grid: out.grid, len: out.len, start: out.start, idLiteral: target.idLiteral ?? null });
      cm.replaceRange(text, cm.posFromIndex(target.start), cm.posFromIndex(target.close + 1));
      refoldAll();
      evalNeeded = true;
      logLine(`midi record: ${what} into ${target.idLiteral ? `roll ${target.idLiteral}` : 'the roll'} of "${label}"`);
      continue;
    }
    // 3. a fresh roll for the live-keys call
    const grid = quantize > 0 ? quantize : recordMod.UNQUANTIZED_ROLL_GRID;
    const fresh = { notes: [], grid, len: grid * take.cycles, start: 0 };
    const out = recordMod.recordingToRoll(events, fresh, { window, quantize });
    const text = serializePianorollCall({ notes: out.notes, grid: out.grid, len: out.len, start: out.start, mode: 'note', swing: 0, swinggrid: null, idLiteral: null });
    if (replaceKbCall(label, text)) {
      evalNeeded = true;
      logLine(`midi record: ${what} into a new roll in "${label}" - double-click pianoroll to open it`);
    } else {
      logLine(`midi record ("${label}"): no pianoroll or midikeys/kb call found to write ${what} into - it was: ${pianorollMod.serializePianoRoll(out.notes.filter((nt) => !nt.hidden))}`, true);
    }
  }
  if (evalNeeded) evaluate(true);
}

/**
 * The roll a track's block plays, as a call to rewrite: an inline pianoroll("…") with drawn notes,
 * or the _roll(...) definition a pianoroll("<name>") naming exactly one roll resolves to. The
 * first in the block wins. Null when the block has neither (a bare live-keys track, or a roll
 * pattern naming several rolls - which one a take belongs in is not a question this can answer).
 * Shape: { start, open, close, idLiteral } - the span to replace, and the id when it is a definition.
 */
function rollTargetForTrack(label) {
  if (!labelsMod || !pianorollMod) return null;
  const code = cm.getValue();
  const block = blockForTrack(code, label);
  if (!block) return null;
  const re = /\bpianoroll\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    if (m.index < block.start || m.index >= block.end) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const inner = code.slice(open + 1, close);
    if (!inner.trim()) continue; // an empty call: materialize names it on the next eval, nothing to write into yet
    if (rollDefs.isIdCall(inner)) {
      const str = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(inner)?.[2] ?? '';
      const ids = idsNamedIn(str);
      if (ids.length !== 1) continue;
      const def = rollDefs.findDef(code, ids[0]);
      if (!def) continue;
      return { start: def.start, open: def.open, close: def.close, idLiteral: def.idLiteral };
    }
    return { start: m.index, open, close, idLiteral: null };
  }
  return null;
}

/**
 * capture - Live's Capture MIDI, for the roll on screen: what was just played on its track goes
 * into the roll as if record had been on. The server keeps the last minute or so of every track's
 * live notes (midikeys() routes and the ⌨ keyboard both); this asks for the roll's track's, picks
 * the window (captureWindow: the trailing run since the last phrase of silence - one pass of the
 * loop for a roll with notes, a fitted power-of-two length for an empty one) and writes it with
 * the same conversion a recording uses. An empty roll takes the captured length as its loop.
 */
async function prCapture() {
  if (!prState || !recordMod) return;
  const trackId = prPlayingTrack();
  if (!trackId) { logLine('capture: nothing plays this roll yet - put pianoroll(…) in a track first', true); return; }
  let events;
  try {
    ({ events } = await api('POST', '/api/liveNotes', { trackId }));
  } catch (e) {
    logLine(`capture: ${e.message ?? e}`, true);
    return;
  }
  if (!prState || prPlayingTrack() !== trackId) return; // the panel moved on while we waited
  const hasNotes = prLiveNotes(prState.notes).length > 0;
  const win = recordMod.captureWindow(events ?? [], { loopCycles: hasNotes ? prState.len / prState.grid : null });
  if (!win) { logLine(`capture: nothing has been played on "${trackId}" lately`, true); return; }
  const inWindow = events.filter((ev) => ev.start >= win.start && ev.start < win.end);
  if (!inWindow.length) { logLine(`capture: nothing of "${trackId}" falls in the last pass`, true); return; }
  if (!hasNotes) {
    // An empty roll becomes the take's shape: the loop is the captured stretch, from its first cell.
    prState.start = 0;
    prState.len = Math.max(1, Math.round(win.cycles * prState.grid));
  }
  const out = recordMod.recordingToRoll(inWindow, prState, { window: [win.start, win.end], quantize: recQuantize(), countIn: false });
  prState.grid = out.grid;
  prState.len = out.len;
  prState.start = out.start;
  prState.sel = new Set(out.added.filter((nt) => !nt.hidden));
  prSyncGridLenInputs();
  prScrollTo(out.added);
  writePianorollCall();
  drawPianoroll();
  const n = out.added.length;
  logLine(`capture: ${n} note${n === 1 ? '' : 's'} from cycles ${win.start}–${win.end} into ${hasNotes ? 'the roll' : `a ${win.cycles}-cycle loop`} ("${trackId}")${out.regridded ? ` - re-meshed to a ${out.grid} grid for the quantize` : ''}`);
}

// Finds the live-keys call in the labeled block and swaps the whole call expression for the
// recorded roll. Handles the MIDI routes - `midikeys("device")(ch)` directly, or `kb(ch)`
// through a `const kb = midikeys(...)` binding. First candidate in the block wins.
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
  // Not during DJ mode: the mixer arms a meter tap + band analyzer for EVERY playing track,
  // and with two full songs up that spike is an audible glitch on the very set being performed
  // (reported 2026-08-24). The desk strip is the performance surface; this modal is for
  // composing. Refused with a line rather than silently - warn, don't block sound.
  if (mixModeOn) {
    logLine('the mixer stays closed during DJ mode (its per-track meters across two songs glitch the audio) - use the desk strip', true);
    return;
  }
  mixerBackdrop.classList.remove('hidden');
  mixerState = {
    strips: new Map(),
    order: [], // strip labels in code order - the palette walk and the draw order
    serverTracks: [], // what the engine says is playing, as of the last poll
    // Labels a strip has been renamed away from, dropped from the poll's track list until the
    // engine stops reporting them. The rename lands in the code at once, but the old track keeps
    // playing until the debounced eval - without this the old strip would come back beside the
    // new one on the very next poll and sit there for half a second.
    renamedAway: new Set(),
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

  const tracks = s.tracks ?? [];
  // A renamed-away label is forgotten the moment the engine stops reporting it - i.e. as soon as
  // the eval that carried the new name landed.
  for (const l of mixerState.renamedAway) if (!tracks.includes(l)) mixerState.renamedAway.delete(l);
  mixerState.serverTracks = mixerState.renamedAway.size
    ? tracks.filter((l) => !mixerState.renamedAway.has(l))
    : tracks;
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
  name.title = label; // the full name, for when the row ellipsizes it
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
    label, color, el, fader, meterCanvas, dbLabel, knobs, muteBtn, soloBtn, bassBtn, nameText,
    gain: 1, gone: false, muted: false, soloed: false,
    renaming: false, // the name is swapped for its edit box (see startMixerRename)
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

  // The name a strip shows IS the block's label, so this is the one place it can be typed over
  // without going back to the code: click it and it becomes a box (see startMixerRename).
  nameText.addEventListener('click', () => startMixerRename(strip));

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

// --- renaming a track from its strip ---
//
// The strip's name swapped for a box holding it: Enter or clicking away commits, Escape puts it
// back - the same inline rename the definition lists use. Nothing here updates the strip: the
// label IS the track's identity, so the buffer edit lands and the next refresh builds a strip for
// the new name, exactly as it would if the label had been retyped in the editor.
function startMixerRename(strip) {
  if (strip.renaming || strip.gone || !mixctlMod) return;
  strip.renaming = true;
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'mixer-strip-rename';
  box.value = strip.label;
  box.spellcheck = false;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    strip.renaming = false;
    const to = box.value.trim();
    box.replaceWith(strip.nameText);
    if (commit && to && to !== strip.label) applyMixerRename(strip, to);
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation(); // whatever the editor binds this key to, it isn't wanted mid-name
  });
  box.addEventListener('blur', () => finish(true));
  strip.nameText.replaceWith(box);
  box.focus();
  box.select();
}

// The rename itself: the label token, plus every audio()/midi() source in the buffer that names
// this track (mixctl finds those - a rename that left one behind would repoint it at a device or
// a bus without a word). Refused names say why in the log and leave the code alone.
function applyMixerRename(strip, to) {
  if (!mixctlMod) return;
  const from = strip.label;
  const res = mixctlMod.renameEdits(cm.getValue(), from, to);
  if (res.error) {
    logLine(`mixer: ${res.error}`, true);
    return;
  }
  mixerSuppressSync = true;
  try {
    // Back to front, so an earlier edit never shifts a later one's offsets.
    for (const edit of [...res.edits].reverse()) {
      cm.replaceRange(edit.text, cm.posFromIndex(edit.from), cm.posFromIndex(edit.to));
    }
  } finally {
    mixerSuppressSync = false;
  }
  // The strip keeps its colour: it's the same track in the plots, and moving the entry rather
  // than adding one keeps the palette handing out the same colours to everybody else.
  if (mixerColorByLabel.has(from) && !mixerColorByLabel.has(to)) {
    mixerColorByLabel.set(to, mixerColorByLabel.get(from));
    mixerColorByLabel.delete(from);
  }
  // Both lists that decide who gets a strip, moved over now rather than an eval and a poll from
  // now: otherwise the track you just named loses its strip until the engine reports it back,
  // and the old name keeps one until the engine drops it.
  mixerKnownTracks = mixerKnownTracks.map((l) => (l === from ? to : l));
  // Closing the panel blurs the box, which commits: the code edit above still stands, there is
  // just no strip left to keep in step with it.
  if (mixerState) {
    mixerState.serverTracks = mixerState.serverTracks.filter((l) => l !== from);
    mixerState.renamedAway.add(from);
    mixerState.renamedAway.delete(to); // renamed back before the engine caught up - `to` is live again
    if (mixerFocus === from) mixerFocus = to;
    refreshMixerStrips();
  }
  logLine(`mixer: renamed "${from}" to "${to}"${res.refs ? ` (${res.refs} source reference(s) updated)` : ''}`);
  mixerScheduleEval();
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
    // The name is typed over in place while the block is in the buffer; a strip that has outlived
    // its block has no label left to rewrite, so it stops offering.
    strip.nameText.classList.toggle('mixer-renamable', !strip.gone);
    strip.nameText.title = strip.gone ? strip.label : `${strip.label} — click to rename this pattern`;
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
  // A strip's rename box takes Escape for itself - it puts the old name back. Closing the panel
  // out from under a half-typed name would commit or lose it depending on where the blur landed.
  if (document.activeElement?.classList.contains('mixer-strip-rename')) return;
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
  playBtn.innerHTML = playing ? '<span class="ico">■</span> stop' : '<span class="ico">▶</span> play';
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
  // A pack named for the first time (`sp("kit")`, or a bare `sp()` that materialize just named)
  // has no files yet, so it plays silence - and the one thing you want at that moment is the
  // panel to fill it. Noted before materialize writes the definitions and opened once the eval
  // is away, so the prompt never sits between the keystroke and the sound.
  const packsBefore = new Set(packDefs.defsInBuffer().map((d) => d.id));
  for (const reg of DEF_REGISTRIES) reg.materialize(); // a name said in a pianoroll()/lfo()/.preset()/sp() gets its definition first
  const newPacks = packDefs.defsInBuffer().map((d) => d.id).filter((id) => !packsBefore.has(id));
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
  if (newPacks.length) openPackById(newPacks[0]); // it has no files - here is where to pick them
  try {
    const result = await pending;
    transport = result.transport ?? { cps: result.cps ?? transport.cps, baseSec: 0, baseCycle: 0, paused: !start };
    setPatchScale(result.scale); // a setscale() in the buffer re-colours (and re-folds) the roll
    arSetClock(result.arrange ?? null); // the arrangement's song clock, for the painter's playhead
    renderTracks(result);
    setupHighlighting(result.tracks, result.gridFrom ?? 0, result.gridCount ?? 32);
    refoldAll();
    if (start) playing = true; // Update keeps the current play state; Play begins it
    const nActive = result.tracks.filter((t) => t.active).length;
    logLine(`${start ? 'playing' : 'updated'} (${nActive}/${result.tracks.length} pattern(s))`);
    loadChainParams();
    commitQueue.push(...filed); // the programs are in the store now; their slots can swap again
    if (mixModeOn) mixRefresh(); // the strip mirrors what's playing
  } catch (e) {
    commitOnEval.push(...filed); // nothing was filed, so nothing is thawed
    logLine(e.message ?? String(e), true);
  }
  updateTransportButtons();
}

// Play button: state-aware. Playing -> stop; stopped -> evaluate and start.
function togglePlay() {
  if (playing) doStop();
  else if (mixModeOn && songPanes.a.song) songPlay('a'); // the main deck holds a file, not code
  else evaluate(true, { byHand: true });
}

async function doStop(deck = null) {
  // In DJ mode, Cmd+. in an editor stops just that pane's deck (the other keeps playing on the
  // shared clock); outside DJ mode - or from the play button / the global hotkey - it stops
  // everything, as ever. The record cancels only apply when the main deck is going down: both
  // record into the main editor's song.
  const perDeck = deck && mixModeOn ? deck : null;
  if (!perDeck || perDeck === 'a') {
    if (recState) cancelMidiRecord(true);
    // Stopping the clock strands an armed bounce: its window is measured in cycles that will
    // never come round. The panel (and its meter) stays open.
    if (trackRecState) cancelTrackRecord(true);
  }
  const result = await api('POST', '/api/stop', perDeck ? { deck: perDeck } : undefined);
  if (!result.transport) {
    // Per-deck stop with the other deck still playing: the clock ran on. Just drop this deck's
    // playback highlights; everything else (transport, play button) still reflects the set.
    clearPatternRegions(perDeck);
    logLine(`deck ${perDeck.toUpperCase()} stopped`);
    return;
  }
  transport = result.transport; // frozen at cycle 0
  stopHighlighting();
  updateTransportButtons();
  logLine('stopped');
  kbForgetHeld(); // the server released our held keys; drop our local view so keyup won't re-off
}

// ---------------------------------------------------------------------------------------------
// Computer-keyboard instrument - the piano roll's ⌨ button. With it on, the typing keyboard plays
// the open roll's TRACK (à la Live's "Computer MIDI Keyboard", but aimed by the roll on screen
// rather than by an armed track): every key edge is POSTed to /api/keyNote and the server turns
// it into engine.noteOn/noteOff on that track, through its own synth. The server logs the same
// edges, so a take plays into the recorder and is there for the roll's capture button afterwards.
// Keys that play are swallowed - they never reach the editor - and everything else types as usual;
// closing the roll (or toggling ⌨ off) hands the keyboard back. Held keys are tracked so toggling,
// alt-tabbing, or a stop releases anything still down instead of leaving a note stuck on.
//
// Layout (à la Ableton/tracker typing keyboards): the home row a s d f g h j k l are the white
// keys and the row above (w e t y u o p) the black keys; z / x shift octave, c / v nudge
// velocity. The settings tab picks between that piano and the same keyboard laid out IN KEY - see
// KB_GAP_KEYS below. On an INDEX roll the same keys count files instead - `a` is the pack's first, `w` its
// second… - struck at the roll's default pitch with the index riding along, so a drum roll records
// from the keys the way it is drawn. (Nothing sounds for those yet: a sampler is triggered by
// playSample, not noteOn, and keyNote only knows the latter - they record, and play back from the
// roll on its next pass.)
// ---------------------------------------------------------------------------------------------

// The INDEX axis's table - there the keys count a pack's files, so they stay a plain 0, 1, 2, …
// with no duplicates and no note below the first. The note layouts are built from the rule below
// instead; kb-layout.test.js pins that the piano one still agrees with this on every key here.
const KB_SEMITONES = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
const KB_BASE_NOTE = 48; // MIDI note the home-row `a` plays at octave shift 0 (c2, this package's c3 = 60)
const KB_OCT_MIN = -3;
const KB_OCT_MAX = 4;
const KB_CONTROL_KEYS = new Set(['z', 'x', 'c', 'v']); // octave -/+, velocity -/+ (never notes)

// --- how both note layouts are built ---
// KB_SEMITONES is not an arbitrary table: it is one rule applied to the major scale. The home row
// is the scale's own notes, root first, and the row above bends them by a semitone, by where it
// sits: the key up-and-RIGHT of a home key plays it a semitone SHARP, the key up-and-LEFT of it a
// semitone FLAT. `w` is `a` sharpened; it is also `s` flattened, and in major those are the same
// note - which is what makes the black keys land where a piano puts them.
//
// Both layouts come out of that one rule; only the scale fed to it differs. `piano` feeds it C
// major and so reproduces the classic map. `in key` feeds it whatever setscale() last set, so the
// home row becomes the notes of the buffer's key and the row above still bends them.
//
// EVERY upper key plays, always - no key is ever dead. Where a scale steps by a semitone the two
// bends collide on a note the home row already has (`r` in major is just `f` again); redundancy is
// the price of the rule holding everywhere, and it is worth paying, because a layout where some
// keys are silent in some keys makes you think about the scale mid-phrase. `q` is the one key with
// no home key to its lower left, so it is only ever the flat one: a semitone below the root.
//
// The two bends only disagree where a scale steps by THREE, leaving two notes in one gap: there
// the unshifted key is the sharp one, and SHIFT - which raises any key a semitone - reaches the
// flat one. That covers every scale in notes.mjs, none of which steps by more than 3 (a step of 4
// would strand the note in its middle; kb-layout.test.js fails if such a scale is ever added).
const KB_LAYOUT_KEY = 'poptart-kb-layout';
let kbLayout = localStorage.getItem(KB_LAYOUT_KEY) === 'key' ? 'key' : 'piano';

const KB_HOME_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l']; // the scale's notes, root first
// The row above, in the order it sits over the home row: KB_UPPER_KEYS[i + 1] is up-and-right of
// KB_HOME_KEYS[i] (and up-and-left of KB_HOME_KEYS[i + 1]); `q` hangs off the left end.
const KB_UPPER_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
const KB_PIANO_INTERVALS = [0, 2, 4, 5, 7, 9, 11]; // major - what the `piano` layout is the rule applied to

let prKbOn = false; // the roll panel's ⌨ toggle - the keyboard plays the open roll's track while set
let kbOctave = 0; // octave shift in whole octaves (z/x)
let kbVelocity = 0.8; // 0.1..1 (c/v)
const kbHeldKeys = new Map(); // key char -> [{ trackId, note, index }] currently sounding, for keyup/release

/** The key's tonic as a note name, or null when there is no (parseable) key in force. */
const kbTonicName = () => { const info = prScaleInfo(); return info ? NOTE_NAMES[info.tonic] : null; };

/**
 * key -> semitones above KB_BASE_NOTE for a scale, by the rule in the comment above: the home row
 * takes the scale's degrees from its tonic, and each upper key sharpens the home key below-left of
 * it (`q`, having none, flattens the root instead). Degrees past the scale's length wrap into the
 * octave above, so the row keeps climbing rather than stopping at the seventh.
 */
function kbBuildScaleMap({ tonic, intervals }) {
  const len = intervals.length;
  const degree = (d) => intervals[((d % len) + len) % len] + 12 * Math.floor(d / len);
  const map = {};
  KB_HOME_KEYS.forEach((key, i) => { map[key] = tonic + degree(i); });
  map[KB_UPPER_KEYS[0]] = tonic + degree(0) - 1; // `q`: nothing below-left to sharpen, so flatten the root
  KB_HOME_KEYS.forEach((_, i) => { map[KB_UPPER_KEYS[i + 1]] = tonic + degree(i) + 1; });
  return map;
}

// Rebuilt only when the key changes - the map is the same for every keystroke in a given key.
let kbScaleMapCache = { name: null, map: null };
const kbPianoMap = kbBuildScaleMap({ tonic: 0, intervals: KB_PIANO_INTERVALS });

/**
 * Is the in-key layout actually playing right now? It needs to be chosen AND to have a key to be
 * in: with no setscale() there is no scale to lay out, so the keys stay on the piano. The index
 * axis keeps the piano map too - there the numbers are file indices, and a pack has no key.
 */
const kbInKey = () => kbLayout === 'key' && !prIndexMode() && !!prScaleInfo();

/** The map in force: the buffer's key, or C major. */
function kbSemitones() {
  if (!kbInKey()) return kbPianoMap;
  if (kbScaleMapCache.name !== patchScale) kbScaleMapCache = { name: patchScale, map: kbBuildScaleMap(prScaleInfo()) };
  return kbScaleMapCache.map;
}

/** The settings choice. Anything held was struck on the old layout, so release it first. */
function setKbLayout(layout) {
  kbLayout = layout === 'key' ? 'key' : 'piano';
  localStorage.setItem(KB_LAYOUT_KEY, kbLayout);
  kbReleaseAll();
  prSyncKeyboardBtn();
  const tonic = kbTonicName();
  if (kbLayout !== 'key') logLine('⌨ piano layout - a plays C');
  else if (tonic) logLine(`⌨ in key - a plays ${tonic}, the home row is ${patchScale}; the row above bends it (up-right sharpens, up-left flattens)`);
  else logLine('⌨ in key - no key set yet, so the keys stay on the piano until a setscale() runs');
}

/** The track the keyboard plays right now - the open roll's, with ⌨ on - or null. */
function kbTarget() {
  if (!prKbOn || !prState) return null;
  return prPlayingTrack();
}

/** The roll panel's ⌨: on/off for the roll on screen. Off releases whatever is down. */
function prSetKeyboard(on) {
  prKbOn = !!on && !!prState;
  if (!prKbOn) kbReleaseAll();
  prSyncKeyboardBtn();
  const tonic = kbInKey() ? kbTonicName() : null;
  if (prState) logLine(prKbOn ? `computer keyboard on - playing "${prPlayingTrack() ?? '?'}" from the keys (a s d f…, z/x octave, c/v velocity${tonic ? `, in key: a = ${tonic}, shift raises a semitone` : ''})` : 'computer keyboard off');
}

function prSyncKeyboardBtn() {
  prKeysBtn.classList.toggle('active', prKbOn);
  const tonic = kbInKey() ? kbTonicName() : null;
  prKeysBtn.title = prKbOn
    ? `computer keyboard: on - the keys play this roll's track (ctrl+m)${tonic ? `, in the key: a = ${tonic}, shift raises a semitone` : ''}`
    : 'computer keyboard: play this roll\'s track from the typing keyboard (ctrl+m)';
}

function kbSend(trackId, note, isOn, index = null) {
  const body = { trackId, note, vel: kbVelocity, isOn };
  if (index != null) body.index = index;
  api('POST', '/api/keyNote', body).catch(() => {});
}

// Release every currently-held key (send note-offs and forget them). Used on toggle-off, window
// blur, and closing the roll.
function kbReleaseAll() {
  for (const held of kbHeldKeys.values()) for (const { trackId, note, index } of held) kbSend(trackId, note, false, index);
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
// roll's name box, param search, etc. type normally) - the CodeMirror editor and the roll's canvas
// are fair game.
function kbShouldCapture() {
  const el = document.activeElement;
  if (!el) return true;
  if (el.closest && el.closest('.CodeMirror')) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return false;
  return true;
}

function onKbKeyDown(e) {
  const trackId = kbTarget();
  if (!trackId) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // never swallow shortcuts (Cmd+Enter to eval, etc.)
  const key = e.key.toLowerCase();
  if (!kbShouldCapture()) return;

  // Every key that plays is swallowed, so it never reaches the editor or the roll's own shortcuts.
  // Auto-repeat is dropped (a held key is one sustained note).
  const swallow = () => {
    e.preventDefault();
    e.stopPropagation();
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
  // On the index axis only some of these keys are files; on either note layout all of q…p and
  // a…l play something, so nothing in the top two rows reaches the editor while ⌨ is on.
  const semitones = prIndexMode() ? KB_SEMITONES : kbSemitones();
  if (!(key in semitones)) return;
  if (e.repeat || kbHeldKeys.has(key)) {
    // Already sounding (OS auto-repeat) - keep swallowing, but don't retrigger.
    swallow();
    return;
  }
  // Shift is the accidental: it raises the key a semitone. It only ever finds a new note where a
  // scale steps by three and one upper key has to stand for two - elsewhere it lands on a note the
  // layout already has, which is harmless and keeps the rule one sentence long.
  const accidental = e.shiftKey && !prIndexMode() ? 1 : 0;
  // On the index axis a key is a FILE of the pack, struck at the roll's default pitch; on the
  // piano it is the pitch itself.
  const struck = prIndexMode()
    ? { note: pianorollMod.PIANOROLL_DEFAULT_NOTE, index: Math.max(0, KB_SEMITONES[key] + kbOctave * 12) }
    : { note: KB_BASE_NOTE + kbOctave * 12 + semitones[key] + accidental, index: null };
  kbSend(trackId, struck.note, true, struck.index);
  kbHeldKeys.set(key, [{ trackId, ...struck }]);
  swallow();
}

// Key-up always releases whatever that key started, regardless of the current target/focus, so a
// note can never get stuck (the roll may have closed while the key was down).
function onKbKeyUp(e) {
  const key = e.key.toLowerCase();
  const held = kbHeldKeys.get(key);
  if (!held) return;
  kbHeldKeys.delete(key);
  for (const { trackId, note, index } of held) kbSend(trackId, note, false, index);
  e.preventDefault();
  e.stopPropagation();
}

// Capture phase so we beat CodeMirror (and the roll's canvas) to the key and can suppress it.
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

// ---------------------------------------------------------------------------------------------
// Where an audition comes out.
//
// Every preview in the app - the sounds browser's hold-to-hear, the pack panel's player, the
// organize window's - shares the AudioContext above, and a Web Audio context plays to whatever
// the OS calls the default output. Off the DJ desk that is exactly right.
//
// ON it, the default output is the PA. Auditioning the next track through the speakers the room
// is listening to is the one mistake a DJ tool must not make easy - so in DJ mode an audition
// plays ONLY into the headphone cue: previewCtx is pointed at the cue device with setSinkId, and
// where that cannot be done the audition is refused, with the reason, instead of played anyway.
//
// The cue device is the ENGINE's (settings -> headphone cue); this only follows it. Matching it
// to a browser output device is by name, and browsers hide output-device labels until the page
// has been granted device access - so "cannot route" is an ordinary outcome here rather than an
// error, and it says what to do about it.
// ---------------------------------------------------------------------------------------------

let previewCue = null; // the engine's cue device name, as of the last sync
let previewSink = { for: undefined, id: null, label: '', why: 'auditions have not been routed yet' };

const auditionNorm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Point previewCtx at the headphone cue (in DJ mode) or back at the default (out of it). Called
 * on the DJ transitions, when the cue device changes, and when a window that auditions opens -
 * never from the play path itself, which stays synchronous and only reads the result.
 */
async function syncPreviewRouting() {
  try {
    ({ cueSelected: previewCue } = await api('GET', '/api/audioDevices'));
  } catch {
    previewCue = null; // no answer is no cue: the guard below then refuses, which is the safe way
  }
  const want = mixModeOn ? (previewCue || null) : null;
  if (previewSink.for === want && previewCtx) return previewSink;
  // Made here rather than on the first audition: the guard below is synchronous, so the routing
  // has to be settled BEFORE anything asks to play, not while it is asking. Every caller is a
  // user gesture, and a context nothing has played through yet is suspended and cheap.
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  previewSink = { for: want, id: null, label: '', why: null };
  if (!want) {
    try { await previewCtx.setSinkId(''); } catch { /* already the default */ }
    return previewSink;
  }
  if (typeof previewCtx.setSinkId !== 'function') {
    previewSink.why = "this browser can't send auditions to a chosen output";
    return previewSink;
  }
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audiooutput' && d.label);
    if (!outs.length) {
      previewSink.why = 'the browser is not sharing its output devices - allow this page device access';
      return previewSink;
    }
    const w = auditionNorm(want);
    const hit = outs.find((d) => auditionNorm(d.label) === w)
      ?? outs.find((d) => auditionNorm(d.label).includes(w) || w.includes(auditionNorm(d.label)));
    if (!hit) {
      previewSink.why = `no output the browser can see matches the cue device "${want}"`;
      return previewSink;
    }
    await previewCtx.setSinkId(hit.deviceId);
    previewSink.id = hit.deviceId;
    previewSink.label = hit.label;
  } catch (e) {
    previewSink.why = e.message ?? String(e);
  }
  return previewSink;
}

/** The reason an audition must not play right now, or null when it may. Cheap and synchronous. */
function auditionBlocked() {
  if (!mixModeOn) return null;
  if (previewSink.id) return null;
  const why = previewCue
    ? previewSink.why ?? 'the cue device is not routed'
    : 'no headphone cue is set (settings → headphone cue)';
  return `DJ mode is on, so an audition would play to the main output - ${why}`;
}

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

function previewSample(pack, i, row) {
  return previewSampleUrl(`/api/sampleAudio?pack=${encodeURIComponent(pack)}&i=${i}`, row);
}

async function previewSampleUrl(url, row) {
  stopPreview();
  const blocked = auditionBlocked();
  if (blocked) return logLine(blocked, true);
  const gen = ++previewGen;
  previewHeld = true;
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {});
  try {
    const res = await fetch(url);
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
      cueAvailable, cueSelected, cueActive,
    } = await api('GET', '/api/audioDevices');
    audioCueSelect.innerHTML = '';
    audioCueSelect.appendChild(new Option('none', ''));
    for (const d of devices.filter((x) => !x.isAggregate)) {
      audioCueSelect.appendChild(new Option(`${d.name} · ${d.channels} ch`, d.name));
    }
    audioCueSelect.value = cueSelected ?? '';
    if (audioCueSelect.value !== (cueSelected ?? '')) audioCueSelect.value = '';
    audioCueSelect.disabled = !cueAvailable;
    if (!cueAvailable) audioCueSelect.title = 'the headphone cue needs the poptart-audio helper, which is not available on this system';
    else if (cueSelected && !cueActive) audioCueSelect.title = `"${cueSelected}" is chosen but the running engine has no cue pair - is it plugged in? (restart the engine to retry)`;
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

const audioCueSelect = document.getElementById('audioCueSelect');
audioCueSelect.addEventListener('change', async () => {
  const device = audioCueSelect.value || null;
  audioCueSelect.disabled = true;
  audioDeviceSelect.disabled = true;
  engineStatus.textContent = 'restarting engine…';
  engineStatus.className = 'status';
  logLine(device ? `cueing to ${device} - restarting the engine…` : 'headphone cue off - restarting the engine…');
  try {
    const res = await api('POST', '/api/audioCueDevice', { device });
    stopHighlighting();
    playing = false;
    updateTransportButtons();
    transport = { ...transport, paused: true, baseCycle: 0 }; // server froze its clock too
    logLine(res.active
      ? `headphone cue is on "${res.active}" - re-evaluate (Cmd/Ctrl+Enter) to resume playback`
      : device
        ? `cue device saved, but the engine came up WITHOUT a cue pair - check it is plugged in`
        : 'headphone cue is off - re-evaluate (Cmd/Ctrl+Enter) to resume playback', device && !res.active);
    setAudioDeviceWarning(res.warning);
    previewSink.for = undefined; // a new cue device: the audition routing is re-derived
    syncPreviewRouting();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  } finally {
    audioCueSelect.disabled = false;
    audioDeviceSelect.disabled = false;
    refreshAudioDevices().catch(() => {});
    refreshStatus().catch(() => {});
  }
});

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
  // A warning, not an error: in every one of these the audio is still playing - the aggregate has
  // fallen back, or the channel numbers have moved - and the settings tab is already showing the
  // short version next to the control that fixes it.
  if (message && message !== lastAudioDeviceWarning) logLine(warning.detail ?? message, 'warn');
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

// --- tooltips on ctrl+hover: the whole app's `title`s live in data-tip instead, and one box
// shows the hovered control's while ctrl is held. The `title` property itself is rerouted on
// HTMLElement's prototype, so every `el.title = ...` in this file (and the HTML's own
// title="..." attributes, moved on load and as markup is added) lands in data-tip without a
// single call site changing; reading `el.title` gives it back. Off, titles are put back and the
// browser shows them as ever. ---
const CTRL_TIPS_KEY = 'poptart-ctrl-tooltips';
let ctrlTipsOn = localStorage.getItem(CTRL_TIPS_KEY) !== '0'; // default on
{
  const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'title');
  Object.defineProperty(HTMLElement.prototype, 'title', {
    configurable: true,
    get() { return this.dataset.tip ?? native.get.call(this); },
    set(v) {
      if (!ctrlTipsOn) { delete this.dataset.tip; native.set.call(this, v); return; }
      if (v == null || v === '') delete this.dataset.tip; else this.dataset.tip = String(v);
      this.removeAttribute('title');
    },
  });
}
const tipBox = document.createElement('div');
tipBox.id = 'tipBox';
tipBox.className = 'hidden';
document.body.appendChild(tipBox);
let tipPointer = { x: 0, y: 0, target: null };
let tipCtrl = false;
function tipMoveTitles(el, on) {
  const nodes = [el, ...(el.querySelectorAll?.(on ? '[title]' : '[data-tip]') ?? [])];
  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (on && n.hasAttribute('title')) { n.dataset.tip = n.getAttribute('title'); n.removeAttribute('title'); }
    else if (!on && n.dataset.tip != null) { n.setAttribute('title', n.dataset.tip); delete n.dataset.tip; }
  }
}
function tipRender() {
  const el = tipCtrl && ctrlTipsOn ? tipPointer.target?.closest?.('[data-tip]') : null;
  const text = el?.dataset.tip;
  if (!text) { tipBox.classList.add('hidden'); return; }
  tipBox.textContent = text;
  tipBox.classList.remove('hidden');
  const r = tipBox.getBoundingClientRect();
  const x = Math.min(tipPointer.x + 14, window.innerWidth - r.width - 8);
  const y = tipPointer.y + 18 + r.height > window.innerHeight ? tipPointer.y - r.height - 10 : tipPointer.y + 18;
  tipBox.style.left = `${Math.max(4, x)}px`;
  tipBox.style.top = `${Math.max(4, y)}px`;
}
new MutationObserver((muts) => {
  if (!ctrlTipsOn) return;
  for (const m of muts) {
    if (m.type === 'attributes') tipMoveTitles(m.target, true);
    else for (const n of m.addedNodes) if (n instanceof HTMLElement) tipMoveTitles(n, true);
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
function setCtrlTips(on) {
  ctrlTipsOn = on;
  localStorage.setItem(CTRL_TIPS_KEY, on ? '1' : '0');
  tipMoveTitles(document.documentElement, on);
  tipRender();
}
if (ctrlTipsOn) tipMoveTitles(document.documentElement, true);
window.addEventListener('pointermove', (e) => {
  tipPointer = { x: e.clientX, y: e.clientY, target: e.target };
  if (tipCtrl) tipRender();
}, { passive: true });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Control' || tipCtrl) return;
  tipCtrl = true;
  tipRender();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || !e.ctrlKey) { tipCtrl = false; tipRender(); }
});
window.addEventListener('blur', () => { tipCtrl = false; tipRender(); });
window.addEventListener('pointerdown', () => { tipCtrl = false; tipRender(); }, { capture: true });
const ctrlTooltipsToggle = document.getElementById('ctrlTooltipsToggle');
ctrlTooltipsToggle.checked = ctrlTipsOn;
ctrlTooltipsToggle.addEventListener('change', () => setCtrlTips(ctrlTooltipsToggle.checked));

// Editor settings. The docs toggle governs both documentation tooltips - the panel beside the
// autocomplete popup and the ctrl-hover one (see the tooltips section above).
const docTooltipsToggle = document.getElementById('docTooltipsToggle');
docTooltipsToggle.checked = docTooltipsEnabled;
docTooltipsToggle.addEventListener('change', () => setDocTooltips(docTooltipsToggle.checked));

// Piano roll: whether the ⌨ keys are a piano or the buffer's key (see the computer-keyboard
// section).
const kbLayoutSelect = document.getElementById('kbLayoutSelect');
kbLayoutSelect.value = kbLayout;
kbLayoutSelect.addEventListener('change', () => setKbLayout(kbLayoutSelect.value));


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
      ? `sessions untouched for ${months} month${months === 1 ? '' : 's'} are deleted; ${preview.sessions
        ? `${sessionCost(preview.sessions, preview.bytes)} past that now`
        : 'nothing is that old right now'}`
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
// Pack panel - the editor for a named sample pack (sp("kit"), a `_pack("kit", [...])` definition).
// A pack is a list of files picked off the disk, so the panel is three lists side by side: the
// packs there are (this buffer's and the library's - find, name, ★, delete, exactly the preset
// panel's list), the files IN the open pack in index order (entry 0 is `kit:0` / .i(0)), and a
// folder browser over the whole disk to pick from.
//
// Picking is a two-step: clicking a row SELECTS it (and plays it, so auditioning is the same
// gesture as choosing - ↑/↓ walk the list playing as they go), and ← (or the add button) moves
// the selection into the pack; in the pack, → / delete takes the selection out. Shift-click and
// ⌘-click select in bulk, ⌘A takes the whole folder, and a folder is selected with one click and
// entered with two, so a whole folder is one click and a ←. What is playing shows in the transport
// along the foot - scrub it, pause it. Every change is written straight back into the definition
// and re-evaluated, the way drawing into a roll is.
//
// Opens on double-clicking an `sp` name, from the picker rows, and by itself when an evaluation
// names a pack for the first time - a new pack has no files and plays silence, and the one thing
// you want then is this. Its backdrop class is the dialogs' (dir-picker-backdrop), which is what
// makes the global hotkeys stand down while it is up.
// ---------------------------------------------------------------------------------------------

const packBackdrop = document.getElementById('packBackdrop');
const packTitle = document.getElementById('packTitle');
const packPickWrap = document.getElementById('packPickWrap');
const packName = document.getElementById('packName');
const packSearch = document.getElementById('packSearch');
const packPickList = document.getElementById('packPickList');
const packEntriesHead = document.getElementById('packEntriesHead');
const packEntriesEl = document.getElementById('packEntries');
const packRemoveSelBtn = document.getElementById('packRemoveSel');
const packBrowsePath = document.getElementById('packBrowsePath');
const packBrowseSearch = document.getElementById('packBrowseSearch');
const packBrowseHead = document.getElementById('packBrowseHead');
const packBrowseList = document.getElementById('packBrowseList');
const packAddSelBtn = document.getElementById('packAddSel');
const packPlayBtn = document.getElementById('packPlayBtn');
const packPlayName = document.getElementById('packPlayName');
const packPlayBar = document.getElementById('packPlayBar');
const packPlayHead = document.getElementById('packPlayHead');
const packPlayTime = document.getElementById('packPlayTime');
const packNote = document.getElementById('packNote');
const packCloseBtn = document.getElementById('packClose');

// { id, entries, own } - the pack on screen. `own`: defined in this buffer (editable); otherwise
// it is the library's, shown as it is, and the ★ is how it becomes this buffer's to edit.
let packState = null;
let packBrowse = { path: null, parent: null, dirs: [], files: [], samplesRoot: '' };
// What is selected in each list, and the row the last plain click or arrow landed on (the end a
// shift-range extends from). Browse keys are "d:name" / "f:name" in the current folder; entry keys
// are indexes into the pack.
const packSel = { browse: new Set(), entries: new Set(), browseAnchor: null, entriesAnchor: null };
const packWalks = new Map(); // folder path -> { at, walk } - every audio file under it, briefly held
// The browse search. While `query` is set the browse list shows matches from anywhere under the
// folder instead of the folder itself - `files` are paths relative to it, capped at what fits on
// screen, with `matched` the real count (adding them all goes back for the rest).
let packFind = { query: '', running: false, files: [], matched: 0, total: 0, truncated: false, seq: 0 };
let packFindTimer = null;
let packEvalTimer = null;
let packSuppressSync = false; // our own write-back, which the change listener must not re-read
const PACK_EVAL_DEBOUNCE_MS = 250;
const PACK_FIND_DEBOUNCE_MS = 200;
const PACK_FIND_SHOW = 500; // matches drawn at once; more than that, narrow the search
const PACK_WALK_LIMIT = 20000; // the cap on a whole-tree add, matching the server's own
const PACK_WALK_TTL_MS = 30000; // how long a folder's walk is reused, so a new file still shows up

function packScheduleEval() {
  clearTimeout(packEvalTimer);
  packEvalTimer = setTimeout(() => { packEvalTimer = null; evaluate(false); }, PACK_EVAL_DEBOUNCE_MS);
}

const packHead = makeNamePicker({
  els: { wrap: packPickWrap, title: packTitle, name: packName, search: packSearch, list: packPickList },
  reg: packDefs,
  inline: true, // the list is the panel's first column, like the preset panel
  current: () => packState?.id ?? null,
  open: (id) => openPackById(id),
  canUse: () => !!packState?.source?.find(),
  use: (id) => packUseInCall(id),
  refocus: () => packSearch.focus(),
});

// Puts `id` into the sp(...) the panel is looking through - the pack's half of prUseInCall. Where
// the call says the open pack by name (`kit:0 kit:2`), only the name changes and the indexes stay,
// since a drum pattern's numbers are the pattern; otherwise the whole argument goes, which is why
// the line says what it replaced.
function packUseInCall(id) {
  const span = packState?.source?.find();
  if (!span) return;
  const was = cm.getRange(span.from, span.to);
  if (was === id) return;
  const word = packState.id && idWordRe(packState.id, '').test(was) ? packState.id : null;
  const quoted = cm.markText({ line: span.from.line, ch: span.from.ch - 1 }, { line: span.to.line, ch: span.to.ch + 1 }, {});
  if (word) {
    const from = cm.indexFromPos(span.from);
    applyEdits(idOccurrenceEdits({ from, str: was }, word, id));
  } else {
    cm.replaceRange(id, span.from, span.to);
  }
  const after = quoted.find();
  quoted.clear();
  packState.source.clear();
  packState.source = after
    ? cm.markText({ line: after.from.line, ch: after.from.ch + 1 }, { line: after.to.line, ch: after.to.ch - 1 }, {})
    : null;
  refoldAll();
  logLine(`sp("${was}") now plays "${id}"`);
  if (id !== packState.id) openPackById(id);
  else packSyncHead();
  packScheduleEval();
}
const packSyncHead = () => packHead.syncHead();
const packRenderList = () => { if (packState) packHead.renderList(); };

/** The entries a `_pack(...)` definition lists, read off the code: every string in the list after the id. */
function packEntriesOf(code, def) {
  if (!def) return null;
  const [, rest] = splitFirstArg(code.slice(def.open + 1, def.close));
  return [...rest.matchAll(/(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => {
    try { return JSON.parse(`"${m[2]}"`); } catch { return m[2]; }
  });
}

const packDefOf = (id) => packDefs.findDef(cm.getValue(), String(id));

// `from.source`: a marker over the id string of the sp(...) the panel was opened through, which is
// what the list's → writes into. Opened any other way, the first call that names the pack stands
// in - picking a kit and sending it to the pattern is the point of having the list.
function openPackById(id, from = {}) {
  const key = String(id);
  const def = packDefOf(key);
  const lib = def ? null : prPrebakePacks.find((p) => p.id === key);
  if (!def && !lib) {
    logLine(`no pack called "${key}" is defined in this buffer`, true);
    return false;
  }
  let source = from.source ?? packState?.source ?? null;
  if (!source?.find()) {
    source = null;
    const call = packDefs.refCalls(cm.getValue(), key)[0];
    if (call) source = cm.markText(cm.posFromIndex(call.from), cm.posFromIndex(call.to), {});
  }
  packState = { id: key, entries: def ? packEntriesOf(cm.getValue(), def) : [...lib.files], own: !!def, source };
  packSel.entries.clear();
  packSel.entriesAnchor = null;
  syncPreviewRouting(); // the panel auditions - settle where that comes out before it can
  packBackdrop.classList.remove('hidden');
  packSyncHead();
  packRenderEntries();
  packHead.renderList(true);
  // The browser opens on the sample library the first time, and stays where you left it after.
  if (packBrowse.path == null) {
    api('GET', '/api/samplesDir').then(({ dir }) => packBrowseTo(dir)).catch(() => packBrowseTo(null));
  } else {
    packRenderBrowse();
    if (packFindActive()) packRunFind(packFind.query); // the disk may have moved on since last time
  }
  packRenderTransport();
  return true;
}

// Double-clicked the name of an sp("<kit kit2>"): open the one sounding, or the first named.
function openPackFromCall(call, code) {
  const range = idStringRange(call, code);
  if (!range) return false;
  const [from, to] = range;
  const id = activeIdIn(from, to) ?? (code.slice(from, to).match(/[\w$]+/) ?? [])[0];
  if (id == null) return false;
  const source = cm.markText(cm.posFromIndex(from), cm.posFromIndex(to), {});
  if (openPackById(id, { source })) return true;
  source.clear();
  return false;
}

function closePackPanel() {
  if (!packState) return;
  packState.source?.clear();
  packState = null;
  packBackdrop.classList.add('hidden');
  packPlayerStopSource();
  packRenderTransport();
}

// Writes the entries back into the definition. The id is written back exactly as it was found, so
// a numeric id stays a number; the list is JSON, which is what the editor reads and what the
// builder takes.
function packWrite() {
  if (!packState?.own) return;
  const code = cm.getValue();
  const def = packDefOf(packState.id);
  if (!def) return;
  packSuppressSync = true;
  try {
    cm.replaceRange(`${def.idLiteral}, ${JSON.stringify(packState.entries)}`, cm.posFromIndex(def.open + 1), cm.posFromIndex(def.close));
  } finally {
    packSuppressSync = false;
  }
  refoldAll();
  packScheduleEval();
}

// A path as the definition should say it: under the sample library it is written relative to the
// root (so the pack travels with the library, and reads short); anywhere else, as it is.
function packEntryFor(abs) {
  const root = packBrowse.samplesRoot;
  if (root && (abs === root || abs.startsWith(`${root}/`))) return abs.slice(root.length + 1);
  return abs;
}
const packAbsOf = (entry) => (entry.startsWith('/') ? entry : `${packBrowse.samplesRoot}/${entry}`);
const packBasename = (entry) => entry.replace(/\/+$/, '').split('/').pop() || entry;
const isAudioPath = (p) => /\.(wav|aif|aiff|flac)$/i.test(p);

function packAdd(absPaths) {
  if (!packState?.own) return packRefuseLibrary();
  const added = [];
  for (const abs of absPaths) {
    const entry = packEntryFor(abs);
    if (packState.entries.includes(entry)) continue;
    packState.entries.push(entry);
    added.push(entry);
  }
  if (!added.length) return packSay('already in the pack');
  packWrite();
  packRenderEntries();
  packRenderBrowse();
  packSay(`added ${added.length === 1 ? packBasename(added[0]) : `${added.length} files`}`);
}

function packRemoveIndexes(indexes) {
  if (!packState?.own) return packRefuseLibrary();
  const drop = [...new Set(indexes)].sort((a, b) => b - a);
  if (!drop.length) return;
  for (const i of drop) packState.entries.splice(i, 1);
  packWrite();
  packSay(`took ${drop.length === 1 ? 'one file' : `${drop.length} files`} out`);
  // The cursor stays where the removal happened - on whatever slid up into the gap - and that one
  // plays, so deciding what to keep goes on down the list rather than starting over from the top.
  const next = Math.min(drop[drop.length - 1], packState.entries.length - 1);
  packSel.entries = new Set(next >= 0 ? [next] : []);
  packSel.entriesAnchor = next >= 0 ? next : null;
  packRenderEntries();
  packRenderBrowse();
  if (next >= 0) packAfterSelect('entries', packRows('entries')[next]);
}

function packMove(i, delta) {
  if (!packState?.own) return packRefuseLibrary();
  const j = i + delta;
  if (j < 0 || j >= packState.entries.length) return;
  const [e] = packState.entries.splice(i, 1);
  packState.entries.splice(j, 0, e);
  packSel.entries = new Set([j]);
  packSel.entriesAnchor = j;
  packWrite();
  packRenderEntries();
}

function packRefuseLibrary() {
  packSay(`"${packState?.id}" comes from your library - ★ takes a copy into this buffer to edit`, true);
}

function packSay(text, isError = false) {
  packNote.textContent = text;
  packNote.classList.toggle('error', !!isError);
}

// --- selection ---------------------------------------------------------------------------------

/** The rows of a list in order: { key, abs, name, kind } - what clicks, arrows and ⌘A walk. */
function packRows(list) {
  if (list === 'entries') {
    return (packState?.entries ?? []).map((entry, i) => ({ key: i, abs: packAbsOf(entry), name: packBasename(entry), kind: isAudioPath(entry) ? 'file' : 'dir' }));
  }
  const { path: dir } = packBrowse;
  if (dir == null) return [];
  // Searching: the matches, which are files anywhere below - their names ARE relative paths, so
  // clicks, keys, adding and the playing-row marks all work on them unchanged.
  const dirs = packFindActive() ? [] : packBrowse.dirs;
  const files = packFindActive() ? packFind.files : packBrowse.files;
  return [
    ...dirs.map((name) => ({ key: `d:${name}`, abs: `${dir}/${name}`, name, kind: 'dir' })),
    ...files.map((name) => ({ key: `f:${name}`, abs: `${dir}/${name}`, name, kind: 'file' })),
  ];
}

const packAnchorKey = (list) => (list === 'entries' ? 'entriesAnchor' : 'browseAnchor');

/**
 * A click on row `key` of `list`: plain selects it alone, ⌘ toggles it, shift takes the range from
 * the anchor. A file (or an entry) selected this way is also played - hearing it IS the point of
 * selecting it - and a lone folder says how many files it holds.
 */
function packSelectClick(list, key, e) {
  const rows = packRows(list);
  const sel = packSel[list];
  const anchorKey = packAnchorKey(list);
  const at = rows.findIndex((r) => r.key === key);
  if (at < 0) return;
  if (e.shiftKey && packSel[anchorKey] != null) {
    const from = rows.findIndex((r) => r.key === packSel[anchorKey]);
    if (!(e.metaKey || e.ctrlKey)) sel.clear();
    const [a, b] = from < 0 ? [at, at] : [Math.min(from, at), Math.max(from, at)];
    for (let i = a; i <= b; i++) sel.add(rows[i].key);
  } else if (e.metaKey || e.ctrlKey) {
    if (sel.has(key)) sel.delete(key);
    else sel.add(key);
    packSel[anchorKey] = key;
  } else {
    sel.clear();
    sel.add(key);
    packSel[anchorKey] = key;
  }
  packAfterSelect(list, rows[at]);
}

/** Arrow keys: move the anchor a row, shift dragging the selection along with it. */
function packSelectStep(list, delta, extend) {
  const rows = packRows(list);
  if (!rows.length) return;
  const anchorKey = packAnchorKey(list);
  const from = rows.findIndex((r) => r.key === packSel[anchorKey]);
  const to = Math.max(0, Math.min(rows.length - 1, (from < 0 ? (delta > 0 ? -1 : rows.length) : from) + delta));
  const sel = packSel[list];
  if (!extend) sel.clear();
  sel.add(rows[to].key);
  packSel[anchorKey] = rows[to].key;
  packAfterSelect(list, rows[to]);
}

/** ⌘A: every file in the list (folders are a different kind of thing to add; they stay unselected). Plays the last, so something is heard. */
function packSelectAll(list) {
  const rows = packRows(list).filter((r) => list === 'entries' || r.kind === 'file');
  if (!rows.length) return;
  packSel[list] = new Set(rows.map((r) => r.key));
  packSel[packAnchorKey(list)] = rows[rows.length - 1].key;
  packAfterSelect(list, rows[rows.length - 1]);
}

function packAfterSelect(list, row) {
  if (list === 'entries') packRenderEntries();
  else packRenderBrowse();
  packScrollTo(list, row.key);
  if (row.kind === 'file') packPlay(row.abs, row.name);
  else if (list === 'browse') packDescribeFolder(row.abs, row.name);
}

function packScrollTo(list, key) {
  const box = list === 'entries' ? packEntriesEl : packBrowseList;
  const el = [...box.children].find((c) => c.dataset.key === String(key));
  if (!el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

// --- searching, and folders as whole trees -------------------------------------------------------
// One endpoint serves both: it walks everything audio under a folder and filters by the query.
// No query means the whole tree, which is what adding a folder takes.

const packFindFetch = (dir, q, limit) =>
  api('GET', `/api/findSamples?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}&limit=${limit}`);

const packFindActive = () => packFind.query !== '';

/**
 * Every audio file under a folder, relative to it - what selecting a folder adds, and what the
 * folder says about itself when you click it. Held for a moment so that clicking a folder and then
 * adding it is one walk, and so arrowing back up a list of folders doesn't re-walk each one.
 */
function packWalk(dir) {
  const hit = packWalks.get(dir);
  if (hit && Date.now() - hit.at < PACK_WALK_TTL_MS) return hit.walk;
  const walk = packFindFetch(dir, '', PACK_WALK_LIMIT)
    .then((r) => ({ path: r.path, files: r.files ?? [], truncated: !!r.truncated }))
    .catch((err) => { packWalks.delete(dir); throw err; }); // a failed walk must not stick
  packWalks.set(dir, { at: Date.now(), walk });
  return walk;
}

/** Back to showing the folder itself. Callers that are about to redraw anyway pass render = false. */
function packFindClear(render = true) {
  clearTimeout(packFindTimer);
  packFindTimer = null;
  packFind = { query: '', running: false, files: [], matched: 0, total: 0, truncated: false, seq: packFind.seq + 1 };
  packSel.browse.clear();
  packSel.browseAnchor = null;
  if (render) packRenderBrowse();
}

/**
 * A keystroke in the search box. The old matches stay on screen until the new ones land - typing
 * another letter narrows what is already there, so blanking the list between keystrokes would only
 * flicker.
 */
function packQueueFind() {
  const q = packBrowseSearch.value.trim();
  clearTimeout(packFindTimer);
  if (!q) return packFindClear();
  packFind.query = q;
  packFind.running = true;
  packFindTimer = setTimeout(() => packRunFind(q), PACK_FIND_DEBOUNCE_MS);
  packRenderBrowse();
}

async function packRunFind(q) {
  const dir = packBrowse.path;
  if (dir == null) return;
  const seq = ++packFind.seq;
  try {
    const r = await packFindFetch(dir, q, PACK_FIND_SHOW);
    if (seq !== packFind.seq) return; // a later keystroke owns the list now
    Object.assign(packFind, { files: r.files ?? [], matched: r.matched ?? 0, total: r.total ?? 0, truncated: !!r.truncated });
  } catch (err) {
    if (seq !== packFind.seq) return;
    Object.assign(packFind, { files: [], matched: 0, total: 0, truncated: false });
    packSay(err.message ?? String(err), true);
  }
  packFind.running = false;
  packSel.browse.clear(); // the rows underneath the selection just changed
  packSel.browseAnchor = null;
  packRenderBrowse();
}

/** What the browse column says about itself: the search's tally, or nothing when not searching. */
function packFindNote() {
  if (!packFindActive()) return '';
  if (packFind.running && !packFind.files.length) return 'searching…';
  const parts = [packFind.matched
    ? `${packFind.matched} of ${packFind.total} files match`
    : `no match in ${packFind.total} files`];
  if (packFind.matched > packFind.files.length) parts.push(`first ${packFind.files.length} shown`);
  if (packFind.truncated) parts.push('big tree, searched part of it');
  return `· ${parts.join(' · ')}`;
}

async function packDescribeFolder(abs, name) {
  try {
    const { files, truncated } = await packWalk(abs);
    if (!packSel.browse.has(`d:${name}`)) return;
    const deep = files.some((f) => f.includes('/'));
    packSay(`${name} · ${files.length}${truncated ? '+' : ''} audio file${files.length === 1 ? '' : 's'}${deep ? ', subfolders and all' : ''} · ← adds them all, double-click goes in`);
  } catch { /* the walk failed - the folder still adds nothing, which the add will say */ }
}

/**
 * ← / the add button: the selection into the pack - files as they are, folders as every audio file
 * anywhere under them (subfolders walked, each folder's own files first). Nothing selected means
 * the whole folder on screen, or, while searching, every match - including the ones past the rows
 * drawn, which is why that case goes back to the server for the full list.
 */
async function packAddSelected() {
  if (!packState?.own) return packRefuseLibrary();
  const rows = packRows('browse');
  const picked = rows.filter((r) => packSel.browse.has(r.key));
  if (!picked.length && packFindActive()) {
    try {
      const r = await packFindFetch(packBrowse.path, packFind.query, PACK_WALK_LIMIT);
      const all = (r.files ?? []).map((f) => `${r.path}/${f}`);
      if (!all.length) return packSay('nothing matches', true);
      return packAdd(all);
    } catch (err) {
      return packSay(err.message ?? String(err), true);
    }
  }
  const chosen = picked.length ? picked : rows.filter((r) => r.kind === 'file');
  const paths = [];
  let clipped = false;
  for (const r of chosen) {
    if (r.kind === 'file') { paths.push(r.abs); continue; }
    try {
      const { path: dir, files, truncated } = await packWalk(r.abs);
      paths.push(...files.map((f) => `${dir}/${f}`));
      clipped ||= truncated;
    } catch (err) {
      packSay(err.message ?? String(err), true);
    }
  }
  if (!paths.length) return packSay('nothing to add here', true);
  packAdd(paths);
  if (clipped) packSay(`that is a big tree — took the first ${paths.length} files`, true);
}

function packRemoveSelected() {
  packRemoveIndexes([...packSel.entries].map(Number));
}

// --- the lists ---------------------------------------------------------------------------------

function packRenderEntries() {
  packEntriesEl.innerHTML = '';
  if (!packState) return;
  const n = packState.entries.length;
  packEntriesHead.textContent = `${n} file${n === 1 ? '' : 's'}${packState.own ? '' : ' · library'}`;
  const nSel = packSel.entries.size;
  packRemoveSelBtn.disabled = !nSel || !packState.own;
  packRemoveSelBtn.textContent = nSel > 1 ? `remove ${nSel} →` : 'remove →';
  if (!n) {
    const empty = document.createElement('div');
    empty.className = 'dir-empty';
    empty.textContent = packState.own ? 'empty - pick files on the right' : 'empty';
    packEntriesEl.appendChild(empty);
    return;
  }
  for (const row of packRows('entries')) {
    const i = row.key;
    const entry = packState.entries[i];
    const el = document.createElement('div');
    el.className = `pack-entry${packSel.entries.has(i) ? ' selected' : ''}${packPlayer.abs === row.abs ? ' playing' : ''}`;
    el.dataset.key = String(i);
    const idx = document.createElement('span');
    idx.className = 'pack-entry-index';
    idx.textContent = String(i);
    idx.title = `sp("${packState.id}:${i}") / .i(${i})`;
    el.appendChild(idx);
    const name = document.createElement('span');
    name.className = 'pack-entry-name';
    name.textContent = `${row.kind === 'dir' ? '📁 ' : ''}${row.name}`;
    name.title = row.kind === 'dir' ? `${entry} - a folder: every audio file in it, in name order` : entry;
    el.appendChild(name);
    if (packState.own) {
      const up = document.createElement('span');
      up.className = `pack-entry-btn${i === 0 ? ' off' : ''}`;
      up.textContent = '↑';
      up.title = 'move up (lower index)';
      up.addEventListener('click', (e) => { e.stopPropagation(); packMove(i, -1); });
      el.appendChild(up);
      const down = document.createElement('span');
      down.className = `pack-entry-btn${i === n - 1 ? ' off' : ''}`;
      down.textContent = '↓';
      down.title = 'move down (higher index)';
      down.addEventListener('click', (e) => { e.stopPropagation(); packMove(i, 1); });
      el.appendChild(down);
    }
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keeps the list focused for the keys, rather than selecting text
      packEntriesEl.focus({ preventScroll: true });
      packSelectClick('entries', i, e);
    });
    packEntriesEl.appendChild(el);
  }
}

async function packBrowseTo(target) {
  packSay('');
  try {
    const { path, parent, dirs, files, samplesRoot } = await api('GET', `/api/browseDir?path=${encodeURIComponent(target ?? '')}`);
    packBrowse = { path, parent, dirs, files: files ?? [], samplesRoot: samplesRoot ?? '' };
    packBrowsePath.value = path;
    packSel.browse.clear(); // a selection is of rows in THIS folder
    packSel.browseAnchor = null;
    packBrowseSearch.value = ''; // a search is of THIS folder's tree; going somewhere ends it
    packFindClear(false);
    packRenderBrowse();
  } catch (e) {
    packSay(e.message ?? String(e), true);
  }
}

function packRenderBrowse() {
  const { path: dir, parent } = packBrowse;
  packBrowseList.innerHTML = '';
  packBrowseHead.textContent = packFindNote();
  if (dir == null) return;
  const rows = packRows('browse');
  const finding = packFindActive();
  const nSel = packSel.browse.size;
  const nFiles = finding ? packFind.matched : rows.filter((r) => r.kind === 'file').length;
  packAddSelBtn.disabled = !packState?.own || (!nSel && !nFiles);
  packAddSelBtn.textContent = nSel
    ? `← add ${nSel > 1 ? nSel : ''}`.trimEnd()
    : finding ? `← add all ${nFiles} matches` : `← add all ${nFiles} here`;
  packAddSelBtn.title = nSel
    ? 'add the selection to the pack (←)'
    : finding ? 'add every file that matches, wherever it is (←)' : 'add every audio file in this folder (←)';
  if (parent && !finding) {
    const up = document.createElement('div');
    up.className = 'dir-row dir-up';
    up.textContent = '↑ ..';
    up.addEventListener('click', () => packBrowseTo(parent));
    packBrowseList.appendChild(up);
  }
  const have = new Set((packState?.entries ?? []).map((e) => packAbsOf(e)));
  for (const row of rows) {
    const el = document.createElement('div');
    const selected = packSel.browse.has(row.key);
    if (row.kind === 'dir') {
      el.className = `dir-row pack-dir-row${selected ? ' selected' : ''}`;
      el.title = 'click to select (← adds everything in it) · double-click to go in';
      el.addEventListener('dblclick', (e) => { e.preventDefault(); packBrowseTo(row.abs); });
    } else {
      el.className = `pack-file-row${have.has(row.abs) ? ' on' : ''}${selected ? ' selected' : ''}${packPlayer.abs === row.abs ? ' playing' : ''}`;
      el.title = have.has(row.abs) ? `${row.abs} - in the pack already` : `${row.abs}\nclick to hear and select · ← (or double-click) adds to the pack`;
      el.addEventListener('dblclick', (e) => { e.preventDefault(); packAdd([row.abs]); });
    }
    el.dataset.key = row.key;
    const label = document.createElement('span');
    label.className = row.kind === 'dir' ? 'pack-dir-name' : 'pack-file-name';
    // A search hit's name is its path from here: the folders it sits in read quieter than the file,
    // and are the half that gets cut short when the row is too narrow for both.
    const cut = row.name.lastIndexOf('/');
    if (cut < 0) {
      label.textContent = row.name;
    } else {
      label.classList.add('has-path');
      const where = document.createElement('span');
      where.className = 'pack-file-dir';
      where.textContent = row.name.slice(0, cut + 1);
      const base = document.createElement('span');
      base.className = 'pack-file-base';
      base.textContent = row.name.slice(cut + 1);
      label.append(where, base);
    }
    el.appendChild(label);
    el.addEventListener('mousedown', (e) => {
      if (e.detail > 1) return; // the double-click's second press: the dblclick handler has it
      e.preventDefault();
      packBrowseList.focus({ preventScroll: true });
      packSelectClick('browse', row.key, e);
    });
    packBrowseList.appendChild(el);
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'dir-empty';
    empty.textContent = finding ? (packFind.running ? 'searching…' : `nothing under here matches "${packFind.query}"`) : 'nothing here';
    packBrowseList.appendChild(empty);
  }
}

// --- the player --------------------------------------------------------------------------------
// One file at a time, played whole from the moment it is selected, with a transport along the
// foot: play/pause (space), and a bar to scrub. Shares the sounds tab's AudioContext (previewCtx),
// not its hold-to-hear gesture - picking from a list wants the whole file, not as long as a press.

const packPlayer = { abs: null, name: '', buffer: null, source: null, startedAt: 0, offset: 0, playing: false, raf: null, gen: 0 };
const packBuffers = new Map(); // abs -> decoded AudioBuffer, so walking back up a list is instant
const PACK_BUFFER_CACHE = 48;

async function packLoadBuffer(abs) {
  if (packBuffers.has(abs)) return packBuffers.get(abs);
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  const res = await fetch(`/api/sampleAudio?file=${encodeURIComponent(abs)}`);
  if (!res.ok) throw new Error(`can't read ${packBasename(abs)} (${res.status})`);
  const buf = await previewCtx.decodeAudioData(await res.arrayBuffer());
  if (packBuffers.size >= PACK_BUFFER_CACHE) packBuffers.delete(packBuffers.keys().next().value);
  packBuffers.set(abs, buf);
  return buf;
}

async function packPlay(abs, name = packBasename(abs)) {
  const blocked = auditionBlocked();
  if (blocked) { packPlayerStopSource(); return packSay(blocked, true); }
  const gen = ++packPlayer.gen;
  packPlayerStopSource();
  Object.assign(packPlayer, { abs, name, buffer: null, offset: 0 });
  packRenderTransport();
  packMarkPlaying();
  try {
    const buf = await packLoadBuffer(abs);
    if (gen !== packPlayer.gen) return; // a newer pick superseded this one while it decoded
    packPlayer.buffer = buf;
    packPlayerStart(0);
  } catch (e) {
    if (gen === packPlayer.gen) packSay(e.message ?? String(e), true);
  }
}

function packPlayerStopSource() {
  if (packPlayer.source) {
    const src = packPlayer.source;
    packPlayer.source = null;
    src.onended = null;
    try { src.stop(); } catch { /* already ended */ }
  }
  packPlayer.playing = false;
  cancelAnimationFrame(packPlayer.raf);
}

function packPlayerStart(offset) {
  const buf = packPlayer.buffer;
  if (!buf) return;
  const blocked = auditionBlocked(); // DJ mode may have come on since this buffer was decoded
  if (blocked) return packSay(blocked, true);
  packPlayerStopSource();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {});
  const at = Math.max(0, Math.min(offset, buf.duration));
  const src = previewCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewCtx.destination);
  src.start(0, at);
  Object.assign(packPlayer, { source: src, startedAt: previewCtx.currentTime - at, offset: at, playing: true });
  src.onended = () => {
    if (packPlayer.source !== src) return;
    packPlayer.source = null;
    packPlayer.playing = false;
    packPlayer.offset = 0;
    packRenderTransport();
  };
  packPlayerTick();
}

const packPlayerPosition = () => (packPlayer.playing ? previewCtx.currentTime - packPlayer.startedAt : packPlayer.offset);

function packPlayerPause() {
  if (!packPlayer.playing) return;
  packPlayer.offset = packPlayerPosition();
  packPlayerStopSource();
  packRenderTransport();
}

function packPlayerToggle() {
  if (!packPlayer.buffer) return;
  if (packPlayer.playing) packPlayerPause();
  else packPlayerStart(packPlayer.offset >= packPlayer.buffer.duration - 0.01 ? 0 : packPlayer.offset);
}

function packPlayerSeek(frac) {
  if (!packPlayer.buffer) return;
  packPlayer.offset = Math.max(0, Math.min(1, frac)) * packPlayer.buffer.duration;
  if (packPlayer.playing) packPlayerStart(packPlayer.offset);
  else packRenderTransport();
}

function packPlayerTick() {
  cancelAnimationFrame(packPlayer.raf);
  packRenderTransport();
  if (packPlayer.playing) packPlayer.raf = requestAnimationFrame(packPlayerTick);
}

function packRenderTransport() {
  const d = packPlayer.buffer?.duration ?? 0;
  const pos = Math.min(d, Math.max(0, packPlayerPosition()));
  packPlayBtn.textContent = packPlayer.playing ? '❚❚' : '▶';
  packPlayBtn.disabled = !packPlayer.buffer;
  packPlayName.textContent = packPlayer.name;
  packPlayName.title = packPlayer.abs ?? '';
  packPlayHead.style.width = d ? `${(pos / d) * 100}%` : '0%';
  packPlayTime.textContent = d ? `${pos.toFixed(2)} / ${d.toFixed(2)}s` : '';
}

// The rows that ARE the playing file light up, in both lists, without redrawing them.
function packMarkPlaying() {
  for (const box of [packEntriesEl, packBrowseList]) {
    for (const el of box.children) {
      const key = el.dataset.key;
      if (key == null) continue;
      const rows = box === packEntriesEl ? packRows('entries') : packRows('browse');
      const row = rows.find((r) => String(r.key) === key);
      el.classList.toggle('playing', !!row && row.abs === packPlayer.abs);
    }
  }
}

// The reverse direction: a hand edit to the definition (or its removal) shows in the panel. Checked
// after the change settles, since a rename rewrites the id before the panel learns the new one.
function packSyncFromCode() {
  if (!packState || packSuppressSync) return;
  setTimeout(() => {
    if (!packState) return;
    const def = packDefOf(packState.id);
    if (!def) {
      if (packState.own && !prPrebakePacks.some((p) => p.id === packState.id)) closePackPanel();
      return;
    }
    const entries = packEntriesOf(cm.getValue(), def);
    if (JSON.stringify(entries) === JSON.stringify(packState.entries) && packState.own) return;
    packState.entries = entries;
    packState.own = true;
    packSel.entries.clear();
    packRenderEntries();
    packRenderBrowse();
  }, 0);
}

// The keys a list answers to, once it has focus (clicking a row gives it focus).
function packListKeys(list, e) {
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    packSelectStep(list, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  } else if (meta && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    packSelectAll(list);
  } else if (e.key === ' ') {
    e.preventDefault();
    packPlayerToggle();
  } else if (list === 'browse' && (e.key === 'ArrowLeft' || e.key === 'Enter')) {
    e.preventDefault();
    // Enter on one folder goes in (the folder is what a lone selection mostly is); otherwise it adds.
    const sel = [...packSel.browse];
    if (e.key === 'Enter' && sel.length === 1 && String(sel[0]).startsWith('d:')) packBrowseTo(`${packBrowse.path}/${String(sel[0]).slice(2)}`);
    else packAddSelected();
  } else if (list === 'entries' && (e.key === 'ArrowRight' || e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    packRemoveSelected();
  } else if (e.key === 'Escape') {
    return; // the panel's, handled on the document
  } else {
    return;
  }
  e.stopPropagation();
}

function initPackPanel() {
  cm.on('change', packSyncFromCode);

  packName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); packName.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); packHead.revertName(); packName.blur(); return; }
    e.stopPropagation();
  });
  packName.addEventListener('blur', () => packHead.commitName());

  packSearch.addEventListener('input', () => packHead.renderList(true));
  packSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); packHead.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); packHead.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); packHead.choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePackPanel(); return; }
    e.stopPropagation();
  });

  packBrowsePath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); packBrowseTo(packBrowsePath.value.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePackPanel(); return; }
    e.stopPropagation();
  });

  // The search box: typing filters, ↓ (or enter) drops into the results to hear them, and escape
  // backs out of the search before it backs out of the panel.
  packBrowseSearch.addEventListener('input', () => packQueueFind());
  packBrowseSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (packBrowseSearch.value) { packBrowseSearch.value = ''; packFindClear(); }
      else closePackPanel();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      if (packRows('browse').length) {
        packBrowseList.focus({ preventScroll: true });
        packSelectStep('browse', 1, false);
      }
    }
    e.stopPropagation();
  });
  packBrowseList.addEventListener('keydown', (e) => packListKeys('browse', e));
  packEntriesEl.addEventListener('keydown', (e) => packListKeys('entries', e));
  packAddSelBtn.addEventListener('click', () => packAddSelected());
  packRemoveSelBtn.addEventListener('click', () => packRemoveSelected());

  // The transport: play/pause, and a bar that scrubs - held down it follows the pointer, and a
  // file that was playing picks up again where the pointer lets go.
  packPlayBtn.addEventListener('click', () => packPlayerToggle());
  let scrubWasPlaying = false;
  const scrubTo = (e) => {
    const r = packPlayBar.getBoundingClientRect();
    packPlayerSeek((e.clientX - r.left) / Math.max(1, r.width));
  };
  packPlayBar.addEventListener('pointerdown', (e) => {
    if (!packPlayer.buffer) return;
    e.preventDefault();
    packPlayBar.setPointerCapture(e.pointerId);
    scrubWasPlaying = packPlayer.playing;
    packPlayerPause();
    scrubTo(e);
  });
  packPlayBar.addEventListener('pointermove', (e) => {
    if (packPlayBar.hasPointerCapture?.(e.pointerId)) scrubTo(e);
  });
  packPlayBar.addEventListener('pointerup', (e) => {
    if (!packPlayBar.hasPointerCapture?.(e.pointerId)) return;
    packPlayBar.releasePointerCapture(e.pointerId);
    if (scrubWasPlaying) packPlayerStart(packPlayer.offset);
  });

  packCloseBtn.addEventListener('click', () => closePackPanel());
  packBackdrop.addEventListener('click', (e) => { if (e.target === packBackdrop) closePackPanel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && packState) closePackPanel();
  });
}

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

// The editor whichever hotkey is running resolved to, held for the whole handler (activeCM
// returns it in preference to live focus). Saved and restored rather than cleared: a chord
// pressed while an earlier async handler is parked on a prompt() must give that one its deck
// back when it finishes.
let gestureCM = null;

async function runHotkey(hk, e) {
  const outerCM = gestureCM;
  gestureCM = activeCM();
  try {
    await hk.handler(e);
  } catch (err) {
    logLine(`hotkey ${hk.combo}: ${err.message ?? err}`, true);
  } finally {
    gestureCM = outerCM;
  }
}

// A blocking modal (prebake editor, folder picker, midi import) is open - don't let chords reach
// through it.
function anyModalOpen() {
  // askEl only exists once something has asked; it is built shown, so "not hidden" means open.
  return [prebakeBackdrop, dirPickerBackdrop, midiImportBackdrop, snippetSaveBackdrop, snippetBrowseBackdrop, askEl]
    .some((el) => el && !el.classList.contains('hidden'));
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

// ctrl+m - toggle the open piano roll's computer keyboard (its ⌨ button).
addHotkey(builtinHotkeys, 'ctrl+m', () => { if (prState) prSetKeyboard(!prKbOn); else logLine('open a piano roll first - ⌨ plays the roll on screen', true); }, 'toggle the roll\'s computer keyboard');

// ctrl+q - quantize the open roll (a dialog asks which division). Ctrl, not cmd: cmd+Q is the
// browser quitting, and no page gets to intercept that.
addHotkey(builtinHotkeys, 'ctrl+q', () => (prState ? prQuantize() : logLine('open a piano roll first - ctrl+Q quantizes the roll on screen', true)), 'quantize the roll');

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

// Is deck B a code pane right now? Only while the split is open and the pane isn't showing a
// song file - a deck holding a file has its editor hidden, and its (readOnly) buffer is a
// descriptor card, so a hotkey aimed there would write into something nobody can see.
function deckBIsCode() {
  return mixModeOn && !!deckBCM && !deckBPaneEl.classList.contains('song-on');
}

/**
 * The editor an editor-scripting gesture belongs to. Outside DJ mode that is only ever the main
 * buffer; with the split open it's the pane holding the caret, so a prebake hotkey writes into
 * the deck you are typing in rather than always into deck A.
 *
 * Three answers, in order: the editor a running hotkey resolved to when it fired (see runHotkey -
 * a handler that awaits a prompt() has lost focus by the time it resumes, and must still land
 * where it started); the editor focused right now; and failing both - a hotkey pressed with the
 * caret in a button or the sidebar - the last editor that held it.
 */
function activeCM() {
  if (gestureCM) return gestureCM;
  if (deckBIsCode() && deckBCM.hasFocus()) return deckBCM;
  if (cm.hasFocus()) return cm;
  return lastFocusedCM === deckBCM && deckBIsCode() ? deckBCM : cm;
}

// editor: a thin, offset-based facade over the focused CodeMirror instance, close to Strudel's
// `repl` so ports read the same. Offsets are character indices into the whole document. Every
// method re-resolves the editor rather than closing over one, so the same handle scripts deck A
// or deck B depending on where the gesture came from.
const editor = {
  get cm() { return activeCM(); },
  get code() { return activeCM().getValue(); },
  getCode() { return activeCM().getValue(); },
  setCode(str) { activeCM().setValue(str); },
  appendCode(str) {
    const ed = activeCM();
    ed.replaceRange(str, ed.posFromIndex(ed.getValue().length));
  },
  insertCode(str, at) {
    const ed = activeCM();
    ed.replaceRange(str, at == null ? ed.getCursor() : ed.posFromIndex(at));
  },
  replaceCode(str, from, to) {
    const ed = activeCM();
    ed.replaceRange(str, ed.posFromIndex(from), ed.posFromIndex(to));
  },
  sliceCode(from, to) {
    const ed = activeCM();
    return ed.getRange(ed.posFromIndex(from), ed.posFromIndex(to));
  },
  getCursorLocation() {
    const ed = activeCM();
    return ed.indexFromPos(ed.getCursor());
  },
  setCursorLocation(at) {
    const ed = activeCM();
    ed.setCursor(ed.posFromIndex(at));
    ed.focus();
  },
  // { from, to, text } as character offsets; from === to when nothing is selected.
  getSelection() {
    const ed = activeCM();
    const from = ed.indexFromPos(ed.getCursor('from'));
    const to = ed.indexFromPos(ed.getCursor('to'));
    return { from, to, text: ed.getRange(ed.posFromIndex(from), ed.posFromIndex(to)) };
  },
  focus() { activeCM().focus(); },
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

// ---------------------------------------------------------------------------------------------
// Mix mode - the performance mixer (Cmd/Ctrl+Shift+X). The screen splits into two decks: the
// main editor keeps playing as deck A while the second pane holds the INCOMING song, evaluated
// as deck "b" (same clock, so it joins in phase; namespaced labels, so its kick and yours are
// separate tracks; born wearing the crossfader's gain, so it arrives silent). Between them the
// strip: per-track gate / trim / 3-band EQ / fader, a one-knob filter per deck, the equal-power
// crossfader, swap mode, eject and complete.
//
// All of it is EPHEMERAL performance state (server.js's mixState): nothing here ever writes
// into song code - deliberately unlike the ctrl+g mixer, whose faders edit .gain() calls. A DJ
// move must not rewrite the song.
//
// Opening or closing the split never touches the sound (hide the desk, keep the music); eject
// and complete are the two ways a mix ends. Deck B's pane is a plain editor for now: no playback
// highlighting (the grid machinery is single-pane), and its edits live only in the pane - a mix
// plays saved songs. Complete hands its buffer (and file name) to the main editor, whose re-eval
// finds every promoted track already playing under its new name and reprograms nothing.
// ---------------------------------------------------------------------------------------------

let mixModeOn = false;
let deckBCM = null; // CodeMirror in the deck B pane, created on first open
let deckBFileName = null; // the saved pattern deck B holds - what complete hands the files tab
let deckFileItems = new Map(); // deck picker option value ('file:<path>') -> its playlist file item

const mixStripEl = document.getElementById('mixStrip');
const deckBPaneEl = document.getElementById('deckBPane');
const MIX_NEUTRAL = { trim: 1, eqlo: 1, eqmid: 1, eqhi: 1, djf: 0, djres: 0, fader: 1 };

// One POST per ~50ms however fast the sliders stream: each control keeps only its latest value,
// and the batch goes out together (the crossfader is two targets in one).
const mixPending = new Map();
let mixFlushTimer = null;
function mixPost(throttleKey, body) {
  mixPending.set(throttleKey, body);
  if (mixFlushTimer) return;
  mixFlushTimer = setTimeout(() => {
    mixFlushTimer = null;
    const batch = [...mixPending.values()].flatMap((b) => b.targets ?? [b]);
    mixPending.clear();
    api('POST', '/api/mix/set', { targets: batch }).catch((e) => logLine(e.message ?? String(e), true));
  }, 50);
}

function toggleMixMode() {
  if (mixModeOn) exitDjMode('restore');
  else openMixMode();
}

// The app's own modal, one at a time: a backdrop over everything, esc or a click outside it
// answering null. `build(panel, done)` fills the panel in and closes through `done`; whatever it
// returns is focused once the thing is on screen. The two dialogs below are all this is for -
// anything bigger gets its own panel.
let askEl = null;
function askShell(build) {
  return new Promise((resolve) => {
    if (!askEl) {
      askEl = document.createElement('div');
      askEl.id = 'askModal';
      document.body.appendChild(askEl);
    }
    askEl.innerHTML = '';
    const panel = document.createElement('div');
    panel.id = 'askPanel';
    const done = (v) => {
      askEl.classList.add('hidden');
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      done(null);
    }
    const focus = build(panel, done);
    askEl.appendChild(panel);
    askEl.classList.remove('hidden');
    askEl.onclick = (e) => { if (e.target === askEl) done(null); };
    window.addEventListener('keydown', onKey, true); // capture: esc must not fall through to the editor
    focus?.focus();
  });
}

/** The row of buttons every dialog ends with; the primary one is the default answer. */
function askButtons(choices, done) {
  const row = document.createElement('div');
  row.className = 'ask-row';
  for (const c of choices) {
    const b = document.createElement('button');
    b.textContent = c.label;
    if (c.primary) b.className = 'primary';
    b.addEventListener('click', () => done(c.value()));
    row.appendChild(b);
  }
  return row;
}

// A small in-style choice dialog - what native confirm() can't be: three-way, styled like the
// app, and honest about which button does what. Resolves the picked choice's value; esc or a
// click on the backdrop resolve null (the "cancel" answer, so give no choice the value null).
function askDialog(message, choices) {
  return askShell((panel, done) => {
    const msg = document.createElement('p');
    msg.textContent = message;
    const row = askButtons(choices.map((c) => ({ ...c, value: () => c.value })), done);
    panel.append(msg, row);
    return row.querySelector('button.primary');
  });
}

// The same dialog with one control in it: a labelled <select>, for a question whose answer is a
// value rather than a button. Resolves the SELECT's value (options are [label, value] pairs), or
// null for cancel / esc / the backdrop. Enter answers it from the keyboard, which is what makes
// having a sensible default worth anything.
function askSelect(message, { label, options, value, confirm = 'ok' }) {
  return askShell((panel, done) => {
    const msg = document.createElement('p');
    msg.textContent = message;
    const field = document.createElement('label');
    field.className = 'ask-field';
    field.textContent = label;
    const sel = document.createElement('select');
    for (const [text, v] of options) sel.add(new Option(text, String(v)));
    sel.value = String(value);
    field.appendChild(sel);
    const pick = () => (typeof value === 'number' ? Number(sel.value) : sel.value);
    const row = askButtons([
      { label: 'cancel', value: () => null },
      { label: confirm, value: pick, primary: true },
    ], done);
    panel.append(msg, field, row);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      done(pick());
    });
    return sel;
  });
}

// ...and the same dialog with a text field in it, for a question whose answer is a word - a
// rename. `problem(value)` is what greys the confirm button out, with the reason on the button's
// own title, so a name the server would refuse is refused here first.
function askText(message, { label, value = '', confirm = 'ok', problem = null } = {}) {
  return askShell((panel, done) => {
    const msg = document.createElement('p');
    msg.textContent = message;
    const field = document.createElement('label');
    field.className = 'ask-field';
    field.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = value;
    field.appendChild(input);
    const row = askButtons([
      { label: 'cancel', value: () => null },
      { label: confirm, value: () => input.value.trim(), primary: true },
    ], done);
    const ok = row.querySelector('button.primary');
    const sync = () => {
      const why = problem?.(input.value.trim()) ?? null;
      ok.disabled = !!why;
      ok.title = why ?? '';
    };
    input.addEventListener('input', sync);
    panel.append(msg, field, row);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || ok.disabled) return;
      e.preventDefault();
      done(input.value.trim());
    });
    sync();
    setTimeout(() => input.select(), 0); // after askShell has focused it
    return input;
  });
}

// What the single-editor world held when DJ mode opened: leaving with the hotkey brings it back
// (see exitDjMode). Null while not in DJ mode.
let preMix = null;

async function openMixMode() {
  // The current song is about to become deck A of a mix. Keep it first: a named song is saved
  // over silently (saving over the open pattern is what saving is), a nameless one gets one
  // three-way offer - "don't save" just means the pre-mix buffer only lives in this browser
  // till exit, and cancel stays out of DJ mode entirely.
  try {
    if (currentSavedName) await savePatternFile();
    else if (cm.getValue().trim()) {
      const choice = await askDialog('Save the current song before DJ mode? It comes back when you exit.', [
        { label: 'save', value: 'save', primary: true },
        { label: "don't save", value: 'skip' },
        { label: 'cancel', value: null },
      ]);
      if (choice === null) return;
      if (choice === 'save') await savePatternFileAs();
    }
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
  preMix = { code: cm.getValue(), savedName: currentSavedName, wipSession: wipSessionId };
  if (mixerState) closeMixer(); // the modal's meter load is the audio glitch openMixer refuses
  mixModeOn = true;
  syncPreviewRouting(); // auditions move to the headphone cue, or stop being allowed at all
  document.body.classList.add('mix-on');
  deckBPaneEl.classList.remove('hidden');
  mixStripEl.classList.remove('hidden');
  applyMixStack(); // the stacked layout, if it's this browser's preference
  djApplyRegionSizes(); // which region is springy depends on that (and on mix-on)
  djSetActiveDeck('a'); // deck A is armed until the other pane is clicked
  if (!deckBCM) {
    deckBCM = CodeMirror.fromTextArea(document.getElementById('deckBEditor'), {
      mode: { name: 'javascript' },
      theme: 'poptart',
      keyMap: 'sublime',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Cmd-Enter': () => evalDeckB(true),
        'Ctrl-Enter': () => evalDeckB(true),
        'Shift-Cmd-Enter': () => exitDjMode('b'),
        'Shift-Ctrl-Enter': () => exitDjMode('b'),
        'Cmd-.': () => doStop('b'), // this pane's deck only; deck A plays on
        'Ctrl-.': () => doStop('b'),
        'Ctrl-Space': (ed) => showPoptartHint(ed),
      },
    });
    // Deck B is a live-coding pane, not a text box: same completions, ctrl-hover docs and
    // prebake-hotkey targeting as the main buffer, all resolved against ITS code.
    attachEditorWiring(deckBCM);
  }
  deckBCM.refresh();
  cm.refresh();
  // The crossfader's position becomes real state NOW, before anything plays on deck B: hard at
  // A means deck b's gain is 0 in mixState, so the first eval's tracks are BORN silent (see
  // server.js's applyMixTo) - the whole "arrives silent" design in one post.
  sendCrossfader();
  refreshDeckFiles();
  mixRefresh();
  mixPushStart(); // mirrors MIDI-driven desk moves back onto the sliders, pushed live
}

// Leave DJ mode. `keep` says which world survives:
//   'a'       - this pane is the song: deck B is dropped (destroyed), the main editor stays.
//   'b'       - the incoming song IS the set: promoted with zero engine churn, its code moves
//               to the main editor (the old complete-mix).
//   'restore' - the hotkey: back to whatever was up before DJ mode. If deck A still holds it,
//               nothing even blinks; if deck A moved on, both decks are cleared and the
//               pre-mix buffer returns (stopped - play is a deliberate act after that).
async function exitDjMode(keep = 'restore') {
  try {
    if (keep === 'b') {
      if (songPanes.b.song) {
        // The main editor can't hold a song file - promoting one is the complete-mix oddment
        // still in TODO.md. Until then the mix ends by exiting and letting the song play on.
        logLine('deck B holds a song file - a file can\'t be kept as the main editor; stop it and leave DJ mode with restore');
        return;
      }
      const res = await api('POST', '/api/mix/complete');
      cm.setValue(deckBCM.getValue());
      setCurrentSavedName(deckBFileName);
      clearPatternRegions('b'); // the re-eval below rebuilds them as deck A's, in the main editor
      logLine(`DJ mode off - "${deckBFileName ?? 'deck B'}" is the set (promoted: ${res.promoted.join(', ')})`);
      finishDjExit();
      await evaluate(true); // finds every promoted track already playing; reprograms nothing
      return;
    }
    if (keep === 'a' && songPanes.a.song) {
      // "Keep this pane" promises the main editor survives - but this pane is a FILE, and the
      // single-editor world can't hold one (the complete-mix oddment, from the other side).
      logLine('deck A holds a song file - a file can\'t be kept as the main editor; stop it and leave DJ mode with restore');
      return;
    }
    if (deckBCM?.getValue().trim() && !confirm('Leave DJ mode? Deck B is dropped.')) return;
    // A song on deck A counts as "moved on": the restored buffer and the sound would disagree.
    const aChanged = !!songPanes.a.song
      || (preMix && (cm.getValue() !== preMix.code || currentSavedName !== preMix.savedName));
    await api('POST', '/api/mix/eject'); // deck B gone, desk reset
    clearPatternRegions('b');
    if (keep === 'restore' && aChanged) {
      // Deck A moved on mid-mix, so the sound and the restored buffer would disagree - clear it
      // and come back stopped. Playing the restored song again is one Cmd+Enter, on purpose.
      await api('POST', '/api/mix/clear', { deck: 'a' });
      clearPatternRegions('a');
      await openInEditor(preMix.code, preMix.savedName, preMix.wipSession);
      logLine('DJ mode off - your pre-mix song is back (re-evaluate to play it)');
    } else {
      logLine('DJ mode off');
    }
    finishDjExit();
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The shared tail of every exit: the split closes, deck B's pane empties, the desk UI re-homes.
function finishDjExit() {
  if (deckBCM) {
    deckBCM.setOption('readOnly', false); // a song's descriptor card locked it
    deckBCM.setValue('');
  }
  songPanes.a.clear();
  songPanes.b.clear();
  deckBFileName = null;
  preMix = null;
  document.getElementById('crossfader').value = -1;
  closeMixMode();
}

function closeMixMode() {
  mixModeOn = false;
  syncPreviewRouting(); // back to the default output - off the desk there is nothing to protect
  mixPushStop();
  document.body.classList.remove('mix-on');
  deckBPaneEl.classList.add('hidden');
  mixStripEl.classList.add('hidden');
  applyMixStack(); // canvases back into their panes, stack region away
  djApplyRegionSizes();
  djSetActiveDeck('a'); // one editor again: the rings come off
  cm.refresh();
}

// Playlist items come in two kinds (songs phase 2): a named save (a bare string) or a disk file
// ({ kind: 'file', path, title?, bpm?, key? } - see pattern-files.js). Everything that walks a
// set goes through these three, so the kinds stay one concept.
const libItemIsFile = (it) => !!it && typeof it === 'object' && it.kind === 'file';
const libItemKey = (it) => (libItemIsFile(it) ? `file:${it.path}` : it);
const libFileTitle = (it) => it.title || it.path.split('/').pop().replace(/\.[^.]+$/, '');

// Which file items' paths still exist on disk, keyed by path - refreshed alongside the views
// that render them, so a moved or deleted file shows as missing (the deleted-save contract).
let songFileExists = {};
async function refreshSongFileStat(lib) {
  const paths = [...new Set(lib.playlists.flatMap((p) => p.items.filter(libItemIsFile).map((it) => it.path)))];
  if (!paths.length) {
    songFileExists = {};
    return;
  }
  try {
    ({ exists: songFileExists } = await api('POST', '/api/songfiles/stat', { paths }));
  } catch { /* advisory - unverified rows render as present and fail loudly on load */ }
}

// The song picker: the ACTIVE playlist (the set, in order, with native bpms) leads, everything
// else files under "all songs". With nothing picked and the pane empty, the set queues itself:
// the song after the one that is playing (or after what deck B last held) is preselected and
// loaded - the "next in the set" default. ⏭ / Cmd+Shift+. steps it (see stepDeckBQueue).
async function refreshDeckFiles() {
  try {
    const [{ patterns }, lib] = await Promise.all([api('GET', '/api/patterns?q='), loadLibraryDoc()]);
    await refreshSongFileStat(lib);
    const byName = new Map(patterns.map((p) => [p.name, p]));
    const say = (p, name) => (p ? `${p.title || p.name}${p.bpm ? ` · ${p.bpm}` : ''}` : `${name} (missing)`);
    const set = lib.playlists.find((p) => p.id === lib.active);
    deckFileItems = new Map((set?.items ?? []).filter(libItemIsFile).map((it) => [libItemKey(it), it]));
    const fill = (sel, filesLoadHere) => {
      const had = sel.value;
      sel.innerHTML = '<option value="">— pick a song —</option>';
      if (set) {
        const g = document.createElement('optgroup');
        g.label = `set: ${set.name}`;
        set.items.forEach((item, i) => {
          let o;
          if (libItemIsFile(item)) {
            const missing = songFileExists[item.path] === false;
            o = new Option(
              `${i + 1}. ♪ ${libFileTitle(item)}${item.bpm ? ` · ${item.bpm}` : ''}${missing ? ' (missing)' : ''}`,
              libItemKey(item),
            );
            if (missing || !filesLoadHere) o.disabled = true;
          } else {
            const p = byName.get(item);
            o = new Option(`${i + 1}. ${say(p, item)}`, item);
            if (!p) o.disabled = true;
          }
          o.dataset.setIndex = i;
          g.appendChild(o);
        });
        sel.appendChild(g);
      }
      const inSet = new Set(set?.items ?? []);
      const rest = patterns.filter((p) => !inSet.has(p.name));
      if (rest.length) {
        const g = set ? document.createElement('optgroup') : null;
        if (g) g.label = 'all songs';
        for (const p of rest) (g ?? sel).appendChild(new Option(say(p, p.name), p.name));
        if (g) sel.appendChild(g);
      }
      if (had) sel.value = had;
    };
    fill(document.getElementById('deckAFile'), true); // both decks hold files now (song pane per deck)
    const selB = document.getElementById('deckBFile');
    fill(selB, true);
    // Deck B only: with nothing picked and the pane empty, the set queues itself - the song
    // after the one that is playing. Deck A is playing the current song; it never auto-loads.
    if (!selB.value && set?.items.length) {
      const next = nextInSet(set);
      if (next) {
        next.selected = true;
        // an empty pane takes the queue's suggestion as a real load; edits are never clobbered
        if (deckBCM && !deckBCM.getValue().trim() && !next.disabled) await loadDeckBFile();
      }
    }
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The set's default queue position: the OPTION after the song deck B holds - or, with the pane
// fresh, after the song the main deck is playing (a set mid-flight resumes from where you are).
// Falls back to the top of the set.
function nextInSet(set) {
  const sel = document.getElementById('deckBFile');
  const opts = [...sel.querySelectorAll('option[data-set-index]')];
  if (!opts.length) return null;
  const anchor = songPanes.b.song ? `file:${songPanes.b.song.path}` : (deckBFileName ?? currentSavedName);
  const at = anchor ? set.items.findIndex((it) => libItemKey(it) === anchor) : -1;
  return opts[(at + 1) % opts.length] ?? opts[0];
}

// ⏭ (and Cmd/Ctrl+Shift+.): step the set - select the next song in the active playlist and
// load it into deck B, wrapping at the end.
async function stepDeckBQueue() {
  if (!mixModeOn) return;
  const sel = document.getElementById('deckBFile');
  const opts = [...sel.querySelectorAll('option[data-set-index]')].filter((o) => !o.disabled);
  if (!opts.length) {
    logLine('no active playlist to step - open organize (≡) and mark a set active', true);
    return;
  }
  const cur = opts.findIndex((o) => o.selected);
  const next = opts[(cur + 1) % opts.length];
  next.selected = true;
  await loadDeckBFile();
}

async function loadDeckBFile(value = document.getElementById('deckBFile').value) {
  if (!value || !deckBCM) return;
  try {
    // Loading a song is a song SWITCH: whatever this deck was playing is cleared engine-side
    // (tracks destroyed, plugins closed) - a set that changes songs all night must not
    // accumulate idle plugins. A no-op when the deck is empty (the auto-queue's case).
    await api('POST', '/api/mix/clear', { deck: 'b' });
    clearPatternRegions('b');
    if (deckFileItems.has(value)) {
      // A disk file: it loads onto the deck's song track (/api/song/*, songs phase 1) and the
      // pane becomes the waveform (phase 3). The read-only card written into the hidden editor
      // is the fallback the pane reveals if the waveform analysis fails.
      const item = deckFileItems.get(value);
      const title = libFileTitle(item);
      const res = await api('POST', '/api/song/load', {
        deck: 'b', path: item.path, bpm: item.bpm, key: item.key, title,
      });
      // bpm/key come back resolved: the playlist item's word if it had one, the file's own
      // tags otherwise (songs phase 4) - and stay editable in the pane's control row.
      deckBFileName = null;
      const m = Math.floor(res.duration / 60);
      const s = String(Math.round(res.duration % 60)).padStart(2, '0');
      deckBCM.setValue(`// ♪ ${title}\n// ${item.path}\n// ${m}:${s}${res.bpm ? ` · ${res.bpm} bpm` : ''}`);
      deckBCM.setOption('readOnly', true);
      songPanes.b.tookLoad(res, item.path, title);
      logLine(`${songLoadLine('b', res, title)} (it arrives silent)`);
    } else {
      const { code } = await api('POST', '/api/patterns/load', { name: value });
      songPanes.b.clear();
      deckBCM.setOption('readOnly', false);
      deckBCM.setValue(code);
      deckBFileName = value;
      logLine(`deck B loaded "${value}" - play it when ready (it arrives silent)`);
    }
    if (mixModeOn) mixRefresh(); // the old song's stems left the strip; a song track arrived
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// Deck A's load (DJ mode): the main editor IS deck A. A saved pattern clears the deck
// engine-side and opens in the main editor - full editor semantics (autosave, history), since
// it is the buffer you may livecode next. A disk FILE loads onto the deck's song track and its
// waveform pane covers the editor; the buffer underneath is left strictly alone (it is your
// autosaved wip, not a descriptor card - unlike deck B's split editor).
async function loadDeckAFile(value = document.getElementById('deckAFile').value) {
  if (!value || !mixModeOn) return;
  try {
    await api('POST', '/api/mix/clear', { deck: 'a' });
    clearPatternRegions('a');
    if (deckFileItems.has(value)) {
      const item = deckFileItems.get(value);
      const title = libFileTitle(item);
      const res = await api('POST', '/api/song/load', {
        deck: 'a', path: item.path, bpm: item.bpm, key: item.key, title,
      });
      songPanes.a.tookLoad(res, item.path, title);
      logLine(songLoadLine('a', res, title));
    } else {
      songPanes.a.clear(); // a pattern takes the deck back from any song it held
      const { code } = await api('POST', '/api/patterns/load', { name: value });
      await openInEditor(code, value);
      logLine(`deck A loaded "${value}" - play it when ready`);
    }
    if (mixModeOn) mixRefresh(); // its old stems left the strip; a song track may have arrived
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The organize window's →A / →B: load a library item (a saved pattern's name or a playlist's
// file item) onto a deck. A file from any playlist is made loadable (deckFileItems only holds
// the active set's), the hidden select is pointed at it so the set's queue keeps its place,
// and the modal closes - the deck head now says the song.
async function loadDeckSong(deck, item) {
  const key = libItemKey(item);
  if (libItemIsFile(item)) deckFileItems.set(key, item);
  document.getElementById(deck === 'a' ? 'deckAFile' : 'deckBFile').value = key;
  closeOrganize();
  await (deck === 'a' ? loadDeckAFile : loadDeckBFile)(key);
}

// The deck heads' song buttons say what each deck holds; the play buttons read play/stop for
// THEIR deck (the server's per-deck truth, pushed on every desk frame - see mixSyncValues).
const deckPlayingNow = { a: false, b: false };
function deckHeadRender(state) {
  for (const d of ['a', 'b']) {
    const U = d.toUpperCase();
    const song = songPanes[d].song;
    const held = song ? `♪ ${song.title}` : (d === 'a' ? currentSavedName : deckBFileName);
    const songBtn = document.getElementById(`deck${U}Song`);
    songBtn.textContent = held || 'pick a song…';
    songBtn.classList.toggle('empty', !held);
    const on = !!state?.playing?.[d];
    deckPlayingNow[d] = on;
    const playBtnD = document.getElementById(`deck${U}Play`);
    playBtnD.innerHTML = on ? '&#9632; stop' : '&#9654; play';
    playBtnD.classList.toggle('is-playing', on);
    playBtnD.title = on ? `stop deck ${U} (Cmd/Ctrl+. in this pane)` : 'Cmd/Ctrl+Enter in this pane';
  }
}

// --- the song decks' waveform panes (songs phase 3; one per deck since deck A learned files) ---
//
// When a deck holds a disk FILE the editor slot shows a DJ waveform instead of CodeMirror: a
// zoomed strip whose playhead sits fixed at centre with the track scrolling under it (drag to
// scrub, wheel to zoom), over a full-track overview (click or drag to jump). Both draw from ONE
// server analysis (GET /api/song/waveform - the recorder's envelope pass generalized: per-bucket
// peak + rms coloured by low/mid/high energy balance, run on the analysis worker). The playhead
// is mirrored locally - posSec + (now - startSec) * rate, engine time being Date.now()/1000 on
// the same machine - so the animation costs no polling; the desk's SSE frames keep the mirror
// honest. Scrubbing a faded-out deck is still audible on the headphone cue (the cue tap sits
// before fader x deck in the track def) - that IS the audition path, no extra plumbing.
//
// One pane per deck, built by makeSongPane: deck B's covers its split editor (whose hidden
// buffer holds the descriptor card the pane falls back to), deck A's covers the MAIN editor
// and leaves its buffer strictly alone - that buffer is your autosaved wip, not a card.

function songFmt(sec, tenths = false) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return tenths ? `${m}:${(s < 10 ? '0' : '') + s.toFixed(1)}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** Backing-store size synced to CSS size x devicePixelRatio; true when it just changed. */
function songSizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

function songThemeColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    accent: css.getPropertyValue('--accent').trim() || '#6cf',
    dim: css.getPropertyValue('--border').trim() || '#444',
    text: css.getPropertyValue('--text-dim').trim() || '#888',
    bg: css.getPropertyValue('--bg-panel').trim() || '#111',
    warn: css.getPropertyValue('--warn').trim() || '#d29922',
  };
}

// The waveform is drawn NORMALIZED, like the recorder's finished takes: a quietly-mastered file
// still fills the pane, and the desk's meters are what say how loud it actually is.
function songNormOf(env) {
  const peak = env.peaks.reduce((mx, v) => Math.max(mx, v ?? 0), 0);
  return peak < 0.0005 ? 1 : Math.min(6, 1 / peak);
}

// One column per visible bucket, mirrored around the centre line: translucent peak envelope
// with the solid rms body inside it, coloured by band balance - drawRecordScope's read, reused.
function songDrawColumns(ctx, env, i0, i1, xAt, colW, mid, maxAmp, norm) {
  for (let i = i0; i <= i1; i++) {
    const [r, g, b] = bandColor(env.bands[i]);
    const peakAmp = Math.min(1, (env.peaks[i] ?? 0) * norm) * maxAmp;
    const rmsAmp = Math.min(peakAmp, Math.min(1, (env.rms[i] ?? 0) * norm) * maxAmp);
    const x = xAt(i);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.32)`;
    ctx.fillRect(x, mid - peakAmp, colW, peakAmp * 2 || 1);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
    ctx.fillRect(x, mid - rmsAmp, colW, rmsAmp * 2 || 1);
  }
}

function makeSongPane(deck) {
  const U = deck.toUpperCase();
  const byId = (name) => document.getElementById(name + U);
  const paneEl = byId('songPane');
  const detailEl = byId('songDetail');
  const overviewEl = byId('songOverview');
  const titleEl = byId('songTitle');
  const timeEl = byId('songTime');
  const rateEl = byId('songRate');
  const bpmEl = byId('songBpm');
  const syncEl = byId('songSync');
  const multEl = byId('songMult');
  const keylockEl = byId('songKeylock');
  const cueEl = byId('songCue');
  const nudgeDnEl = byId('songNudgeDn');
  const nudgeUpEl = byId('songNudgeUp');
  const hostEl = deck === 'a' ? document.getElementById('editorPane') : deckBPaneEl;
  const keepBtn = document.getElementById(deck === 'a' ? 'deckAKeep' : 'deckBKeep');
  const updBtn = document.getElementById(deck === 'a' ? 'deckAUpdate' : 'deckBUpdate');
  const hostCM = () => (deck === 'a' ? cm : deckBCM);
  const D = `deck ${U}`;

  const P = {
    deck,
    song: null, // the disk FILE this deck holds ({ path, title, bpm }) - songs phase 2
    mirror: null, // the playhead mirror { playing, posSec, startSec, rate, duration, ...facts }
    active: false, // the "window" the transport hotkeys target - claimed by pointer, see below
  };

  let wave = null; // the fetched analysis (null while loading, or when it failed)
  let waveFailed = false; // deck A keeps the pane up on failure - it has no card to fall back to
  let zoomSec = 12; // seconds across the detail strip (wheel adjusts)
  let scrubUntil = 0; // while a hand scrubs, SSE echoes of older seeks must not fight it
  let raf = null;
  let overviewImage = null; // the full track pre-rendered once; per-frame work is a blit + overlays
  let detectSaid = null; // path whose phase 5 estimate was already announced - it logs once
  let onsets = []; // transient times (seconds, ascending) - the scrub magnet's targets
  const SONG_MAGNET_PX = 8; // how close (on screen) a drag has to come to a hit to be pulled onto it

  /** Fetch the deck's transients (after the analysis lands; empty until then). */
  P.loadOnsets = async () => {
    const forPath = P.song?.path;
    if (!forPath) return;
    try {
      const r = await api('GET', `/api/song/onsets?deck=${deck}`);
      if (P.song?.path === forPath) onsets = r.onsets ?? [];
    } catch { /* the magnet is a nicety - scrubbing works without it */ }
  };
  /** Nearest transient to `pos` when one lies within `windowSec`, else `pos` itself. */
  function magnetize(pos, windowSec) {
    if (!onsets.length) return pos;
    let lo = 0;
    let hi = onsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid] < pos) lo = mid + 1; else hi = mid;
    }
    let best = onsets[lo];
    if (lo > 0 && Math.abs(onsets[lo - 1] - pos) < Math.abs(best - pos)) best = onsets[lo - 1];
    return Math.abs(best - pos) <= windowSec ? best : pos;
  }

  /** Where this deck's playhead is right now, in song seconds. */
  P.playheadNow = () => {
    const s = P.mirror;
    if (!s) return 0;
    const dur = s.duration ?? wave?.seconds ?? 0;
    const at = s.playing ? s.posSec + Math.max(0, Date.now() / 1000 - s.startSec) * (s.rate || 1) : s.posSec;
    return Math.min(Math.max(0, at), dur);
  };

  /** Zoom the detail strip by a factor (>1 = closer) - cmd ± while this pane is active. */
  P.zoomBy = (factor) => P.setZoom(zoomSec / factor);
  /**
   * Set the strip's span outright. Stacked decks share one zoom - two waveforms at different
   * scales one above the other say nothing about each other - so any zoom on either pane
   * lands on both while the layout is stacked.
   */
  P.setZoom = (sec, { propagate = true } = {}) => {
    zoomSec = Math.min(60, Math.max(0.25, sec)); // down to a quarter second: single hits
    if (propagate && typeof mixStacked !== 'undefined' && mixStacked) {
      songPanes[deck === 'a' ? 'b' : 'a'].setZoom(zoomSec, { propagate: false });
    }
  };
  P.zoomSec = () => zoomSec;
  /** The deck's playing rate (the sync/nudge rate even while paused - what a start would use). */
  P.rateNow = () => (P.mirror && Number.isFinite(P.mirror.rate) && P.mirror.rate > 0 ? P.mirror.rate : 1);

  // The desk state's song half for this deck, run on every SSE frame and every mixRefresh.
  // Keeps the mirror current, and adopts a song this page never loaded (a reload mid-set: the
  // server still holds the deck) so reopening DJ mode comes back intact.
  P.sync = (sb) => {
    if (!sb) {
      P.mirror = null;
      return;
    }
    const scrubbing = performance.now() < scrubUntil;
    if (P.mirror && scrubbing) {
      // the hand owns the position; take everything else
      P.mirror.playing = sb.playing;
      P.mirror.rate = sb.rate;
      P.mirror.duration = sb.duration;
    } else {
      P.mirror = { playing: sb.playing, posSec: sb.posSec, startSec: sb.startSec, rate: sb.rate, duration: sb.duration };
    }
    // The musical facts (songs phase 4) ride every frame - server truth, however they got there
    // (tags, playlist item, a meta edit, a MIDI nudge, a phase 5 estimate).
    Object.assign(P.mirror, {
      bpm: sb.bpm ?? null,
      musicalKey: sb.musicalKey ?? null,
      anchorSec: sb.anchorSec ?? 0,
      cueSec: sb.cueSec ?? 0,
      sync: !!sb.sync,
      keylock: !!sb.keylock,
      nudge: sb.nudge ?? 0,
      bpmDetected: sb.bpmDetected ?? null,
      keyDetected: sb.keyDetected ?? null,
      gridDetected: sb.gridDetected ?? null,
      // The tempo-ratio state the ×-button renders and cycles from (left out of this list
      // once, which had the button reading 1× over a deck the server had at ½× - and every
      // click "cycling" from auto to ½× again).
      syncMult: sb.syncMult ?? 'auto',
      syncMultEffective: sb.syncMultEffective ?? 1,
      master: !!sb.master,
    });
    // A phase 5 estimate landing (bpm/key read from the audio because the tags said nothing)
    // gets one console line; the facts themselves just appear in the control row, marked.
    if ((sb.bpmDetected != null || sb.keyDetected != null || sb.gridDetected != null) && detectSaid !== sb.path) {
      detectSaid = sb.path;
      const bits = [
        sb.bpmDetected != null && `${sb.bpm} bpm (~${Math.round(sb.bpmDetected * 100)}%)`,
        sb.gridDetected != null && `beatgrid at ${songFmt(sb.anchorSec ?? 0, true)} (~${Math.round(sb.gridDetected * 100)}%)`,
        sb.keyDetected != null && `${sb.musicalKey} (~${Math.round(sb.keyDetected * 100)}%)`,
      ].filter(Boolean).join(' · ');
      logLine(`${D} ♪ analyzed: ${bits} - estimates; typing a bpm or cueing on a downbeat overrides`);
      P.loadOnsets(); // the transients came with the analysis - the scrub magnet is live from here
    }
    ctlRender();
    if (!P.song) {
      P.song = { path: sb.path, title: sb.title, bpm: sb.bpm ?? null };
      if (deck === 'b') {
        deckBFileName = null;
        if (deckBCM) {
          deckBCM.setValue(`// ♪ ${sb.title}\n// ${sb.path}`);
          deckBCM.setOption('readOnly', true);
        }
      }
      P.open();
    }
  };

  /** A fresh /api/song/load response becomes this pane's song. */
  P.tookLoad = (res, filePath, title) => {
    P.song = { path: filePath, title, bpm: res.bpm ?? null };
    onsets = []; // the old song's hits must not pull on the new one
    P.mirror = { playing: false, posSec: 0, startSec: 0, rate: 1, duration: res.duration, cueSec: 0 };
    detectSaid = null;
    P.open();
  };

  // Show the pane and fetch its waveform. Deck B's descriptor card stays in the (hidden)
  // editor underneath - it is what shows again if the analysis fails; deck A has no card (its
  // editor holds your wip), so a failure there keeps the pane up and says so on the strip.
  P.open = async () => {
    hostEl.classList.add('song-on');
    keepBtn.disabled = true; // a file can't be promoted to the single editor (see exitDjMode)
    updBtn.disabled = true; // a file has nothing to re-evaluate
    paneEl.classList.remove('hidden');
    detailEl.classList.remove('hidden');
    ctlRender(); // title, toggles, bpm - whatever the mirror already knows
    timeEl.textContent = '';
    wave = null;
    waveFailed = false;
    overviewImage = null;
    rafStart();
    const forPath = P.song.path;
    try {
      const w = await api('GET', `/api/song/waveform?deck=${deck}`);
      if (P.song?.path !== forPath) return; // a later load took the deck while this ran
      wave = w;
      overviewImage = null;
      P.loadOnsets(); // usually not ready yet - the analysis line re-asks when it lands
    } catch (e) {
      if (P.song?.path !== forPath) return;
      logLine(`${D} waveform: ${e.message ?? String(e)}`, true);
      if (deck === 'b') P.close(); // back to the descriptor card - playback is unaffected
      else waveFailed = true; // scrub and controls all still work; the strip says what happened
    }
  };

  P.close = () => {
    P.cueUp(); // a pane going away under a held cue would otherwise leave the deck previewing
    hostEl.classList.remove('song-on');
    keepBtn.disabled = false;
    updBtn.disabled = false;
    paneEl.classList.add('hidden');
    detailEl.classList.add('hidden'); // in the stack it would otherwise sit there blank
    wave = null;
    overviewImage = null;
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    P.setActive(false);
    hostCM()?.refresh(); // it was display:none while the pane was up; unpainted until told
  };

  /** The DJ-exit case: close hides the pane; this also forgets the song it held. */
  P.clear = () => {
    P.close();
    P.song = null;
    P.mirror = null;
  };

  function rafStart() {
    if (raf == null) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = null;
    if (!mixModeOn || paneEl.classList.contains('hidden')) return;
    drawDetail();
    drawOverview();
    const dur = wave?.seconds ?? P.mirror?.duration ?? 0;
    timeEl.textContent = dur ? `${songFmt(P.playheadNow(), true)} / ${songFmt(dur)}` : '';
    const rate = P.mirror?.rate ?? 1;
    rateEl.textContent = Math.abs(rate - 1) > 0.0005 ? `${rate > 1 ? '+' : ''}${((rate - 1) * 100).toFixed(1)}%` : '';
    raf = requestAnimationFrame(frame);
  }

  function drawDetail() {
    songSizeCanvas(detailEl);
    const dpr = window.devicePixelRatio || 1;
    const ctx = detailEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = detailEl.clientWidth;
    const h = detailEl.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const { accent, dim, text, warn } = songThemeColors();
    const mid = h / 2;
    const maxAmp = mid - 6;
    const pos = P.playheadNow();
    // The strip is `zoomSec` of PLAYBACK time across, not song time: a deck synced down to
    // 0.82 shows 0.82 song-seconds per real second, so its beats sit exactly as far apart on
    // screen as the other deck's and scroll at the same speed - which is what lets two stacked
    // waveforms be read against each other at all (and, paused, what a sync will produce).
    const span = zoomSec * P.rateNow();
    const pxPerSec = w / span; // per SONG second
    const t0 = pos - span / 2; // the playhead is pinned at centre; time scrolls under it
    const dur = wave?.seconds ?? P.mirror?.duration ?? 0;

    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();

    // Beatgrid from the song's own facts (songs phase 4): bpm out of its tags/playlist/edits,
    // downbeats every 4th beat from the user-settable anchor (the ⚓ button drops it at the
    // playhead). The k = 0 line IS the anchor - drawn a little stronger.
    // Only the song's OWN bpm draws a grid. The desk's native slot (mixNativeBpm) defaults to
    // 120 for a track that specifies nothing - fine for the tempo slider, wrong as a beatgrid.
    const bpm = P.mirror ? P.mirror.bpm : P.song?.bpm;
    const anchor = P.mirror?.anchorSec ?? 0;
    if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 && dur) {
      const beat = 60 / bpm;
      const kEnd = (Math.min(dur, t0 + span) - anchor) / beat;
      ctx.lineWidth = 1;
      for (let k = Math.ceil((Math.max(0, t0) - anchor) / beat); k <= kEnd; k++) {
        if (anchor + k * beat < 0) continue;
        const x = Math.round((anchor + k * beat - t0) * pxPerSec) + 0.5;
        const down = ((k % 4) + 4) % 4 === 0;
        ctx.strokeStyle = down ? rgbaFrom(ctx, accent, k === 0 ? 0.75 : 0.4) : rgbaFrom(ctx, text, 0.35);
        ctx.beginPath();
        if (down) {
          ctx.moveTo(x, 2);
          ctx.lineTo(x, h - 2);
        } else {
          ctx.moveTo(x, 2);
          ctx.lineTo(x, 8);
          ctx.moveTo(x, h - 8);
          ctx.lineTo(x, h - 2);
        }
        ctx.stroke();
      }
    }

    if (wave) {
      const det = wave.detail;
      wave._norm ??= songNormOf(det);
      const per = det.perSec;
      const i0 = Math.max(0, Math.floor(t0 * per));
      const i1 = Math.min(det.peaks.length - 1, Math.ceil((t0 + span) * per));
      const colW = Math.max(1, pxPerSec / per) + 0.6;
      songDrawColumns(ctx, det, i0, i1, (i) => (i / per - t0) * pxPerSec, colW, mid, maxAmp, wave._norm);
    } else {
      ctx.fillStyle = text;
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(waveFailed ? 'no waveform - scrubbing and controls still work' : 'analyzing…', w / 2, mid);
    }

    // Hard edges where the file begins and ends, so blank space beyond isn't read as quiet audio.
    if (dur) {
      ctx.strokeStyle = rgbaFrom(ctx, text, 0.7);
      ctx.lineWidth = 1;
      for (const tEdge of [0, dur]) {
        if (tEdge < t0 || tEdge > t0 + span) continue;
        const x = Math.round((tEdge - t0) * pxPerSec) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // The cue point: a marked line the playhead scrolls past, so where the CUE button will land
    // is visible before it is pressed. Warn-coloured rather than accent - it must not read as
    // another playhead - with a flag at the top the way a hardware waveform display marks it.
    const cue = P.mirror?.cueSec ?? 0;
    if (dur && cue >= t0 && cue <= t0 + span) {
      const x = Math.round((cue - t0) * pxPerSec) + 0.5;
      ctx.strokeStyle = warn;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = warn;
      ctx.fillRect(x, 0, 6, 5);
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
  }

  function drawOverview() {
    if (songSizeCanvas(overviewEl)) overviewImage = null; // pre-render matches the pixel size
    const dpr = window.devicePixelRatio || 1;
    const ctx = overviewEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = overviewEl.clientWidth;
    const h = overviewEl.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const { accent, dim, bg, warn } = songThemeColors();
    if (!wave) {
      ctx.strokeStyle = dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2 + 0.5);
      ctx.lineTo(w, h / 2 + 0.5);
      ctx.stroke();
      return;
    }
    if (!overviewImage) {
      const img = document.createElement('canvas');
      img.width = Math.max(1, Math.round(w * dpr));
      img.height = Math.max(1, Math.round(h * dpr));
      const ictx = img.getContext('2d');
      ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ov = wave.overview;
      const n = ov.peaks.length;
      songDrawColumns(ictx, ov, 0, n - 1, (i) => (i / n) * w, w / n + 0.6, h / 2, h / 2 - 3, songNormOf(ov));
      overviewImage = img;
    }
    ctx.drawImage(overviewImage, 0, 0, w, h);
    const dur = wave.seconds || 1;
    const px = (P.playheadNow() / dur) * w;
    ctx.fillStyle = rgbaFrom(ctx, bg, 0.55); // what's already played sits dimmed behind the playhead
    ctx.fillRect(0, 0, px, h);
    const cue = P.mirror?.cueSec ?? 0;
    if (cue > 0) { // the top needs no marker - that is where an untouched cue already is
      const cx = Math.round((cue / dur) * w) + 0.5;
      ctx.strokeStyle = warn;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  // --- scrubbing (-> /api/song/seek, one POST per ~50ms however fast the hand moves) ---

  let seekTimer = null;
  let seekPos = null;
  function seek(pos) {
    const dur = wave?.seconds ?? P.mirror?.duration ?? 0;
    pos = Math.min(Math.max(0, pos), dur);
    if (P.mirror) {
      // the mirror follows the hand immediately; the server echo confirms rather than leads
      P.mirror.posSec = pos;
      P.mirror.startSec = Date.now() / 1000;
    }
    scrubUntil = performance.now() + 400;
    seekPos = pos;
    if (seekTimer) return;
    seekTimer = setTimeout(() => {
      seekTimer = null;
      api('POST', '/api/song/seek', { deck, pos: seekPos })
        .catch((e) => logLine(`${D} seek: ${e.message ?? String(e)}`, true));
    }, 50);
  }

  // The detail strip drags like the record: pull the waveform right and the playhead moves back.
  let drag = null;
  detailEl.addEventListener('pointerdown', (e) => {
    if (!P.song) return;
    detailEl.setPointerCapture(e.pointerId);
    detailEl.classList.add('dragging');
    drag = { x: e.clientX, pos: P.playheadNow() };
  });
  detailEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pxPerSec = detailEl.clientWidth / (zoomSec * P.rateNow()); // per song second, as drawn
    // The magnet: within a few screen pixels of a transient the playhead lands ON it (so a
    // cue placed by feel sits on the hit), further away it goes exactly where the hand is.
    // Zooming in shrinks the window in seconds - fine placement between hits is a zoom away.
    seek(magnetize(drag.pos - (e.clientX - drag.x) / pxPerSec, SONG_MAGNET_PX / pxPerSec));
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    detailEl.addEventListener(ev, () => {
      drag = null;
      detailEl.classList.remove('dragging');
    });
  }
  detailEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    P.setZoom(zoomSec * Math.exp(e.deltaY * 0.0015));
  }, { passive: false });

  // The overview jumps: click (or drag along it) seeks to that point of the track.
  let overviewDown = false;
  function overviewSeek(e) {
    const r = overviewEl.getBoundingClientRect();
    const dur = wave?.seconds ?? P.mirror?.duration ?? 0;
    if (r.width && dur) seek(((e.clientX - r.left) / r.width) * dur);
  }
  overviewEl.addEventListener('pointerdown', (e) => {
    if (!P.song) return;
    overviewEl.setPointerCapture(e.pointerId);
    overviewDown = true;
    overviewSeek(e);
  });
  overviewEl.addEventListener('pointermove', (e) => {
    if (overviewDown) overviewSeek(e);
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    overviewEl.addEventListener(ev, () => { overviewDown = false; });
  }

  // --- the control row (songs phase 4) and the active-"window" claim ---
  //
  // The song's musical facts are server truth (tags at load, playlist item, edits here, phase 5
  // estimates) and ride every SSE frame; this row just renders them and posts edits back. bpm
  // feeds the desk's tempo migration; ⚓ drops the beatgrid anchor at the playhead; sync
  // rate-locks to the master clock; keylock swaps the player for the pitch-shifting one; the
  // nudge pair is the platter (±4% while held) and the jog pair steps a beat. All four platter
  // buttons are MIDI-learnable, same gesture as the desk knobs.
  //
  // Whether this pane's DECK is the active one - the claim itself is made a deck at a time, by
  // clicking anywhere in either deck's pane (see djSetActiveDeck); this is how the song pane
  // wears it. The detail canvas gets it too because in the stacked layout it lives up in
  // #songStack, away from its pane.
  P.setActive = (on) => {
    if (P.active === on) return;
    P.active = on;
    paneEl.classList.toggle('active', on);
    detailEl.classList.toggle('active', on);
  };
  // The stacked canvas is outside both deck panes, so it claims its deck itself.
  detailEl.addEventListener('pointerdown', () => djSetActiveDeck(deck), true);
  // For the stacked layout (applyMixStack): the canvas and where it goes back to.
  P.detailEl = detailEl;
  P.reattachDetail = () => overviewEl.before(detailEl);

  function ctlRender() {
    const m = P.mirror;
    const est = m?.keyDetected != null ? '~' : '';
    titleEl.textContent = P.song ? `♪ ${P.song.title}${m?.musicalKey ? ` · ${m.musicalKey}${est}` : ''}` : '';
    titleEl.title = m?.keyDetected != null
      ? `key estimated from the audio (~${Math.round(m.keyDetected * 100)}% sure)` : '';
    syncEl.classList.toggle('on', !!m?.sync);
    // The tempo ratio the sync is riding - the song's tempo over the clock's: 1× beat-matched,
    // ½× half-time, 2× double-time. Dim when chosen automatically (nearest to native speed),
    // lit when pinned; greyed on the master, whose tempo IS the clock.
    const mult = m?.syncMult ?? 'auto';
    const eff = m?.master ? 1 : (m?.syncMultEffective ?? 1);
    const show = (v) => (v === 0.5 ? '½×' : `${v}×`);
    multEl.textContent = show(eff);
    multEl.classList.toggle('on', mult !== 'auto' && !m?.master);
    multEl.disabled = !!m?.master;
    multEl.title = m?.master
      ? 'this deck set the clock - it plays at its own tempo; the ratio is the other deck\'s to choose'
      : `tempo ratio to the clock: 1× beat-matched, ½× half-time, 2× double-time. ${mult === 'auto' ? 'chosen automatically (nearest native speed)' : `pinned to ${show(mult)}`}; click to cycle ½× → 1× → 2× → auto`;
    keylockEl.classList.toggle('on', !!m?.keylock);
    nudgeDnEl.classList.toggle('held', (m?.nudge ?? 0) < 0); // a MIDI nudge lights the button too
    nudgeUpEl.classList.toggle('held', (m?.nudge ?? 0) > 0);
    if (document.activeElement !== bpmEl) bpmEl.value = m?.bpm ?? '';
    bpmEl.classList.toggle('detected', m?.bpmDetected != null);
    bpmEl.title = m?.bpmDetected != null
      ? `estimated from the audio (~${Math.round(m.bpmDetected * 100)}% sure) - type to correct it` : '';
  }

  function metaPost(patch, said) {
    api('POST', '/api/song/meta', { deck, ...patch })
      .then((res) => { if (said) logLine(said(res)); })
      .catch((e) => logLine(e.message ?? String(e), true));
  }

  bpmEl.addEventListener('change', () => {
    if (!P.song) return;
    const v = bpmEl.value.trim();
    metaPost({ bpm: v === '' ? null : Number(v) });
    bpmEl.blur();
  });
  byId('songAnchor').addEventListener('click', () => {
    if (!P.song) return;
    const at = P.playheadNow();
    metaPost({ anchorSec: at }, (r) => `beatgrid anchored at ${songFmt(r.anchorSec, true)}`
      + (Math.abs(r.anchorSec - at) > 0.002 ? ' (snapped to the transient)' : ''));
  });
  syncEl.addEventListener('click', () => {
    if (!P.song) return;
    metaPost({ sync: !P.mirror?.sync }, (r) => (r.sync
      ? `sync on - ${D} rides the master clock (rate ${r.rate.toFixed(3)})`
      : `sync off - ${D} back to its own rate`));
  });
  multEl.addEventListener('click', () => {
    if (!P.song) return;
    if (P.mirror?.master) return;
    const order = ['auto', 0.5, 1, 2];
    const cur = P.mirror?.syncMult ?? 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const name = next === 'auto' ? 'auto' : { 0.5: '½× (half-time)', 1: '1× (beat-matched)', 2: '2× (double-time)' }[next];
    metaPost({ syncMult: next }, (r) => `${D} tempo ratio ${name} - rate ${r.rate.toFixed(3)}`);
  });
  keylockEl.addEventListener('click', () => {
    if (!P.song) return;
    metaPost({ keylock: !P.mirror?.keylock }, (r) => `keylock ${r.keylock ? 'on - rate stretches time, not pitch' : 'off - back to repitch'}`);
  });

  // --- the CUE gesture (the button here and Ctrl+C are the same press) ---
  //
  // Hold: preview from the cue point. Release: back onto it, paused. A press while the deck is
  // PAUSED moves the cue point to the playhead first - park it and press, and that is home.
  // The server owns all of that (see songCue there); this side owns the edges and the light.
  //
  // `held` is local truth, not read back off the mirror: the press's SSE echo may not have
  // landed by the time the finger comes up, and a release that doesn't fire strands the deck
  // playing. Every path out of a press goes through cueUp.
  let cueHeld = false;
  P.cueDown = () => {
    if (!P.song || cueHeld) return;
    cueHeld = true;
    cueEl.classList.add('held');
    // The paused playhead as THIS pane shows it rides along: the cue must land where the eye
    // put it, not where a seek that never arrived left the server's model.
    const pos = P.mirror && !P.mirror.playing ? P.playheadNow() : undefined;
    api('POST', '/api/song/cue', { deck, hold: true, pos }).catch((e) => {
      cueHeld = false;
      cueEl.classList.remove('held');
      logLine(`${D} cue: ${e.message ?? String(e)}`, true);
    });
  };
  P.cueUp = () => {
    if (!cueHeld) return;
    cueHeld = false;
    cueEl.classList.remove('held');
    api('POST', '/api/song/cue', { deck, hold: false })
      .catch((e) => logLine(`${D} cue: ${e.message ?? String(e)}`, true));
  };
  cueEl.addEventListener('pointerdown', (e) => {
    if (!P.song) return;
    cueEl.setPointerCapture(e.pointerId); // the release counts wherever the finger ends up
    P.cueDown();
  });
  for (const ev of ['pointerup', 'pointercancel']) cueEl.addEventListener(ev, () => P.cueUp());

  // The platter: hold to push/drag (release restores), click a jog to step one beat.
  function holdWire(btn, dir) {
    let holding = false; // local truth - the SSE echo of the press may not be back by release
    const send = (hold) => api('POST', '/api/song/nudge', { deck, hold })
      .catch((e) => logLine(e.message ?? String(e), true));
    btn.addEventListener('pointerdown', (e) => {
      if (!P.song) return;
      btn.setPointerCapture(e.pointerId);
      holding = true;
      send(dir);
    });
    for (const ev of ['pointerup', 'pointercancel']) {
      btn.addEventListener(ev, () => {
        if (!holding) return;
        holding = false;
        if (P.song) send(0);
      });
    }
  }
  holdWire(nudgeDnEl, -1);
  holdWire(nudgeUpEl, 1);
  for (const [name, jog] of [['songJogDn', -1], ['songJogUp', 1]]) {
    byId(name).addEventListener('click', () => {
      if (!P.song) return;
      api('POST', '/api/song/nudge', { deck, jog }).catch((e) => logLine(e.message ?? String(e), true));
    });
  }
  mixLearnAttach(nudgeDnEl, `${deck}:nudgedn`);
  mixLearnAttach(nudgeUpEl, `${deck}:nudgeup`);
  mixLearnAttach(byId('songJogDn'), `${deck}:jogdn`);
  mixLearnAttach(byId('songJogUp'), `${deck}:jogup`);

  return P;
}

const songPanes = { a: makeSongPane('a'), b: makeSongPane('b') };

// --- the livecoded decks' strip: what a deck playing CODE shows in the waveform stack ---------
//
// A song deck's waveform is analysed from a file. A pattern deck has no file, so this draws the
// two things a running pattern does have: the deck's LEVEL, and the BAR LINES.
//
// The level is the ~20/sec pre-fader meter the channel meters already stream (server.js's
// deckLevelNotify), kept as a short timestamped history rather than only its latest value - so
// the past's amplitude costs no engine work, no request and no analysis. It is the loose part
// though: a reading reaches here some tens of ms after the sound it measures, so it is slid back
// by DJ_LIVE_TRACE_LAG, which is an estimate and the only guessed number on the strip.
//
// The bar lines are exact, straight off the clock, and they are what this is really for: the same
// downbeats and beats a song deck draws from its own detected tempo, so a pattern stacked over a
// song can be lined up by eye. Deliberately NOT drawn from the pattern's events - the grid is
// already in the browser (patternRegions[].gates, the editor's highlighting) and an early version
// drew every stem's onsets from it, but a screenful of ticks says less about where the bar is
// than the bar line does, and the code itself is right there underneath saying what plays.
//
// Stacked layout only. A pattern deck's editor IS the instrument, and covering it with a waveform
// - which is what a song deck does to its own editor - would take the instrument away.

const DJ_LIVE_TRACE_LAG = 90; // ms: the meter's analysis window plus the SSE coalesce (see above)
const DJ_LIVE_TRACE_MAX = 2000; // ~80s of history at the feed's ~25/sec - past the widest zoom
const djLiveTrace = { a: [], b: [] }; // [{ t: performance.now() as it landed, p, r }]

/** Every level frame kept with the moment it arrived, rather than only the latest. */
function djLiveTracePush(frame) {
  const t = performance.now();
  for (const deck of ['a', 'b']) {
    const v = frame?.[deck];
    if (!v) continue;
    const ring = djLiveTrace[deck];
    ring.push({ t, p: v.p ?? 0, r: v.r ?? 0 });
    if (ring.length > DJ_LIVE_TRACE_MAX) ring.splice(0, ring.length - DJ_LIVE_TRACE_MAX);
  }
}

// Built here rather than in the markup: they only ever live in the stack, which applyMixStack
// fills. `.song-detail` for the stack's own sizing rules (flex basis 0, the hidden state); the
// livecoded strip has nothing to scrub, so .dj-live-wave drops that class's grab cursor.
const djLiveWaveEls = {};
for (const deck of ['a', 'b']) {
  const canvas = document.createElement('canvas');
  canvas.className = 'song-detail dj-live-wave hidden';
  canvas.id = `djLiveWave${deck.toUpperCase()}`;
  canvas.title = `deck ${deck.toUpperCase()}: the deck's level as it played, under the clock's `
    + 'bars and beats. Wheel to zoom (both strips share one scale, which is what lets them be '
    + 'read against each other)';
  // The song strips' wheel zoom, on the same control: the scale is shared, so zooming here moves
  // the song deck above it too (setZoom propagates while stacked).
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    songPanes[deck].setZoom(songPanes[deck].zoomSec() * Math.exp(e.deltaY * 0.0015));
  }, { passive: false });
  djLiveWaveEls[deck] = canvas;
}

/**
 * The strip's window, in cycles, and where any cycle position falls across `w` pixels of it.
 * Pure geometry, and the one invariant that matters is that xOf(cycNow) is the exact centre: the
 * playhead is pinned there on the song strips too, and that shared pin is what lets a livecoded
 * deck and a song deck stacked one above the other be read against each other at all.
 */
function djLiveWindow(cycNow, cps, spanSec, w) {
  const spanCyc = spanSec * cps;
  const cyc0 = cycNow - spanCyc / 2;
  return { cyc0, cyc1: cycNow + spanCyc / 2, xOf: (cyc) => ((cyc - cyc0) / spanCyc) * w };
}

/**
 * The cycle a meter frame belongs on. `t` is when the frame ARRIVED; the sound it measured
 * happened DJ_LIVE_TRACE_LAG earlier than that, so the trace is slid further back into the past,
 * never forward. Getting this sign wrong is the failure that looks like a working strip whose
 * beats sit twice the lag off the grid.
 */
function djLiveTraceCycle(t, nowMs, cycNow, cps) {
  return cycNow - ((nowMs - t + DJ_LIVE_TRACE_LAG) / 1000) * cps;
}

/** A deck draws this strip when it is playing CODE - a deck holding a file has its own waveform. */
function djLiveWaveOn(deck) {
  return mixModeOn && mixStacked && !songPanes[deck].song
    && patternRegions.some((r) => r.deck === deck);
}

function djLiveWaveDraw(deck) {
  const canvas = djLiveWaveEls[deck];
  songSizeCanvas(canvas);
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const { accent, dim, text } = songThemeColors();
  const mid = h / 2;
  const maxAmp = mid - 6;

  // One scale with the song decks, and the playhead pinned at centre exactly as theirs is: the
  // stack exists so the strips can be read against each other, which needs both to be true.
  const cps = transport.cps || 0.5;
  const cycNow = currentCyclePos();
  const { cyc0, cyc1, xOf } = djLiveWindow(cycNow, cps, songPanes[deck].zoomSec(), w);

  ctx.strokeStyle = dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  // Every line here is SCROLLING, and none of them are snapped to whole pixels. Rounding an x to
  // get a crisp 1px line quantizes a smooth slide into 1px jumps - and since the lines are not an
  // integer number of pixels apart, each one jumps at a different moment, which is read as the
  // whole grid shimmering rather than moving. Fractional fills antialias their edges and slide.
  const vline = (x, y0, y1) => ctx.fillRect(x - 0.5, y0, 1, y1 - y0);

  // The bar/beat grid, straight off the clock - a cycle IS a bar here (bpm is cps x 240, so four
  // beats to the cycle). Same marks as a song deck's own beatgrid: downbeats full height, beats
  // as ticks off the top and bottom, so a strip drawn from the clock and one drawn from a file's
  // detected tempo can be lined up by eye.
  for (let c = Math.floor(cyc0); c <= cyc1; c++) {
    for (let b = 0; b < 4; b++) {
      const x = xOf(c + b / 4);
      if (x < -1 || x > w + 1) continue;
      ctx.fillStyle = b === 0 ? rgbaFrom(ctx, accent, 0.4) : rgbaFrom(ctx, text, 0.35);
      if (b === 0) vline(x, 2, h - 2);
      else {
        vline(x, 2, 8);
        vline(x, h - 8, h - 2);
      }
    }
  }

  // The level trace, mirrored around the centre like a song's waveform: translucent peak with the
  // solid rms body inside it, one column per meter frame. Columns are placed by the timestamp
  // each frame arrived under, not by their position in the ring, so a stalled feed leaves a gap
  // rather than quietly sliding the whole history off the beat. Normalized to the loudest thing
  // still on screen, with a floor so a silent deck doesn't magnify its own noise into a waveform.
  const ring = djLiveTrace[deck];
  const nowMs = performance.now();
  const cycOfT = (t) => djLiveTraceCycle(t, nowMs, cycNow, cps);
  let loudest = 0;
  for (const s of ring) if (s.p > loudest) loudest = s.p;
  const norm = loudest < 0.02 ? 1 : Math.min(6, 1 / loudest);
  const cols = [];
  for (let i = 0; i < ring.length; i++) {
    const x = xOf(cycOfT(ring[i].t));
    if (x < -8 || x > w + 8) continue;
    const to = xOf(cycOfT(i + 1 < ring.length ? ring[i + 1].t : nowMs));
    cols.push({ x, cw: Math.max(1, to - x) + 0.6, s: ring[i] });
  }
  for (const [alpha, key] of [[0.28, 'p'], [0.7, 'r']]) {
    ctx.fillStyle = rgbaFrom(ctx, accent, alpha);
    for (const col of cols) {
      const amp = Math.min(1, col.s[key] * norm) * maxAmp;
      ctx.fillRect(col.x, mid - amp, col.cw, amp * 2 || 1);
    }
  }

  // The playhead is the one line that does NOT move, so it is the one line worth snapping to
  // whole pixels: it stays hard-edged while everything else slides under it.
  ctx.fillStyle = accent;
  ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
}

// One loop for both strips, running for as long as the stack is up. It decides visibility itself
// every frame rather than being told: what makes a deck livecoded (an eval, a song loading or
// leaving, a deck being cleared) happens in half a dozen places, and a strip that works out its
// own answer each frame cannot be left behind by a path that forgot to say so.
let djLiveWaveRaf = null;
function djLiveWaveFrame() {
  djLiveWaveRaf = null;
  if (!mixModeOn || !mixStacked) return; // applyMixStack starts it again
  for (const deck of ['a', 'b']) {
    const on = djLiveWaveOn(deck);
    djLiveWaveEls[deck].classList.toggle('hidden', !on);
    if (on) djLiveWaveDraw(deck);
  }
  djLiveWaveRaf = requestAnimationFrame(djLiveWaveFrame);
}
function djLiveWaveStart() {
  if (djLiveWaveRaf == null) djLiveWaveRaf = requestAnimationFrame(djLiveWaveFrame);
}
function djLiveWaveStop() {
  if (djLiveWaveRaf != null) cancelAnimationFrame(djLiveWaveRaf);
  djLiveWaveRaf = null;
  for (const deck of ['a', 'b']) djLiveWaveEls[deck].classList.add('hidden');
  djLiveTrace.a = [];
  djLiveTrace.b = [];
}

// --- stacked decks: deck B's pane under deck A's rather than beside it (the ⇅ strip button) ---
// A per-browser preference, not desk state: nothing about the sound changes. The canvases
// re-measure themselves every frame (songSizeCanvas), so the reflow needs no extra plumbing.
const MIX_STACK_KEY = 'poptartMixStacked';
let mixStacked = localStorage.getItem(MIX_STACK_KEY) === '1';
function applyMixStack() {
  // Only ever engaged inside DJ mode: outside it the stack is empty and hidden and the canvases
  // live in their panes - a page reloaded with the preference set must not come up with a
  // blank region holding two canvases beside the editor (which is exactly what it did).
  const on = mixStacked && mixModeOn;
  document.body.classList.toggle('mix-stacked', on);
  document.getElementById('mixStack').classList.toggle('on', mixStacked);
  const stack = document.getElementById('songStack');
  stack.classList.toggle('hidden', !on);
  if (on) {
    // The two detail canvases move up into the stack, A over B; the panes' draw loops keep
    // drawing them wherever they are (they hold the element, not a place in the DOM).
    // Four elements, two per deck, A's pair then B's: only one of each pair is ever visible (a
    // deck holds a file or it holds code), so this fixed order is the visual order either way -
    // and no path that changes what a deck holds has to reorder the stack.
    stack.append(songPanes.a.detailEl, djLiveWaveEls.a, songPanes.b.detailEl, djLiveWaveEls.b);
    songPanes.b.setZoom(songPanes.a.zoomSec(), { propagate: false }); // one scale from here on
    djLiveWaveStart();
  } else {
    for (const d of ['a', 'b']) songPanes[d].reattachDetail();
    djLiveWaveStop();
  }
}
document.getElementById('mixStack').addEventListener('click', () => {
  mixStacked = !mixStacked;
  localStorage.setItem(MIX_STACK_KEY, mixStacked ? '1' : '0');
  if (mixStacked) djRegions.stackMin = false; // stacking on with the region minimized reads as a dead button
  applyMixStack(); // first: which region is springy is read off the stacked class
  djApplyRegionSizes(true);
});

// One seam drag, shared by DJ mode's stacked regions and organize's columns (settleSeamDrag is
// called by both). A row of regions sharing a fixed total, with a draggable seam between each
// pair: the pointer names ONE boundary, the regions nearest it give way first, and one squeezed
// below its minimum folds to a rail and hands the squeeze on to the next one out - so a single
// grip, pushed far enough, folds everything ahead of it in turn.
//
// Every move resolves from the sizes as they were when the drag STARTED, never from the last
// frame. That is what makes the gesture reversible (pull back and regions unfold in the order
// they folded, at the sizes they had) and what stops it oscillating - the DJ seams used to
// compute against a layout their own last frame had changed, which is why one, having folded the
// decks, then jumped upwards as it was dragged further down.
//
// `start`/`fold0` are the starting sizes and fold flags, `mins` the sizes below which a region
// folds, `rail` a folded region's size, `k` the seam (between region k and k+1), `want` the
// boundary the pointer asks for - measured from region 0's leading edge, with the seams
// themselves left out of every size - and `total` all the regions' sizes added up.
function settleSeamDrag({ start, fold0, mins, rail, k, want, total }) {
  const n = start.length;
  const boxOf = (i) => (fold0[i] ? rail : start[i]);
  // A rail is as small as anything gets, so that is how far the boundary can be pushed.
  const left = Math.max((k + 1) * rail, Math.min(want, total - (n - 1 - k) * rail));
  const size = new Array(n).fill(0);
  const fold = new Array(n).fill(false);
  // One side of the seam: `order` runs from the seam outward, so the region against it absorbs
  // the change and the ones beyond keep the size they started the drag with.
  const run = (order, budget) => {
    let remaining = budget;
    for (let j = 0; j < order.length; j++) {
      const i = order[j];
      let beyond = 0;
      for (let m = j + 1; m < order.length; m++) beyond += boxOf(order[m]);
      const mine = remaining - beyond;
      if (mine >= mins[i] || j === order.length - 1) {
        fold[i] = mine < mins[i];
        size[i] = fold[i] ? rail : mine;
        for (let m = j + 1; m < order.length; m++) {
          const o = order[m];
          fold[o] = fold0[o];
          size[o] = boxOf(o);
        }
        return remaining - (size[i] + beyond);
      }
      fold[i] = true; // no room for it at its minimum: it folds and the next one out absorbs
      size[i] = rail;
      remaining -= rail;
    }
    return remaining;
  };
  const before = [];
  for (let i = k; i >= 0; i--) before.push(i);
  const after = [];
  for (let i = k + 1; i < n; i++) after.push(i);
  const slack = run(before, left) + run(after, total - left);
  // Folding rather than sitting under a minimum leaves a sliver over; the nearest open region
  // takes it, so the seam simply stops where it is instead of a gap opening beside it.
  const taker = [k, ...after, ...before.slice(1)].find((i) => !fold[i]);
  if (taker != null) size[taker] += slack;
  else fold[k] = false, size[k] = left; // a window too small for even one region: keep this one
  return { size, fold };
}

// --- DJ mode's three regions: drag the seams to divide the height -----------------------------
//
// Waveforms on top (only while stacked), both decks in the middle, the mixer at the bottom - with
// a drag handle on each of the two seams. Both handles stay handles however little is left: a
// region dragged past its minimum folds to a labelled RAIL saying what is down there, which a
// click (on the rail, or on the seam beside it) opens again. Pushing a handle further than that
// goes on folding whatever is next in its path, so either seam can end up owning the whole
// height. The regions still left open share it, the last one open taking the remainder.
//
// Sizes are px in localStorage, per browser, like the stack preference itself - desk furniture,
// not song state. The canvases re-measure every frame (songSizeCanvas, mixMeterPaint), so the
// only thing a drag has to tell anyone about is CodeMirror.
const DJ_REGION_KEY = 'poptartDjRegions';
const DJ_RAIL_PX = 18; // a folded region: the labelled rail, and .dj-rail's height in the css
const DJ_SEAM_PX = 7; // .dj-resize - a constant now that a folded region has a rail of its own
// Below these a drag folds the region instead of shrinking it further. Deliberately small: every
// region degrades gracefully (the two waveforms shrink together, the strip and the decks clip),
// so all these have to be is small enough that folding reads as a deliberate shove past the end.
const DJ_MIN_PX = { stack: 28, decks: 56, strip: 28 };
const djRegions = { stack: null, strip: null, stackMin: false, stripMin: false, decksMin: false };
try {
  Object.assign(djRegions, JSON.parse(localStorage.getItem(DJ_REGION_KEY) || '{}'));
} catch {
  /* a corrupt entry just means the default division */
}
const djStacked = () => document.body.classList.contains('mix-stacked');

/**
 * The regions, top to bottom, as the drag sees them: without the stack (unstacked DJ mode) there
 * are only two. The decks are never stored as a size - they are the springy region, so their
 * height is always whatever the other two leave.
 */
function djRegionList() {
  return djStacked() ? ['stack', 'decks', 'strip'] : ['decks', 'strip'];
}

function djApplyRegionSizes(save) {
  const root = document.documentElement;
  // Outside DJ mode the page grid is the plain one: main springy, the strip its natural height.
  // The properties are written on :root, so leaving DJ mode has to put them back - a deck folded
  // away in a set must not come back as a collapsed editor the next time the app opens.
  if (!document.body.classList.contains('mix-on')) {
    for (const prop of ['--dj-row-stack', '--dj-row-decks', '--dj-row-main', '--dj-row-strip', '--dj-strip-h']) {
      root.style.removeProperty(prop);
    }
    for (const cls of ['dj-stack-min', 'dj-decks-min', 'dj-strip-min']) document.body.classList.remove(cls);
    if (save) localStorage.setItem(DJ_REGION_KEY, JSON.stringify(djRegions));
    return;
  }
  const stacked = djStacked();
  const stackMin = stacked && djRegions.stackMin;
  const { decksMin, stripMin } = djRegions;
  // The sizes are px dragged in whatever window they were dragged in, and that window may since
  // have shrunk: cap them here (without rewriting what's stored, so a window back at its old
  // height comes back to the old division) or the decks and the console get squeezed off.
  const chrome = 50 + (decksMin ? DJ_RAIL_PX : DJ_MIN_PX.decks);
  const room = Math.max(120, window.innerHeight - chrome);
  let stack = djRegions.stack ? Math.min(djRegions.stack, room) : null;
  let strip = djRegions.strip ? Math.min(djRegions.strip, room) : null;
  if (stack && strip && stack + strip > room) {
    const k = room / (stack + strip);
    stack = Math.round(stack * k);
    strip = Math.round(strip * k);
  }
  // Which region is springy - takes the remainder rather than a size of its own. The decks when
  // they are open; otherwise the waveforms; otherwise the mixer, which then owns the height. The
  // rest of the layout follows from that, so the css needs no combination selectors: it reads
  // these four properties and the three fold classes.
  const springy = !decksMin ? 'decks' : (stacked && !stackMin ? 'stack' : 'strip');
  root.style.setProperty('--dj-row-stack', stackMin ? 'auto'
    : springy === 'stack' ? 'minmax(0, 1fr)'
      : stack ? `${Math.round(stack)}px` : 'minmax(160px, 45%)');
  root.style.setProperty('--dj-row-decks', decksMin ? 'auto' : 'minmax(0, 1fr)');
  // main holds the stack and the decks; it is only a fixed height when everything in it is.
  root.style.setProperty('--dj-row-main', springy === 'strip' ? 'auto' : 'minmax(0, 1fr)');
  root.style.setProperty('--dj-row-strip', springy === 'strip' ? 'minmax(0, 1fr)' : 'auto');
  root.style.setProperty('--dj-strip-h', stripMin || springy === 'strip' ? 'auto'
    : strip ? `${Math.round(strip)}px` : 'auto');
  document.body.classList.toggle('dj-stack-min', !!djRegions.stackMin);
  document.body.classList.toggle('dj-strip-min', !!stripMin);
  document.body.classList.toggle('dj-decks-min', !!decksMin);
  if (save) localStorage.setItem(DJ_REGION_KEY, JSON.stringify(djRegions));
  mixTracksHintAll();
}

/** The editors don't re-measure themselves when their pane changes height. */
function djRegionsReflow() {
  cm.refresh();
  deckBCM?.refresh();
}

/** Fold or open one region by name - what a rail's click, and a seam's, come down to. */
function djSetFolded(name, folded) {
  djRegions[`${name}Min`] = folded;
  djApplyRegionSizes(true);
  djRegionsReflow();
}
for (const [id, name] of [['djStackRail', 'stack'], ['djDecksRail', 'decks'], ['djStripRail', 'strip']]) {
  document.getElementById(id).addEventListener('click', () => djSetFolded(name, false));
}

/**
 * Wire one seam. `k` is the region above it in djRegionList(); the geometry is measured once per
 * drag, off the two elements that don't move while it runs (main's top edge and the console's),
 * so a folded region is still draggable open.
 */
function djInitResizeHandle(id, above) {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const names = djRegionList();
    const k = names.indexOf(above);
    if (k < 0 || k + 1 >= names.length) return; // this seam isn't in play (the stack, unstacked)
    const top = document.querySelector('main').getBoundingClientRect().top;
    const bottom = document.getElementById('console').getBoundingClientRect().top;
    const total = bottom - top - (names.length - 1) * DJ_SEAM_PX;
    // Every region's box as this drag begins. The decks are never stored, so they are read as
    // what is left - which is exactly what the layout gives them.
    const measured = {
      stack: djRegions.stackMin ? DJ_RAIL_PX : document.getElementById('songStack').getBoundingClientRect().height,
      strip: djRegions.stripMin ? DJ_RAIL_PX : mixStripEl.getBoundingClientRect().height,
    };
    measured.decks = Math.max(DJ_RAIL_PX, total - names.reduce((s, n) => s + (n === 'decks' ? 0 : measured[n]), 0));
    const start = names.map((n) => measured[n]);
    const fold0 = names.map((n) => !!djRegions[`${n}Min`]);
    const mins = names.map((n) => DJ_MIN_PX[n]);
    const startY = e.clientY;
    let moved = false;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      if (Math.abs(ev.clientY - startY) > 3) moved = true;
      if (!moved) return;
      // The boundary this seam owns, in the drag's own coordinates: everything above it, with
      // the seams above it taken out (they are not part of any region's size).
      const want = ev.clientY - top - k * DJ_SEAM_PX;
      const { size, fold } = settleSeamDrag({ start, fold0, mins, rail: DJ_RAIL_PX, k, want, total });
      names.forEach((n, i) => {
        djRegions[`${n}Min`] = fold[i];
        if (!fold[i] && n !== 'decks') djRegions[n] = Math.round(size[i]); // a fold keeps its old size to come back to
      });
      djApplyRegionSizes();
    };
    const onUp = (ev) => {
      el.classList.remove('dragging');
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      // A press that never became a drag is a click: the way back for a folded neighbour, the
      // one above first (the same rule as organize's seams).
      if (!moved) {
        const folded = [names[k], names[k + 1]].find((n) => djRegions[`${n}Min`]);
        if (folded) djRegions[`${folded}Min`] = false;
      }
      djApplyRegionSizes(true);
      djRegionsReflow();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
  // Double-click: back to the default division, everything open.
  el.addEventListener('dblclick', () => {
    Object.assign(djRegions, { stack: null, strip: null, stackMin: false, stripMin: false, decksMin: false });
    djApplyRegionSizes(true);
    djRegionsReflow();
  });
}

djInitResizeHandle('djStackResize', 'stack'); // waveforms | decks
djInitResizeHandle('djStripResize', 'decks'); // decks | mixer
applyMixStack(); // here rather than beside its own definition: it now settles the region sizes

djApplyRegionSizes();
window.addEventListener('resize', () => djApplyRegionSizes()); // re-cap, never re-store

// --- the active deck: which one Cmd+Enter and Cmd+. mean --------------------------------------
//
// Clicking anywhere in a deck's pane claims it, the way clicking an editor focuses it - the head,
// the waveform, the code, the empty space beside it. The claim STAYS until the other deck is
// clicked (touching the mixer, the sidebar or the console doesn't give it up: they belong to
// neither deck), and the pane wears an accent ring so which one is armed is never a guess.
// Deck A outside DJ mode, always - there is no other deck to mean.
let djActiveDeck = 'a';

function djSetActiveDeck(deck) {
  djActiveDeck = deck === 'b' && mixModeOn ? 'b' : 'a';
  for (const d of ['a', 'b']) {
    songPanes[d].setActive(d === djActiveDeck);
    document.getElementById(d === 'a' ? 'editorPane' : 'deckBPane')
      .classList.toggle('deck-active', mixModeOn && d === djActiveDeck);
  }
}
document.getElementById('editorPane').addEventListener('pointerdown', () => djSetActiveDeck('a'), true);
document.getElementById('deckBPane').addEventListener('pointerdown', () => djSetActiveDeck('b'), true);

/** The active deck if it is holding a SONG - what the waveform hotkeys (cue, zoom) need. */
function songActiveDeck() {
  return songPanes[djActiveDeck].song ? djActiveDeck : null;
}

/** Play/resume the active deck: its song if it holds one, otherwise its code. */
function djPlayActive() {
  if (songActiveDeck()) songPlay(djActiveDeck);
  else if (djActiveDeck === 'b') evalDeckB(true);
  else evaluate(true, { byHand: true });
}

// --- Ctrl+C: the CUE button on the keyboard ---
//
// Same deck the other transport hotkeys aim at: the pane clicked last, or deck A when it holds
// a file and nothing has been claimed. Held for as long as the key is, so it is the same
// press-and-hold gesture the button is - which means the keyUP is what must never be missed.
// It can go missing three ways, and all three land in songCueKeyUp: the C comes up, Ctrl comes
// up first (browsers stop reporting the C in that state on some layouts), or the window loses
// focus mid-hold.

/**
 * The deck Ctrl+C would cue right now, or null - which is also what gates the hotkey.
 *
 * Ctrl+C is copy everywhere else in the world, and unlike the other transport hotkeys nothing
 * upstream claims it first (CodeMirror leaves copy to the browser, so `defaultPrevented` never
 * saves us here). It stays copy whenever there is a selection to copy or the caret is in a text
 * surface - deck B can be holding CODE while deck A holds the song, and taking the copy out of
 * that editor would be indefensible. With nothing selected and no caret in text there is
 * nothing to copy, so the key is free.
 */
function songCueTarget(e) {
  if (!mixModeOn) return null;
  if (e && (!(window.getSelection()?.isCollapsed ?? true)
    || e.target?.closest?.('input, textarea, select, .CodeMirror, [contenteditable="true"]'))) return null;
  return songActiveDeck() ?? (songPanes.a.song ? 'a' : null);
}

let songCueKeyDeck = null;
function songCueKeyDown(e) {
  if (songCueKeyDeck) return;
  const deck = songCueTarget(e);
  if (!deck) return;
  songCueKeyDeck = deck;
  songPanes[deck].cueDown();
}
function songCueKeyUp() {
  if (!songCueKeyDeck) return;
  const deck = songCueKeyDeck;
  songCueKeyDeck = null;
  songPanes[deck].cueUp();
}
document.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'c' || e.key === 'Control') songCueKeyUp();
});
window.addEventListener('blur', songCueKeyUp);

// Both decks' halves of every desk frame.
function songPaneSync(state) {
  if (!mixModeOn) return;
  for (const d of ['a', 'b']) songPanes[d].sync(state?.song?.[d] ?? null);
}

/** ▶ for a song deck: play/resume through the desk (cycle-quantized against a running clock). */
async function songPlay(deck) {
  const pane = songPanes[deck];
  if (!pane.song) return;
  const U = deck.toUpperCase();
  try {
    // Same as the cue: a paused deck resumes from where its pane shows the playhead.
    const pos = pane.mirror && !pane.mirror.playing ? pane.playheadNow() : undefined;
    const res = await api('POST', '/api/song/play', { deck, pos });
    logLine(`deck ${U} ♪ playing "${pane.song.title}" from ${res.pos.toFixed(1)}s`
      + (res.master ? ` - master: the clock is its grid at ${res.bpm.toFixed(2)} bpm` : ''));
    // Nothing else was playing and this song couldn't take the clock over, so it is running
    // free: the other deck will start whenever it is asked to, not on a downbeat.
    if (res.gridless) {
      logLine(`deck ${U} is playing unsynced - give it a bpm and press sync, or the other deck has no grid to land on`, true);
    }
    // A deck faded fully out plays into a closed crossfader (meter lit, nothing heard) - that
    // earns a pointer, whichever side it is.
    const xf = Number(document.getElementById('crossfader').value);
    if (deck === 'b' ? xf < -0.9 : xf > 0.9) {
      logLine(`deck ${U} is faded all the way out - bring the crossfader over to hear it`);
    }
    playing = true;
    updateTransportButtons();
    mixRefresh();
  } catch (e) {
    logLine(`deck ${U}: ${e.message ?? String(e)}`, true);
  }
}

/** The console line a song load earns - shared by both decks' load paths. */
function songLoadLine(deck, res, title) {
  const m = Math.floor(res.duration / 60);
  const s = String(Math.round(res.duration % 60)).padStart(2, '0');
  const facts = [res.bpm && `${res.bpm} bpm`, res.musicalKey, res.sync && 'synced'].filter(Boolean).join(', ');
  return `deck ${deck.toUpperCase()} loaded ♪ "${title}" (${m}:${s}${res.decoded ? ', decoded' : ''}${facts ? `; ${facts}` : ''})`
    + ' - ▶ plays it';
}

async function evalDeckB(start) {
  if (!deckBCM) return;
  if (songPanes.b.song) {
    // The pane holds a file, not code: ▶ is play/resume through the same desk (cycle-quantized
    // against a running deck A server-side); ↻ has nothing to re-evaluate.
    if (!start) logLine('deck B holds a song - nothing to re-evaluate; ▶ plays/resumes, drag the waveform to scrub');
    else await songPlay('b');
    return;
  }
  try {
    const result = await api('POST', '/api/evaluate', { code: deckBCM.getValue(), deck: 'b', start });
    if (result.transport) transport = result.transport;
    // Deck B gets the same live playback highlighting as the main pane: its regions mark the
    // split editor, keyed "b:<label>" (which is how the /api/highlight top-ups find them).
    setupHighlighting(result.tracks, result.gridFrom ?? 0, result.gridCount ?? 32, 'b', deckBCM);
    const n = result.tracks.filter((t) => t.active).length;
    logLine(`deck B ${start ? 'playing' : 'updated'} (${n}/${result.tracks.length} pattern(s)`
      + (result.deckBpm ? `, native ${result.deckBpm} bpm` : '') + ')');
    if (start) playing = true;
    updateTransportButtons();
    mixRefresh();
  } catch (e) {
    logLine(`deck B: ${e.message ?? String(e)}`, true);
  }
}

// The crossfader is ONE server-side control ('xf', position -1..1): the server unpacks it into
// both decks' `deck` gains through the transition curve (see applyMixTargets in server.js), so
// this slider and a learned MIDI knob drive the same implementation.
function sendCrossfader() {
  mixPost('xf', { name: 'xf', value: Number(document.getElementById('crossfader').value) });
}

const MIX_TRACK_CONTROLS = [
  ['fader', 0, 1, 'fader'],
];
// Trim, the 3-band EQ and the filter are DECK-WIDE on the desk (broadcast into every track's
// own DJ stage, so multitrack outs still carry them per track engine-side); only the stem
// mini-faders are per stem. `fader` here is the deck's CHANNEL fader (the long-throw one) -
// server-side it folds into the deck gain (xf-curve x fader) and never touches the stems.
const MIX_DECK_CONTROLS = ['trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'fader'];
const mixDeckCtl = (deck, ctl) => document.getElementById(
  `mix${ctl === 'djf' ? 'Djf' : ctl.charAt(0).toUpperCase() + ctl.slice(1)}${deck.toUpperCase()}`,
);

// --- the per-deck knob columns ---
// Real rotary knobs (drag up/down), stacked vertically like a mixer's channel strip, one column
// per deck mirrored around the center. Each knob element carries a `value` property and fires
// 'input', exactly like the range inputs it replaced - so the post throttle, the refresh sync,
// dblclick-reset and MIDI-learn all keep working against the same ids (mixTrimA, mixDjfB, ...).
const MIX_KNOB_DEFS = [
  // Hardware-desk order, top to bottom: trim, then the EQ high-first, then the filter.
  ['trim', 'trim', 0, 2, 'trim (deck-wide input gain) - drag up/down; double-click resets'],
  ['eqhi', 'high', 0, 2, 'high (0 is a true kill) - drag up/down; double-click resets'],
  ['eqmid', 'mid', 0, 2, 'mid (0 is a true kill) - drag up/down; double-click resets'],
  ['eqlo', 'low', 0, 2, 'low (0 is a true kill) - drag up/down; double-click resets'],
  ['djf', 'filter', -1, 1, 'one-knob filter: left sweeps a low-pass down, right a high-pass up; double-click resets'],
  // Resonance is the filter's own control, not a function of how far the filter is swept: how
  // deep the sweep goes and how much it whistles are separate decisions, and the loudest peak
  // should not be forced on you at the end of the throw. Bottom of the range is a plain sweep.
  //
  // It rides BESIDE the filter rather than under it (the trailing flag): they are one filter,
  // and the knob column is already what sets the whole strip's height - a sixth row would take
  // that out of the editor for every DJ session, where the row has width to spare.
  ['djres', 'res', 0, 1, "the filter's resonance - up for the whistle, off for a plain sweep; double-click resets", true],
];

function mixMakeKnob(id, min, max, neutral, title) {
  const knob = document.createElement('div');
  knob.className = 'mix-knob';
  knob.id = id;
  knob.title = title;
  let v = neutral;
  const paint = () => knob.style.setProperty('--ang', `${-135 + ((v - min) / (max - min)) * 270}deg`);
  Object.defineProperty(knob, 'value', {
    get: () => v,
    set: (nv) => {
      v = Math.min(max, Math.max(min, Number(nv)));
      paint();
    },
  });
  knob.addEventListener('pointerdown', (e) => {
    if (mixLearnArmed) return; // the learn handler (registered after this one) takes the click
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('dragging');
    const y0 = e.clientY;
    const v0 = v;
    const move = (ev) => {
      knob.value = v0 + ((y0 - ev.clientY) / 150) * (max - min); // full range over ~150px
      knob.dispatchEvent(new Event('input'));
    };
    const up = () => {
      knob.classList.remove('dragging');
      knob.removeEventListener('pointermove', move);
      knob.removeEventListener('pointerup', up);
      knob.removeEventListener('pointercancel', up);
    };
    knob.addEventListener('pointermove', move);
    knob.addEventListener('pointerup', up);
    knob.addEventListener('pointercancel', up);
  });
  paint();
  return knob;
}

for (const deck of ['a', 'b']) {
  const host = document.getElementById(deck === 'a' ? 'mixKnobsA' : 'mixKnobsB');
  let row = null; // the row being filled - a def flagged `pairWithPrev` joins it instead of starting one
  for (const [ctl, label, min, max, title, pairWithPrev] of MIX_KNOB_DEFS) {
    const wrap = document.createElement('div');
    wrap.className = 'mix-knob-wrap';
    const id = `mix${ctl === 'djf' ? 'Djf' : ctl.charAt(0).toUpperCase() + ctl.slice(1)}${deck.toUpperCase()}`;
    const knob = mixMakeKnob(id, min, max, MIX_NEUTRAL[ctl], title);
    const lab = document.createElement('span');
    lab.textContent = label;
    wrap.append(knob, lab);
    if (!(pairWithPrev && row)) {
      row = document.createElement('div');
      row.className = 'mix-knob-row';
      host.appendChild(row);
    }
    row.appendChild(wrap);
  }
}

// --- the channel faders (mixFaderA/B) and channel meters, flanking the center ---
// The fader is the deck's long-throw channel fader, on top of the crossfader like a hardware
// desk's; like the knobs it carries a `value` property and fires 'input' so the shared
// post/learn/sync wiring below sees just another control. The meter is that deck's PRE-FADER
// level (post trim/EQ/filter - the same point the cue tap reads), which is what makes it a gain
// staging meter: ride trim until the deck peaks around the top of the green, whatever the
// faders are doing.
function mixMakeFader(id, title) {
  const el = document.createElement('div');
  el.className = 'mix-dfader';
  el.id = id;
  el.title = title;
  const grip = document.createElement('div');
  grip.className = 'mix-dfader-grip';
  el.appendChild(grip);
  let v = 1;
  const paint = () => el.style.setProperty('--pos', String(v));
  Object.defineProperty(el, 'value', {
    get: () => v,
    set: (nv) => {
      v = Math.min(1, Math.max(0, Number(nv)));
      paint();
    },
  });
  el.addEventListener('pointerdown', (e) => {
    if (mixLearnArmed) return; // the learn handler (registered after this one) takes the click
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const apply = (ev) => {
      const r = el.getBoundingClientRect();
      const pad = 9; // half the grip: full travel keeps the grip inside the groove
      el.value = 1 - (ev.clientY - r.top - pad) / Math.max(1, r.height - pad * 2);
      el.dispatchEvent(new Event('input'));
    };
    apply(e); // jump to the pointer, then track it
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', apply);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', apply);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  paint();
  return el;
}

// dBFS scale shared by drawing and readout. -42..+6 spans the useful range; the floor renders
// as silence. Zone edges are the usual digital-desk ones: green headroom, amber from -9, red
// from -3 (still pre-clip - 0 is the wall).
const MIX_METER_DB = { min: -42, max: 6 };
const mixMeterDb = (x) => 20 * Math.log10(Math.max(x, 1e-5));
const mixMeterColor = (db) => (db >= -3 ? '#f85149' : db >= -9 ? '#d29922' : '#3fb950');

// Latest pushed level per deck (the SSE 'level' events) and the drawn state: RMS bar with fast
// attack / slow release, peak line, and a held numeric peak that decays after a beat.
const mixMeterFeed = { a: null, b: null };
const mixMeterDraw = {
  a: { rms: -90, peak: -90, hold: -90, holdAt: 0 },
  b: { rms: -90, peak: -90, hold: -90, holdAt: 0 },
};

for (const deck of ['a', 'b']) {
  const faderCol = document.getElementById(deck === 'a' ? 'mixDfaderColA' : 'mixDfaderColB');
  const fader = mixMakeFader(`mixFader${deck.toUpperCase()}`,
    `deck ${deck.toUpperCase()} channel fader (with the crossfader on top) - double-click resets`);
  const flab = document.createElement('span');
  flab.textContent = 'fader';
  faderCol.append(fader, flab);

  const meterCol = document.getElementById(deck === 'a' ? 'mixMeterColA' : 'mixMeterColB');
  const canvas = document.createElement('canvas');
  canvas.className = 'mix-meter';
  canvas.id = `mixMeter${deck.toUpperCase()}`;
  canvas.title = `deck ${deck.toUpperCase()} channel meter - pre-fader (post trim/EQ/filter), like a desk's: gain stage with trim`;
  const readout = document.createElement('span');
  readout.className = 'mix-meter-db';
  readout.id = `mixMeterDb${deck.toUpperCase()}`;
  readout.textContent = '-∞';
  meterCol.append(canvas, readout);
}

// One meter frame: segmented bar (lit up to the RMS), a peak line, dB ticks on the outer edge
// (mirrored per deck), and the held peak as the number below. ~60fps only while the strip is
// open; ballistics live here so however the ~25/sec frames land the fall reads as motion.
function mixMeterPaint(deck, dtSec) {
  const canvas = document.getElementById(`mixMeter${deck.toUpperCase()}`);
  const readout = document.getElementById(`mixMeterDb${deck.toUpperCase()}`);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const d = mixMeterDraw[deck];
  const feed = mixMeterFeed[deck];
  const rmsDb = feed ? mixMeterDb(feed.r) : -90;
  const peakDb = feed ? mixMeterDb(feed.p) : -90;
  // Attack instantly, release at 36 dB/s (the classic readable fall); the held peak stays put
  // for 1.2s then falls too.
  const fall = 36 * dtSec;
  d.rms = rmsDb > d.rms ? rmsDb : Math.max(rmsDb, d.rms - fall);
  d.peak = peakDb > d.peak ? peakDb : Math.max(peakDb, d.peak - fall);
  const now = performance.now();
  if (peakDb >= d.hold) {
    d.hold = peakDb;
    d.holdAt = now;
  } else if (now - d.holdAt > 1200) {
    d.hold = Math.max(d.hold - fall, d.peak);
  }

  const pad = 8; // top/bottom margin so the end ticks' labels fit
  const scaleH = cssH - pad * 2;
  const yOf = (db) => pad + (1 - (db - MIX_METER_DB.min) / (MIX_METER_DB.max - MIX_METER_DB.min)) * scaleH;
  const mirror = deck === 'b'; // deck B mirrors deck A: bars on the outer edges, ticks facing the center
  const barW = 11;
  const barX = mirror ? cssW - barW - 1 : 1;

  // Segments, 3px on a 4px pitch, each colored by its own position - lit to the RMS bar.
  for (let y = yOf(MIX_METER_DB.max); y < yOf(MIX_METER_DB.min); y += 4) {
    const segDb = MIX_METER_DB.min + (1 - (y - pad) / scaleH) * (MIX_METER_DB.max - MIX_METER_DB.min);
    g.globalAlpha = segDb <= d.rms ? 1 : 0.14;
    g.fillStyle = mixMeterColor(segDb);
    g.fillRect(barX, y, barW, 3);
  }
  g.globalAlpha = 1;
  // The moving peak line and the held one above it.
  if (d.peak > MIX_METER_DB.min) {
    g.fillStyle = mixMeterColor(d.peak);
    g.fillRect(barX, yOf(Math.min(d.peak, MIX_METER_DB.max)), barW, 1.5);
  }
  if (d.hold > MIX_METER_DB.min) {
    g.fillStyle = mixMeterColor(d.hold);
    g.fillRect(barX, yOf(Math.min(d.hold, MIX_METER_DB.max)), barW, 1);
  }
  // dB ticks on the center-facing edge, mirrored per deck like everything else on the desk.
  g.font = '8px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
  g.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#888';
  g.textBaseline = 'middle';
  g.textAlign = mirror ? 'right' : 'left';
  const tickX = mirror ? barX - 3 : barX + barW + 3;
  for (const db of [6, 0, -6, -12, -18, -24, -36]) {
    g.fillText(db > 0 ? `+${db}` : String(db), tickX, yOf(db));
  }

  readout.textContent = d.hold <= -55 ? '-∞' : d.hold.toFixed(1);
  readout.classList.toggle('over', d.hold > -3);
}

let mixMeterRaf = null;
let mixMeterLastT = 0;
function mixMeterLoop(t) {
  if (!mixModeOn) {
    mixMeterRaf = null;
    return;
  }
  const dt = Math.min(0.1, (t - mixMeterLastT) / 1000 || 0.016);
  mixMeterLastT = t;
  mixMeterPaint('a', dt);
  mixMeterPaint('b', dt);
  mixMeterRaf = requestAnimationFrame(mixMeterLoop);
}
function mixMeterStart() {
  if (mixMeterRaf == null) {
    mixMeterLastT = performance.now();
    mixMeterRaf = requestAnimationFrame(mixMeterLoop);
  }
}

async function mixRefresh() {
  if (!mixModeOn) return;
  let state;
  try {
    state = await api('GET', '/api/mix');
  } catch {
    return; // the strip just doesn't refresh; the next action retries
  }
  for (const deck of ['a', 'b']) {
    const host = document.getElementById(deck === 'a' ? 'mixTracksA' : 'mixTracksB');
    host.innerHTML = '';
    for (const t of state.tracks.filter((x) => x.deck === deck)) host.appendChild(mixTrackRow(t, !!state.solo?.[deck]?.includes(t.key)));
    mixTracksHint(host);
  }
  document.getElementById('mixSwap').checked = !!state.swap;
  mixSyncValues(state);
}

// The stem lists scroll inside whatever height the strip has; these mark the edges that hide
// more rows (see .mix-tracks-col::before/::after) from the scroll position - re-read on scroll,
// on every rebuild, and whenever the strip changes height.
function mixTracksHint(host) {
  const wrap = host.parentElement; // .mix-tracks-wrap - the hints are its ::before/::after
  wrap.classList.toggle('more-above', host.scrollTop > 1);
  wrap.classList.toggle('more-below', host.scrollTop + host.clientHeight < host.scrollHeight - 1);
}
function mixTracksHintAll() {
  for (const id of ['mixTracksA', 'mixTracksB']) mixTracksHint(document.getElementById(id));
}
for (const id of ['mixTracksA', 'mixTracksB']) {
  const host = document.getElementById(id);
  host.addEventListener('scroll', () => mixTracksHint(host), { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => mixTracksHint(host)).observe(host);
}

// A short visual glide toward `target`, so the pushed frames (~30ms apart under a moving
// knob) read as one continuous sweep rather than steps. Snaps when close.
function mixGlide(el, target) {
  const from = Number(el.value);
  cancelAnimationFrame(el._mixGlide);
  if (!Number.isFinite(from) || Math.abs(target - from) < 0.002) {
    el.value = target;
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const u = Math.min(1, (t - t0) / 80); // frames arrive ~30ms apart; just enough to read as motion
    el.value = from + (target - from) * u;
    if (u < 1) el._mixGlide = requestAnimationFrame(step);
  };
  el._mixGlide = requestAnimationFrame(step);
}

// The sliders' side of a refresh, rebuilt-row-free - also run on a poll while the strip is
// open, so a learned MIDI knob (which drives the server directly) moves the on-screen desk.
function mixSyncValues(state) {
  for (const deck of ['a', 'b']) {
    for (const ctl of MIX_DECK_CONTROLS) {
      const el = mixDeckCtl(deck, ctl);
      // not while a hand is on it: a focused input, or a knob mid-drag
      if (document.activeElement !== el && !el.classList.contains('dragging')) {
        // The channel fader lives in state.faders (it folds into the deck gain server-side,
        // never into the perDeck broadcast - see MIX_DECK_CONTROLS).
        const target = ctl === 'fader' ? (state.faders?.[deck] ?? 1)
          : (state.perDeck[deck][ctl] ?? MIX_NEUTRAL[ctl]);
        mixGlide(el, target);
      }
    }
  }
  const xf = document.getElementById('crossfader');
  if (document.activeElement !== xf && typeof state.xf === 'number') mixGlide(xf, state.xf);
  for (const deck of ['a', 'b']) {
    const btn = document.getElementById(deck === 'a' ? 'mixCueA' : 'mixCueB');
    btn.disabled = !state.cue;
    btn.title = state.cue
      ? `cue deck ${deck.toUpperCase()} in the headphones ("${state.cue.name}", post-EQ pre-fader)`
      : 'no cue pair this boot - pick a cue device in the settings tab (restarts the engine)';
    btn.classList.toggle('on', (state.perDeck[deck].cue ?? 0) > 0);
  }
  mixTempoRender(state);
  songPaneSync(state); // after the tempo render: adoption reads mixNativeBpm for its beatgrid
  deckHeadRender(state);
}

// The desk push channel: the server frames every desk change (throttled to ~30ms) over SSE,
// so a learned MIDI knob's moves reach the on-screen desk near-instantly with zero idle
// traffic - see serveMixEvents in server.js. EventSource reconnects by itself, so a server
// restart mid-session just resumes the mirror.
let mixEvents = null;
function mixPushStart() {
  mixPushStop();
  mixEvents = new EventSource('/api/mix/events');
  mixEvents.onmessage = (e) => {
    if (!mixModeOn) return;
    try {
      mixSyncValues(JSON.parse(e.data));
    } catch { /* a torn frame; the next one corrects */ }
  };
  // The channel meter feed rides the same stream as NAMED events, so the desk-state handler
  // above never sees them. Frames just land in mixMeterFeed; the rAF loop draws.
  mixEvents.addEventListener('level', (e) => {
    if (!mixModeOn) return;
    try {
      const { a, b } = JSON.parse(e.data);
      mixMeterFeed.a = a;
      mixMeterFeed.b = b;
      djLiveTracePush({ a, b }); // the same frames, kept as history for the livecoded strips
    } catch { /* a torn frame; the next one corrects */ }
  });
  mixMeterStart();
}
function mixPushStop() {
  mixEvents?.close();
  mixEvents = null;
}

// --- tempo migration (phase 5): the shared clock rides between the songs' native tempos ---

let mixNativeBpm = { a: null, b: null }; // what each deck's song declared (setbpm), via /api/mix
let mixTempoAnim = null; // local mirror of a server-side ramp, so the readout glides w/o polling

const mixTempoNowEl = document.getElementById('mixTempoNow');
const mixTempoSliderEl = document.getElementById('mixTempoSlider');

function mixTempoShow(bpm) {
  mixTempoNowEl.textContent = bpm == null ? '' : `${bpm.toFixed(1)} bpm`;
  const { a, b } = mixNativeBpm;
  if (bpm != null && a != null && b != null && a !== b && document.activeElement !== mixTempoSliderEl) {
    mixTempoSliderEl.value = Math.min(1, Math.max(0, (bpm - a) / (b - a)));
  }
}

function mixTempoAnimStop() {
  if (mixTempoAnim) clearInterval(mixTempoAnim);
  mixTempoAnim = null;
}

function mixTempoAnimStart(from, to, seconds) {
  mixTempoAnimStop();
  if (!(seconds > 0)) return mixTempoShow(to);
  const t0 = performance.now();
  mixTempoAnim = setInterval(() => {
    const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
    mixTempoShow(from + (to - from) * u);
    if (u >= 1) mixTempoAnimStop();
  }, 100);
}

function mixTempoRender(state) {
  mixNativeBpm = state.deckBpm;
  for (const deck of ['a', 'b']) {
    const btn = document.getElementById(deck === 'a' ? 'mixTempoA' : 'mixTempoB');
    const bpm = state.deckBpm[deck];
    // One decimal at most: a detected bpm can carry float noise, and the button is fixed-width
    // (see .mix-tempo-detent - the center must not resize, or the whole desk shifts).
    btn.textContent = bpm != null ? bpm.toFixed(1).replace(/\.0$/, '') : '—';
    btn.disabled = bpm == null;
    btn.classList.toggle('at', bpm != null && state.tempo.master != null
      && Math.abs(state.tempo.master - bpm) < 0.05);
  }
  mixTempoSliderEl.disabled = !(state.deckBpm.a != null && state.deckBpm.b != null
    && state.deckBpm.a !== state.deckBpm.b);
  if (!mixTempoAnim) mixTempoShow(state.tempo.master);
}

// A detent: glide the clock to that deck's native tempo over the ramp time. One clean request
// per click - no throttle needed.
async function mixTempoDetent(deck) {
  const seconds = Math.max(0, Number(document.getElementById('mixTempoSecs').value) || 0);
  try {
    const res = await api('POST', '/api/mix/tempo', { deck, seconds });
    mixTempoAnimStart(res.from, res.bpm, res.seconds);
    logLine(`tempo → ${res.bpm} bpm (deck ${deck.toUpperCase()}'s native)${res.seconds ? ` over ${res.seconds}s` : ''}`);
    mixRefresh(); // the detent highlight (and, at 0s, the readout) comes from server truth
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// The slider ride: position 0..1 maps deck A's native to deck B's, applied instantly and
// throttled like every other streamed control (latest value wins, one POST per ~50ms).
let mixTempoFlushTimer = null;
let mixTempoPendingBpm = null;
mixTempoSliderEl.addEventListener('input', () => {
  const { a, b } = mixNativeBpm;
  if (a == null || b == null || a === b) return;
  mixTempoAnimStop();
  const bpm = a + (b - a) * Number(mixTempoSliderEl.value);
  mixTempoShow(bpm);
  mixTempoPendingBpm = bpm;
  if (mixTempoFlushTimer) return;
  mixTempoFlushTimer = setTimeout(() => {
    mixTempoFlushTimer = null;
    api('POST', '/api/mix/tempo', { bpm: mixTempoPendingBpm, seconds: 0 })
      .catch((e) => logLine(e.message ?? String(e), true));
  }, 50);
});
document.getElementById('mixTempoA').addEventListener('click', () => mixTempoDetent('a'));
document.getElementById('mixTempoB').addEventListener('click', () => mixTempoDetent('b'));

function mixTrackRow(t, soloed) {
  const row = document.createElement('div');
  row.className = 'mix-track';
  const fader = t.controls.fader ?? 1;

  const gate = document.createElement('button');
  gate.className = 'mix-gate' + (fader > 0 ? ' on' : '') + (soloed ? ' solo' : '');
  gate.title = 'gate this stem in/out (fader to 1/0)'
    + '; with swap on, gating IN throws the other deck\'s same-named stem out and gating OUT brings it back - toggle to audition either'
    + '; cmd+click solos it within its deck (blue) - cmd+click another to move the solo there, cmd+shift+click to add one, cmd+click a soloed stem to drop it. A plain click on any soloed stem ends the solo and puts the deck back as it was';
  gate.addEventListener('click', async (e) => {
    try {
      // cmd (ctrl elsewhere) + click: solo within the deck rather than toggle this one gate.
      if (e.metaKey || e.ctrlKey) await api('POST', '/api/mix/solo', { key: t.key, add: e.shiftKey });
      else await api('POST', '/api/mix/gate', { key: t.key, on: !gate.classList.contains('on') });
      mixRefresh(); // a countered stem's row (or, for a solo, the whole deck) changes too
    } catch (e) {
      logLine(e.message ?? String(e), true);
    }
  });

  const name = document.createElement('span');
  name.className = 'mix-name';
  name.textContent = t.deck === 'b' ? t.key.slice(t.key.indexOf(':') + 1) : t.key;
  name.title = t.key;
  row.append(gate, name);

  for (const [ctl, min, max, title] of MIX_TRACK_CONTROLS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = 0.01;
    input.value = t.controls[ctl] ?? MIX_NEUTRAL[ctl];
    input.className = `dj-fader mix-ctl mix-${ctl}`;
    input.title = `${title} - double-click resets`;
    input.addEventListener('input', () => mixPost(`${t.key}|${ctl}`, { key: t.key, name: ctl, value: Number(input.value) }));
    input.addEventListener('dblclick', () => {
      input.value = MIX_NEUTRAL[ctl];
      mixPost(`${t.key}|${ctl}`, { key: t.key, name: ctl, value: MIX_NEUTRAL[ctl] });
    });
    row.appendChild(input);
  }
  return row;
}

// --- MIDI learn (the `midi` button): arm, click a desk control, move a hardware knob ---
// The mapping itself lives server-side (settings.json) and the server consumes mapped CCs
// directly - this is only the binding gesture. Alt+click a control while armed to unbind it.

let mixLearnArmed = false;
let mixLearnSeq = 0; // silences the null reply of a poll superseded by the NEXT control's click
const mixLearnBtn = document.getElementById('mixLearn');

// Learn mode STAYS armed across bindings: tap low, turn a knob, tap high, turn the next knob...
// Only clicking `midi` again (or esc) leaves it.
function setMixLearn(on) {
  mixLearnArmed = on;
  mixLearnBtn.classList.toggle('on', on);
  logLine(on
    ? 'MIDI learn armed - click a desk control then move a knob, as many as you like; esc or midi again to finish (alt+click unbinds)'
    : 'MIDI learn off');
}
mixLearnBtn.addEventListener('click', () => setMixLearn(!mixLearnArmed));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mixLearnArmed) setMixLearn(false);
});

async function mixLearnDo(target, clear) {
  const my = ++mixLearnSeq;
  try {
    if (clear) {
      await api('POST', '/api/mix/midilearn', { target, clear: true });
      logLine(`${target} unbound - next control?`);
      return;
    }
    logLine(`learning ${target} - move a MIDI knob…`);
    const { learned } = await api('POST', '/api/mix/midilearn', { target });
    if (learned) logLine(`${target} ← cc ${learned.cc} (ch ${learned.channel}, ${learned.device}) - next control?`);
    // A null reply is EITHER the 10s timeout or this poll being superseded by the next
    // control's click - only the timeout (still the latest, still armed) is worth a line.
    else if (my === mixLearnSeq && mixLearnArmed) logLine(`no CC seen for ${target} - still armed`, true);
  } catch (e) {
    logLine(e.message ?? String(e), true);
  }
}

// While armed, a pointerdown on a learnable control is the binding gesture, not a drag.
function mixLearnAttach(el, target) {
  el.addEventListener('pointerdown', (e) => {
    if (!mixLearnArmed) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the knob's own drag handler must not also fire
    mixLearnDo(target, e.altKey);
  }, true);
}
mixLearnAttach(document.getElementById('crossfader'), 'xf');
for (const deck of ['a', 'b']) {
  for (const ctl of MIX_DECK_CONTROLS) mixLearnAttach(mixDeckCtl(deck, ctl), `${deck}:${ctl}`);
}

// The 🎧 buttons: deck-wide cue on/off (a broadcast `cue` value, like every desk control - new
// stems of that deck are born wearing it via the birth args).
for (const deck of ['a', 'b']) {
  const btn = document.getElementById(deck === 'a' ? 'mixCueA' : 'mixCueB');
  btn.addEventListener('click', () => {
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    mixPost(`cue-${deck}`, { deck, name: 'cue', value: on ? 1 : 0 });
  });
}

// The `mute all` buttons: every gate on that deck out in one press (see mixGateAll in
// server.js). A plain action despite the name - nothing lights up and there is no unmute, since
// what it leaves behind is a set of ordinary gates you bring back one at a time. Every row on
// the deck just changed, and rows only come from GET /api/mix, so it takes a real refresh
// rather than a pushed desk frame.
for (const deck of ['a', 'b']) {
  const btn = document.getElementById(deck === 'a' ? 'mixMuteAllA' : 'mixMuteAllB');
  btn.addEventListener('click', async () => {
    try {
      const { gated } = await api('POST', '/api/mix/gateall', { deck });
      logLine(`deck ${deck.toUpperCase()}: ${gated.length} stem${gated.length === 1 ? '' : 's'} muted`);
    } catch (e) {
      logLine(e.message ?? String(e), true);
    }
    mixRefresh();
  });
}

document.getElementById('crossfader').addEventListener('input', sendCrossfader);
document.getElementById('crossfader').addEventListener('dblclick', (e) => {
  e.target.value = -1; // home: all deck A
  sendCrossfader();
});
document.getElementById('mixSwap').addEventListener('change', (e) => {
  api('POST', '/api/mix/swap', { on: e.target.checked }).catch((err) => logLine(err.message ?? String(err), true));
});
for (const deck of ['a', 'b']) {
  for (const ctl of MIX_DECK_CONTROLS) {
    const el = mixDeckCtl(deck, ctl);
    el.addEventListener('input', () => mixPost(`${ctl}-${deck}`, { deck, name: ctl, value: Number(el.value) }));
    el.addEventListener('dblclick', () => {
      el.value = MIX_NEUTRAL[ctl];
      mixPost(`${ctl}-${deck}`, { deck, name: ctl, value: MIX_NEUTRAL[ctl] });
    });
  }
}
document.getElementById('deckBSong').addEventListener('click', () => openOrganize('b'));
document.getElementById('deckBPlay').addEventListener('click', () => (deckPlayingNow.b ? doStop('b') : evalDeckB(true)));
document.getElementById('deckBUpdate').addEventListener('click', () => evalDeckB(false));
document.getElementById('deckAKeep').addEventListener('click', () => exitDjMode('a'));
document.getElementById('deckBKeep').addEventListener('click', () => exitDjMode('b'));
document.getElementById('deckASong').addEventListener('click', () => openOrganize('a'));
document.getElementById('deckAPlay').addEventListener('click', () => (
  deckPlayingNow.a ? doStop('a')
    : mixModeOn && songPanes.a.song ? songPlay('a') : evaluate(true, { byHand: true })));
document.getElementById('deckAUpdate').addEventListener('click', () => {
  if (mixModeOn && songPanes.a.song) {
    logLine('deck A holds a song - nothing to re-evaluate; ▶ plays/resumes, drag the waveform to scrub');
    return;
  }
  evaluate(false, { byHand: true });
});
document.getElementById('deckBNext').addEventListener('click', stepDeckBQueue);
document.getElementById('fileOrganizeBtn').addEventListener('click', () => openOrganize());

// ---------------------------------------------------------------------------------------------
// The library - playlists over saved patterns, and the organize modal (three panes: playlists /
// the open one's contents / every saved song). Ported from fizzle (~/td-livecode). One
// library.json lives WITH the pattern files server-side, so a set travels with its songs; this
// side holds a working copy and posts the whole document back, coalesced. Tags are read-only
// here - they are the files' own @tags, edited in the code - and bpm is read from each song's
// setbpm, so the library never duplicates what a file already says. The ACTIVE playlist is the
// set deck B's picker follows.
// ---------------------------------------------------------------------------------------------

let libDoc = null; // the working copy; null until first needed
let libSaveTimer = null;

async function loadLibraryDoc() {
  if (!libDoc) libDoc = await api('GET', '/api/library');
  return libDoc;
}

// One write per gesture, not per row: a drag through a playlist coalesces. The response is the
// normalized document, which becomes the working copy - the client converges on server truth.
function saveLibraryDoc() {
  clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    try {
      libDoc = await api('POST', '/api/library', libDoc);
    } catch (e) {
      logLine(e.message ?? String(e), true);
    }
    if (mixModeOn) refreshDeckFiles(); // the pickers mirror the active set
  }, 200);
}

const libNewId = () => Math.random().toString(36).slice(2, 10);

// --- the organize modal ---

let orgEl = null; // built on first open
let orgSelected = null; // playlist id open in the middle pane
let orgQuery = '';
let orgSort = 'saved'; // 'saved' (newest first, the API's order) | 'name'
let orgSongs = []; // saved patterns, refreshed on open
let orgHeld = null; // what a drag is carrying: { from: 'all'|'items', item, index? } - item is a name or a file item

// Opened from a deck head (`forDeck`), the window is that deck's picker: clicking a song in
// the playlist or all-songs pane loads it there and closes the window. From the files tab it
// is the library editor it always was.
let orgForDeck = null;
async function openOrganize(forDeck = null) {
  orgForDeck = forDeck;
  try {
    await loadLibraryDoc();
    await refreshSongFileStat(libDoc); // file items render as missing when their path is gone
    const { patterns } = await api('GET', '/api/patterns?q=');
    orgSongs = patterns;
  } catch (e) {
    logLine(e.message ?? String(e), true);
    return;
  }
  if (!orgEl) buildOrganize();
  syncPreviewRouting(); // the window auditions, so settle where that comes out before it can
  if (!orgSelected) orgSelected = libDoc.playlists.find((p) => p.id === libDoc.active)?.id ?? libDoc.playlists[0]?.id ?? null;
  orgEl.classList.remove('hidden');
  window.addEventListener('keydown', orgOnKey);
  orgSongSel.clear();
  orgSongAnchor = null;
  orgItemSel.clear();
  orgItemAnchor = null;
  orgPickKey = null;
  orgSay(''); // the footer reports what happens - it is not a standing instruction
  orgRender();
  orgEl.querySelector('#orgSearch').focus();
}

function closeOrganize() {
  orgHeld = null;
  orgForDeck = null;
  orgPlayerStopSource();
  orgRenderTransport();
  orgEl?.classList.add('hidden');
  window.removeEventListener('keydown', orgOnKey);
}

// --- the three columns' widths: two draggable seams, a column dragged below its minimum
// collapses to a labelled rail (click it, or its seam, to bring it back), double-click a seam
// to reset. Stored widths are px; the LAST open column takes whatever is left, so the panel
// is always exactly filled. Remembered across sessions. ---
const ORG_COLS_KEY = 'poptart.orgCols';
const ORG_COL_MIN = 90; // narrower than this and the column folds to a rail
const ORG_RAIL = 22;
const ORG_SEAM = 7;
let orgCols = { w: [null, null, null], min: [false, false, false] };
try {
  const saved = JSON.parse(localStorage.getItem(ORG_COLS_KEY) ?? 'null');
  if (saved?.w?.length === 3 && saved?.min?.length === 3) orgCols = saved;
} catch { /* a damaged entry is the default */ }

function orgApplyCols(save) {
  const cols = orgEl.querySelectorAll('.org-col');
  const last = [2, 1, 0].find((i) => !orgCols.min[i]);
  const defaults = ['minmax(0, 1fr)', 'minmax(0, 1.2fr)', 'minmax(0, 1.4fr)'];
  const track = (i) => {
    if (orgCols.min[i]) return `${ORG_RAIL}px`;
    if (i === last) return 'minmax(0, 1fr)';
    return orgCols.w[i] ? `${orgCols.w[i]}px` : defaults[i];
  };
  orgEl.querySelector('#orgCols').style.gridTemplateColumns =
    `${track(0)} ${ORG_SEAM}px ${track(1)} ${ORG_SEAM}px ${track(2)}`;
  cols.forEach((c, i) => c.classList.toggle('min', !!orgCols.min[i]));
  if (save) {
    try { localStorage.setItem(ORG_COLS_KEY, JSON.stringify(orgCols)); } catch { /* fine */ }
  }
}

function orgInitCols() {
  const grid = orgEl.querySelector('#orgCols');
  const cols = [...orgEl.querySelectorAll('.org-col')];
  cols.forEach((c, i) => c.querySelector('.org-rail').addEventListener('click', () => {
    orgCols.min[i] = false;
    orgApplyCols(true);
  }));
  for (const seam of orgEl.querySelectorAll('.org-seam')) {
    const k = Number(seam.dataset.seam); // the column to this seam's left
    seam.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = grid.getBoundingClientRect();
      // Every column's width as this drag begins: the seam resolves against these rather than
      // against its own last frame, and a column squeezed past its minimum folds and hands the
      // squeeze on to the next one out - so one seam, pushed far enough, folds both of the
      // columns ahead of it (see settleSeamDrag, shared with DJ mode's seams).
      const start = cols.map((c) => c.getBoundingClientRect().width);
      const fold0 = orgCols.min.slice();
      const mins = cols.map(() => ORG_COL_MIN);
      const total = start.reduce((a, b) => a + b, 0);
      const startX = e.clientX;
      let moved = false;
      seam.classList.add('dragging');
      seam.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (!moved) return;
        // Where the pointer puts this seam's boundary, measured from the first column's edge
        // with the seams themselves left out (they are not part of any column's width).
        const want = ev.clientX - g.left - k * ORG_SEAM - ORG_SEAM / 2;
        const { size, fold } = settleSeamDrag({ start, fold0, mins, rail: ORG_RAIL, k, want, total });
        cols.forEach((c, i) => {
          orgCols.min[i] = fold[i];
          if (!fold[i]) orgCols.w[i] = Math.round(size[i]); // a folded one keeps its old width to come back to
        });
        orgApplyCols();
      };
      const onUp = (ev) => {
        seam.classList.remove('dragging');
        if (seam.hasPointerCapture?.(ev.pointerId)) seam.releasePointerCapture(ev.pointerId);
        seam.removeEventListener('pointermove', onMove);
        seam.removeEventListener('pointerup', onUp);
        seam.removeEventListener('pointercancel', onUp);
        // A press that never became a drag is a click: the way back for a folded neighbour.
        if (!moved) {
          if (orgCols.min[k]) orgCols.min[k] = false;
          else if (orgCols.min[k + 1]) orgCols.min[k + 1] = false;
        }
        orgApplyCols(true);
      };
      seam.addEventListener('pointermove', onMove);
      seam.addEventListener('pointerup', onUp);
      seam.addEventListener('pointercancel', onUp);
    });
    seam.addEventListener('dblclick', () => {
      orgCols = { w: [null, null, null], min: [false, false, false] };
      orgApplyCols(true);
    });
  }
  orgApplyCols();
}

function orgOnKey(e) {
  if (e.key === 'Enter' && orgForDeck && orgPickKey != null && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target?.tagName ?? '')) {
    e.preventDefault();
    e.stopPropagation();
    orgLoadPicked();
    return;
  }
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeOrganize();
}

/**
 * The deck picker's load. A row is SELECTED on click and loaded on Enter, a double-click or the
 * footer's → deck button - the same two-step shape as every other list in the app, and what lets
 * a set be built (shift/⌘-click, ←) from the same window without a stray click swapping the song
 * out on a live deck.
 */
let orgPickKey = null; // libItemKey of the row a load acts on; null when nothing is picked
function orgLoadPicked() {
  if (!orgForDeck || orgPickKey == null) return;
  const item = orgPickItem(orgPickKey);
  if (item != null) loadDeckSong(orgForDeck, item);
}
function orgPickItem(key) {
  if (!String(key).startsWith('file:')) return orgSongs.some((x) => x.name === key) ? key : null;
  for (const p of libDoc.playlists) {
    const hit = p.items.find((it) => libItemKey(it) === key);
    if (hit) return hit;
  }
  return null;
}


function buildOrganize() {
  orgEl = document.createElement('div');
  orgEl.id = 'orgModal';
  orgEl.className = 'hidden';
  orgEl.innerHTML = `
    <div id="orgPanel">
      <header>
        <span class="org-title">organize</span>
        <input id="orgSearch" type="search" placeholder="filter songs… (name, tag:, bpm)" autocomplete="off" spellcheck="false">
        <span class="spacer"></span>
        <button id="orgClose" class="small" title="close (esc)">✕</button>
      </header>
      <div id="orgCols">
        <section class="org-col">
          <h3>playlists <button id="orgAdd" class="small" title="new playlist">+</button></h3>
          <ul id="orgLists"></ul>
          <div class="org-rail" title="click to bring the playlists back">playlists</div>
        </section>
        <div class="org-seam" data-seam="0" title="drag to resize (all the way left minimizes, double-click resets)"></div>
        <section class="org-col">
          <h3 id="orgItemsTitle">contents</h3>
          <ul id="orgItems" tabindex="-1"></ul>
          <div class="org-rail" title="click to bring the playlist's contents back">contents</div>
        </section>
        <div class="org-seam" data-seam="1" title="drag to resize (past either end minimizes a column, double-click resets)"></div>
        <section class="org-col">
          <h3>
            <button id="orgTabSongs" class="org-tab on" title="every saved pattern">all songs</button>
            <button id="orgTabDisk" class="org-tab" title="audio files on this computer">disk</button>
            <span class="spacer"></span>
            <button id="orgSongAdd" class="small" title="add the selection to the open playlist (←)">← add</button>
            <select id="orgSort" title="order of this list"></select>
          </h3>
          <div id="orgDiskBar" class="hidden">
            <button id="orgBrowseUp" class="small" title="up one directory">↑</button>
            <span id="orgBrowsePath"></span>
            <button id="orgDiskAdd" class="small" title="add the selection to the open playlist (←)">←</button>
          </div>
          <ul id="orgAll" tabindex="-1"></ul>
          <div class="org-rail" title="click to bring the songs back">songs</div>
        </section>
      </div>
      <footer id="orgFoot">
        <div id="orgPlayRow" class="hidden">
          <button id="orgPlayBtn" class="small" title="play / pause (space)" disabled>▶</button>
          <span id="orgPlayName" class="pack-play-name"></span>
          <div id="orgPlayBar" class="pack-play-bar" title="scrub"><div id="orgPlayHead" class="pack-play-head"></div></div>
          <span id="orgPlayTime" class="pack-play-time"></span>
        </div>
        <span id="orgNote"></span>
      </footer>
    </div>`;
  document.body.appendChild(orgEl);
  orgInitCols();
  orgEl.addEventListener('click', (e) => { if (e.target === orgEl) closeOrganize(); });
  orgEl.querySelector('#orgClose').addEventListener('click', closeOrganize);
  orgEl.querySelector('#orgAdd').addEventListener('click', () => {
    const name = prompt('playlist name:')?.trim();
    if (!name) return;
    const p = { id: libNewId(), name, items: [] };
    libDoc.playlists.push(p);
    orgSelected = p.id;
    saveLibraryDoc();
    orgRender();
  });
  const orgSearchEl = orgEl.querySelector('#orgSearch');
  orgSearchEl.addEventListener('input', (e) => {
    orgQuery = e.target.value.trim().toLowerCase();
    if (orgPane3 === 'disk') orgDiskQueueFind(); // the disk tab searches the whole TREE, like sp
    else orgRenderAll();
  });
  orgSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && orgSearchEl.value) {
      // back out of the search before backing out of the modal
      e.preventDefault();
      e.stopPropagation();
      orgSearchEl.value = '';
      orgQuery = '';
      if (orgPane3 === 'disk') orgDiskFindClear();
      else orgRenderAll();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      // drop into the results, exactly like the pack browser's search
      e.preventDefault();
      if (orgPane3 === 'disk' ? orgDiskRows().length : orgSongHits().length) {
        orgEl.querySelector('#orgAll').focus({ preventScroll: true });
        if (orgPane3 === 'disk') orgDiskStep(1, false); else orgSongStep(1, false);
      }
    }
  });
  const sort = orgEl.querySelector('#orgSort');
  sort.append(new Option('last saved', 'saved'), new Option('name', 'name'));
  sort.addEventListener('change', (e) => {
    orgSort = e.target.value;
    orgRenderAll();
  });
  orgEl.querySelector('#orgTabSongs').addEventListener('click', () => setOrgPane3('songs'));
  orgEl.querySelector('#orgTabDisk').addEventListener('click', () => setOrgPane3('disk'));
  orgEl.querySelector('#orgBrowseUp').addEventListener('click', () => {
    if (orgDisk?.parent) orgBrowseTo(orgDisk.parent);
  });
  orgEl.querySelector('#orgDiskAdd').addEventListener('click', () => orgDiskAddSelected());
  orgEl.querySelector('#orgSongAdd').addEventListener('click', () => orgSongAddSelected());
  orgEl.querySelector('#orgPlayBtn').addEventListener('click', () => orgPlayerToggle());
  const orgBar = orgEl.querySelector('#orgPlayBar');
  const orgBarSeek = (e) => {
    const r = orgBar.getBoundingClientRect();
    if (r.width) orgPlayerSeek((e.clientX - r.left) / r.width);
  };
  orgBar.addEventListener('pointerdown', (e) => { orgBar.setPointerCapture(e.pointerId); orgBarSeek(e); });
  orgBar.addEventListener('pointermove', (e) => { if (e.buttons) orgBarSeek(e); });
  orgEl.querySelector('#orgAll').addEventListener('keydown', orgDiskKeys);
  orgEl.querySelector('#orgAll').addEventListener('keydown', orgSongKeys);
  orgEl.querySelector('#orgItems').addEventListener('keydown', orgItemKeys);
  orgEl.addEventListener('dragend', () => { orgHeld = null; });
  // the empty space under the contents rows appends to the open playlist
  const items = orgEl.querySelector('#orgItems');
  items.addEventListener('dragover', (e) => { if (orgHeld) e.preventDefault(); });
  items.addEventListener('drop', (e) => {
    const p = libDoc.playlists.find((x) => x.id === orgSelected);
    if (!orgHeld || !p) return;
    e.preventDefault();
    if (orgHeld.from === 'items') orgMove(p, orgHeld.index, p.items.length);
    else p.items.push(orgHeld.item);
    orgHeld = null;
    saveLibraryDoc();
    orgRender();
  });
}

function orgMove(p, from, to) {
  const [item] = p.items.splice(from, 1);
  if (item == null) return;
  p.items.splice(from < to ? to - 1 : to, 0, item);
}

/** A deck's picker, on a playlist row: the click selects (below), a double-click loads. */
function orgPickRow(li, item) {
  li.classList.add('org-pick');
  li.addEventListener('dblclick', (e) => { e.preventDefault(); loadDeckSong(orgForDeck, item); });
}

// --- pane 2's selection: the same picking the other two panes do -------------------
//
// By INDEX, not by name: the same song may sit in a playlist twice, and the two slots are two
// different rows. Removing renumbers everything below, so the selection is cleared on any edit
// rather than left pointing a slot too far down.

const orgItemSel = new Set(); // indices into the open playlist
let orgItemAnchor = null;

function orgItemClick(at, e) {
  const p = orgOpenPlaylist();
  if (!p || at >= p.items.length) return;
  if (e.shiftKey && orgItemAnchor != null) {
    if (!(e.metaKey || e.ctrlKey)) orgItemSel.clear();
    const [a, b] = [Math.min(orgItemAnchor, at), Math.max(orgItemAnchor, at)];
    for (let i = a; i <= b; i++) orgItemSel.add(i);
  } else if (e.metaKey || e.ctrlKey) {
    if (orgItemSel.has(at)) orgItemSel.delete(at);
    else orgItemSel.add(at);
    orgItemAnchor = at;
  } else {
    orgItemSel.clear();
    orgItemSel.add(at);
    orgItemAnchor = at;
  }
  // A pick for the deck follows the last row touched, so Enter loads what you just clicked.
  orgPickKey = orgItemSel.size === 1 ? libItemKey(p.items[at]) : null;
  orgRenderItems();
  orgRenderAll(); // the songs pane's own selection is no longer the pick
  orgItemAudition(p.items[at]);
}

/**
 * Selecting a track in a set auditions it, the same gesture the disk tab uses - a playlist is
 * mostly listened through, not read. Only real audio has anything to play: a saved pattern is
 * code, so picking one stops whatever was auditioning rather than leaving it running under a
 * row that has nothing to do with it.
 */
function orgItemAudition(item) {
  if (item != null && libItemIsFile(item) && songFileExists[item.path] !== false) {
    if (item.path !== orgPlayer.abs) orgPlay(item.path, libFileTitle(item));
    return;
  }
  orgPlayerStopSource();
  orgPlayer.abs = null;
  orgRenderTransport();
  orgMarkPlaying();
}

function orgItemStep(delta, extend) {
  const p = orgOpenPlaylist();
  if (!p?.items.length) return;
  const from = orgItemAnchor ?? (delta > 0 ? -1 : p.items.length);
  const to = Math.max(0, Math.min(p.items.length - 1, from + delta));
  if (!extend) orgItemSel.clear();
  orgItemSel.add(to);
  orgItemAnchor = to;
  orgPickKey = libItemKey(p.items[to]);
  orgRenderItems();
  orgRenderAll();
  orgEl.querySelector(`#orgItems li[data-at="${to}"]`)?.scrollIntoView({ block: 'nearest' });
  orgItemAudition(p.items[to]); // ↑/↓ walk the set playing as they go, like the disk tab's
}

/** Slots out of the open playlist. The songs themselves are untouched - this is the set's list. */
function orgItemRemove(at) {
  const p = orgOpenPlaylist();
  if (!p || !at.length) return;
  const gone = at.length === 1 ? null : at.length;
  for (const i of [...at].sort((a, b) => b - a)) p.items.splice(i, 1); // last first, so the rest hold
  orgItemSel.clear();
  orgItemAnchor = null;
  saveLibraryDoc();
  orgRender();
  orgSay(gone ? `removed ${gone} from ${p.name}` : `removed it from ${p.name} - the song itself is still saved`);
}

function orgItemKeys(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    orgItemStep(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    orgItemRemove([...orgItemSel]);
  } else if (e.key === ' ') {
    e.preventDefault();
    orgPlayerToggle();
  } else if (e.key === 'Enter' && orgForDeck) {
    e.preventDefault();
    orgLoadPicked();
  } else {
    return;
  }
  e.stopPropagation();
}

function orgIconBtn(glyph, title, onClick) {
  const b = document.createElement('button');
  b.className = 'small';
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // the row underneath is a selection, not this
    onClick();
  });
  return b;
}

function orgSongSay(name) {
  const p = orgSongs.find((s) => s.name === name);
  return p ? (p.title || p.name) : `${name} (missing)`;
}

// --- pane 1: the playlists ---

function orgRenderLists() {
  const ul = orgEl.querySelector('#orgLists');
  ul.innerHTML = '';
  if (!libDoc.playlists.length) {
    ul.innerHTML = '<li class="org-empty">no playlists yet — + starts one</li>';
    return;
  }
  for (const p of libDoc.playlists) {
    const li = document.createElement('li');
    li.className = p.id === orgSelected ? 'on' : '';
    const star = orgIconBtn(p.id === libDoc.active ? '●' : '○',
      p.id === libDoc.active
        ? "the active set - both decks' pickers list it, and ⏭ steps deck B through it. click to clear"
        : 'make this the active set', () => {
        libDoc.active = libDoc.active === p.id ? null : p.id;
        saveLibraryDoc();
        orgRenderLists();
      });
    star.classList.add('org-star');
    star.classList.toggle('hidden', !mixModeOn); // deck B's set marker - nothing outside DJ mode
    const name = document.createElement('span');
    name.textContent = p.name;
    const count = document.createElement('em');
    count.textContent = p.items.length;
    const rename = orgIconBtn('✎', `rename ${p.name}`, () => {
      const next = prompt('playlist name:', p.name)?.trim();
      if (!next) return;
      p.name = next;
      saveLibraryDoc();
      orgRender();
    });
    const del = orgIconBtn('✕', `delete ${p.name}`, () => {
      if (!confirm(`Delete playlist "${p.name}"? The songs themselves stay.`)) return;
      libDoc.playlists = libDoc.playlists.filter((x) => x.id !== p.id);
      if (libDoc.active === p.id) libDoc.active = null;
      if (orgSelected === p.id) orgSelected = libDoc.playlists[0]?.id ?? null;
      saveLibraryDoc();
      orgRender();
    });
    del.classList.add('org-del');
    li.append(star, name, count, rename, del);
    li.addEventListener('click', () => {
      orgSelected = p.id;
      orgItemSel.clear(); // different playlist, different slots
      orgItemAnchor = null;
      orgRender();
    });
    // dropping a song on a playlist row adds it to the end, whichever list is open
    li.addEventListener('dragover', (e) => {
      if (orgHeld?.from !== 'all') return;
      e.preventDefault();
      li.classList.add('org-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('org-over'));
    li.addEventListener('drop', (e) => {
      li.classList.remove('org-over');
      if (orgHeld?.from !== 'all') return;
      e.preventDefault();
      e.stopPropagation();
      p.items.push(orgHeld.item);
      orgHeld = null;
      saveLibraryDoc();
      orgRender();
    });
    ul.appendChild(li);
  }
}

// --- pane 2: what's in the open playlist ---

function orgRenderItems() {
  const title = orgEl.querySelector('#orgItemsTitle');
  const ul = orgEl.querySelector('#orgItems');
  const p = libDoc.playlists.find((x) => x.id === orgSelected);
  title.textContent = p ? p.name : 'contents';
  ul.innerHTML = '';
  if (!p) {
    ul.innerHTML = '<li class="org-empty">pick a playlist on the left</li>';
    return;
  }
  if (!p.items.length) {
    ul.innerHTML = '<li class="org-empty">empty — drag songs in from the right</li>';
  }
  // A selection that outlived its list (a removal, a different playlist) is dropped rather than
  // left pointing at whatever slid into those slots.
  for (const i of [...orgItemSel]) if (i >= p.items.length) orgItemSel.delete(i);
  p.items.forEach((item, i) => {
    const isFile = libItemIsFile(item);
    const s = isFile ? null : orgSongs.find((x) => x.name === item);
    // Missing for a save = deleted out from under the set; for a file = moved or deleted on
    // disk. Either way the slot stays - the playlist is the user's document.
    const missing = isFile ? songFileExists[item.path] === false : !s;
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.at = i;
    if (orgItemSel.has(i)) li.classList.add('selected');
    li.title = orgForDeck
      ? `click to select · Enter or double-click loads onto deck ${orgForDeck.toUpperCase()} · ⌫ removes it from the playlist`
      : 'click to select (shift/⌘-click for more) · ⌫ removes it from the playlist';
    const n = document.createElement('i');
    n.className = 'org-n';
    n.textContent = i + 1;
    const label = document.createElement('span');
    label.textContent = isFile ? `♪ ${libFileTitle(item)}${missing ? ' (missing)' : ''}` : orgSongSay(item);
    if (isFile) label.title = item.path;
    if (missing) label.className = 'org-missing';
    li.append(n, label);
    const bpmVal = isFile ? item.bpm : s?.bpm;
    if (bpmVal) {
      const bpm = document.createElement('em');
      bpm.className = 'org-bpm';
      bpm.textContent = bpmVal;
      li.appendChild(bpm);
    }
    if (isFile) {
      // A file's title/bpm live on the item itself (its save has no code to carry them) - by
      // hand here until tag parsing (songs phase 4) reads them from the file.
      const edit = orgIconBtn('✎', 'title / native bpm', () => {
        const t = prompt('title:', libFileTitle(item));
        if (t != null && t.trim()) item.title = t.trim();
        const b = prompt('native bpm (blank = unknown):', item.bpm ?? '');
        if (b != null) {
          const num = Number(b);
          if (!b.trim()) delete item.bpm;
          else if (Number.isFinite(num) && num >= 20 && num <= 400) item.bpm = num;
          else logLine('native bpm must be a number from 20 to 400', true);
        }
        saveLibraryDoc();
        orgRender();
      });
      li.appendChild(edit);
    }
    const up = orgIconBtn('↑', 'move up', () => { orgMove(p, i, i - 1); saveLibraryDoc(); orgRender(); });
    const down = orgIconBtn('↓', 'move down', () => { orgMove(p, i, i + 2); saveLibraryDoc(); orgRender(); });
    up.disabled = i === 0;
    down.disabled = i === p.items.length - 1;
    const del = orgIconBtn('✕', 'remove from playlist (⌫)', () => orgItemRemove([i]));
    del.classList.add('org-del');
    if (orgForDeck && !missing) orgPickRow(li, item);
    li.append(up, down, del);
    if (isFile) {
      li.dataset.abs = item.path;
      if (item.path === orgPlayer.abs) li.classList.add('playing');
    }
    li.addEventListener('mousedown', (e) => {
      if (e.detail > 1) return; // the double-click's second press belongs to the dblclick handler
      if (e.target.tagName === 'BUTTON') return; // the row's own ↑ ↓ ✕ are their own gestures
      e.preventDefault();
      ul.focus({ preventScroll: true });
      orgItemClick(i, e);
    });
    li.addEventListener('dragstart', (e) => {
      orgHeld = { from: 'items', item, index: i };
      e.dataTransfer.setData('text/plain', libItemKey(item)); // Firefox won't start a drag without it
    });
    li.addEventListener('dragover', (e) => {
      if (!orgHeld) return;
      e.preventDefault();
      // above or below the midline decides which side of this row it lands
      const box = li.getBoundingClientRect();
      li.classList.toggle('org-before', e.clientY < box.top + box.height / 2);
      li.classList.toggle('org-after', e.clientY >= box.top + box.height / 2);
    });
    li.addEventListener('dragleave', () => li.classList.remove('org-before', 'org-after'));
    li.addEventListener('drop', (e) => {
      const after = li.classList.contains('org-after');
      li.classList.remove('org-before', 'org-after');
      if (!orgHeld) return;
      e.preventDefault();
      e.stopPropagation();
      const at = i + (after ? 1 : 0);
      if (orgHeld.from === 'items') orgMove(p, orgHeld.index, at);
      else p.items.splice(at, 0, orgHeld.item);
      orgHeld = null;
      saveLibraryDoc();
      orgRender();
    });
    ul.appendChild(li);
  });
}

// --- pane 3: every saved song ---

function orgMatches(s) {
  if (!orgQuery) return true;
  const hay = `${s.name} ${s.title || ''}`.toLowerCase();
  const tags = (s.tags ?? []).map((t) => t.toLowerCase());
  return orgQuery.split(/\s+/).every((w) => {
    if (w.startsWith('tag:')) return tags.some((t) => t.includes(w.slice(4)));
    return hay.includes(w) || tags.some((t) => t.includes(w)) || String(s.bpm ?? '').includes(w);
  });
}

function orgRenderAll() {
  const ul = orgEl.querySelector('#orgAll');
  ul.innerHTML = '';
  orgEl.querySelector('#orgTabSongs').classList.toggle('on', orgPane3 === 'songs');
  orgEl.querySelector('#orgTabDisk').classList.toggle('on', orgPane3 === 'disk');
  orgEl.querySelector('#orgDiskBar').classList.toggle('hidden', orgPane3 !== 'disk');
  orgEl.querySelector('#orgSort').classList.toggle('hidden', orgPane3 === 'disk');
  orgEl.querySelector('#orgSongAdd').classList.toggle('hidden', orgPane3 === 'disk');
  if (orgPane3 === 'disk') {
    orgRenderDisk(ul);
    return;
  }
  orgEl.querySelector('#orgSort').value = orgSort;
  const hits = orgSongHits();
  // The ← button reads like the disk tab's: the selection, or nothing to add.
  const addBtn = orgEl.querySelector('#orgSongAdd');
  const nSel = [...orgSongSel].filter((n) => hits.some((s) => s.name === n)).length;
  addBtn.disabled = !orgSelected || !nSel;
  addBtn.textContent = `← add ${nSel > 1 ? nSel : ''}`.trimEnd();
  if (!hits.length) {
    ul.innerHTML = '<li class="org-empty">nothing matches that</li>';
    return;
  }
  for (const s of hits) {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.key = s.name;
    if (orgSongSel.has(s.name)) li.classList.add('selected');
    if (orgForDeck) li.classList.add('org-pick');
    li.title = orgForDeck
      ? `click to select · Enter or double-click loads onto deck ${orgForDeck.toUpperCase()} · ← adds to the open playlist`
      : 'click to select (shift/⌘-click for more) · ← or double-click adds to the open playlist';
    const name = document.createElement('span');
    name.textContent = s.title || s.name;
    li.appendChild(name);
    if (s.bpm) {
      const bpm = document.createElement('em');
      bpm.className = 'org-bpm';
      bpm.textContent = s.bpm;
      li.appendChild(bpm);
    }
    if (s.tags?.length) {
      const chips = document.createElement('span');
      chips.className = 'org-tags';
      for (const t of s.tags) {
        const chip = document.createElement('i');
        chip.textContent = t;
        chips.appendChild(chip);
      }
      li.appendChild(chips);
    }
    const add = orgIconBtn('+', 'add to the open playlist', () => {
      const p = libDoc.playlists.find((x) => x.id === orgSelected);
      if (!p) return;
      p.items.push(s.name);
      saveLibraryDoc();
      orgRender();
    });
    add.disabled = !orgSelected;
    li.appendChild(add);
    li.addEventListener('mousedown', (e) => {
      if (e.detail > 1) return; // the double-click's second press: the dblclick handler has it
      if (e.target.tagName === 'BUTTON') return; // the row's + is its own gesture
      e.preventDefault();
      ul.focus({ preventScroll: true });
      orgSongClick(s.name, e);
    });
    li.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (orgForDeck) loadDeckSong(orgForDeck, s.name);
      else orgSongAddNames([s.name]);
    });
    li.addEventListener('dragstart', (e) => {
      orgHeld = { from: 'all', item: s.name };
      e.dataTransfer.setData('text/plain', s.name);
    });
    ul.appendChild(li);
  }
}

// --- pane 3's songs mode: picking, the disk tab's way ---
//
// Clicking a row SELECTS it (shift-click a range, ⌘-click to toggle, ⌘A for all), ↑/↓ walk the
// list, and ← (or the header's ← add) puts the selection into the open playlist - so a set can be
// built in a few gestures rather than one drag per song. Opened as a deck's picker, the last row
// clicked is what Enter / → deck loads; a click never loads by itself.

const orgSongSel = new Set(); // names
let orgSongAnchor = null; // the end a shift-range extends from

function orgSongHits() {
  const list = orgSort === 'name'
    ? [...orgSongs].sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name))
    : orgSongs; // the API's order: last saved first
  return list.filter(orgMatches);
}

function orgSongClick(name, e) {
  const rows = orgSongHits();
  const at = rows.findIndex((r) => r.name === name);
  if (at < 0) return;
  if (e.shiftKey && orgSongAnchor != null) {
    const from = rows.findIndex((r) => r.name === orgSongAnchor);
    if (!(e.metaKey || e.ctrlKey)) orgSongSel.clear();
    const [a, b] = from < 0 ? [at, at] : [Math.min(from, at), Math.max(from, at)];
    for (let i = a; i <= b; i++) orgSongSel.add(rows[i].name);
  } else if (e.metaKey || e.ctrlKey) {
    if (orgSongSel.has(name)) orgSongSel.delete(name);
    else orgSongSel.add(name);
    orgSongAnchor = name;
  } else {
    orgSongSel.clear();
    orgSongSel.add(name);
    orgSongAnchor = name;
  }
  orgSongAfterSelect(name);
}

function orgSongStep(delta, extend) {
  const rows = orgSongHits();
  if (!rows.length) return;
  const from = rows.findIndex((r) => r.name === orgSongAnchor);
  const to = Math.max(0, Math.min(rows.length - 1, (from < 0 ? (delta > 0 ? -1 : rows.length) : from) + delta));
  if (!extend) orgSongSel.clear();
  orgSongSel.add(rows[to].name);
  orgSongAnchor = rows[to].name;
  orgSongAfterSelect(rows[to].name);
}

function orgSongAfterSelect(name) {
  orgPickKey = name;
  orgRenderItems(); // a pick here unmarks one in the playlist pane
  orgRenderAll();
  orgDiskScrollTo(name);
}

function orgSongAddSelected() {
  orgSongAddNames(orgSongHits().map((s) => s.name).filter((n) => orgSongSel.has(n)));
}

function orgSongAddNames(names) {
  const p = orgOpenPlaylist();
  if (!p || !names.length) return;
  p.items.push(...names);
  saveLibraryDoc();
  orgRender();
  orgSay(`added ${names.length === 1 ? orgSongSay(names[0]) : `${names.length} songs`} to ${p.name}`);
}

function orgSongKeys(e) {
  if (orgPane3 !== 'songs') return;
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    orgSongStep(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  } else if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    for (const s of orgSongHits()) orgSongSel.add(s.name);
    orgRenderAll();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    orgSongAddSelected();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // As a deck's picker Enter loads; as the library editor it adds, like ←.
    if (orgForDeck) orgLoadPicked(); else orgSongAddSelected();
  } else {
    return;
  }
  e.stopPropagation();
}

function orgRender() {
  orgRenderLists();
  orgRenderItems();
  orgRenderAll();
}

// --- pane 3's disk mode (songs phase 2; picking mirrors the sp pack browser) ---
//
// The client can't produce disk paths, so real audio files come in through the server's
// directory listing (GET /api/songfiles), one directory at a time. The disk tab swaps the
// all-songs list for that listing, and picking works exactly like the pack panel's browser:
// clicking a row SELECTS it (and plays it - auditioning is the same gesture as choosing, with
// a transport along the modal's foot), shift-click / ⌘-click select in bulk, ⌘A takes every
// file, ↑/↓ walk the list playing as they go, and ← (or the bar's ← button) inserts the
// selection into the open playlist - folders as every playable file anywhere under them
// (GET /api/songfiles/find). A folder is selected with one click and entered with two; the
// search box searches the whole tree under the open folder, like sp's. Drag and the per-row +
// still work as before. The listing sticks around per session, so flipping tabs doesn't lose
// your place.

let orgPane3 = 'songs'; // 'songs' (every saved pattern) | 'disk' (the file browser)
let orgDisk = null; // the last GET /api/songfiles listing ({ dir, parent, entries })
let orgBrowseDir = null; // remembered for the session; the server starts at ~/Music

// Selection in the disk list: keys "d:name" / "f:name" ("f:<relative path>" while searching),
// plus the row the last plain click or arrow landed on (the end a shift-range extends from).
const orgDiskSel = new Set();
let orgDiskAnchor = null;
// The tree search (mirroring packFind): while `query` is set the list shows matches from
// anywhere under the folder instead of the folder itself.
let orgDiskFind = { query: '', running: false, files: [], matched: 0, total: 0, truncated: false, seq: 0 };
let orgDiskFindTimer = null;
const orgWalks = new Map(); // folder path -> { at, walk } - every playable file under it, briefly held
const ORG_FIND_DEBOUNCE_MS = 200;
const ORG_FIND_SHOW = 500;
const ORG_WALK_LIMIT = 20000;
const ORG_WALK_TTL_MS = 30000;
function orgSay(text, isError = false) {
  const note = orgEl?.querySelector('#orgNote');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('error', !!isError);
}

function setOrgPane3(mode) {
  orgPane3 = mode;
  if (mode === 'disk') {
    if (!orgDisk) orgBrowseTo(orgBrowseDir);
    if (orgEl.querySelector('#orgSearch').value.trim()) orgDiskQueueFind();
  }
  orgRenderAll();
}

async function orgBrowseTo(dir) {
  try {
    orgDisk = await api('GET', `/api/songfiles${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
    orgBrowseDir = orgDisk.dir;
    orgDiskSel.clear(); // a selection is of rows in THIS folder
    orgDiskAnchor = null;
    const search = orgEl?.querySelector('#orgSearch');
    if (orgPane3 === 'disk' && search?.value) {
      search.value = ''; // a search is of THIS folder's tree; going somewhere ends it
      orgQuery = '';
    }
    orgDiskFindClear(false);
    orgRenderAll();
  } catch (e) {
    logLine(e.message ?? String(e), true);
    if (dir) orgBrowseTo(null); // the remembered directory is gone - back to the default
  }
}

// --- the disk list's rows + selection (packRows / packSelectClick / packSelectStep, mirrored) ---

const orgDiskFindActive = () => orgDiskFind.query !== '';

function orgDiskRows() {
  if (!orgDisk) return [];
  const dir = orgDisk.dir;
  if (orgDiskFindActive()) {
    return orgDiskFind.files.map((rel) => ({ key: `f:${rel}`, abs: `${dir}/${rel}`, name: rel, kind: 'file' }));
  }
  return orgDisk.entries.map((ent) => (ent.dir
    ? { key: `d:${ent.name}`, abs: ent.path, name: ent.name, kind: 'dir' }
    : { key: `f:${ent.name}`, abs: ent.path, name: ent.name, kind: 'file' }));
}

function orgDiskClick(key, e) {
  const rows = orgDiskRows();
  const at = rows.findIndex((r) => r.key === key);
  if (at < 0) return;
  if (e.shiftKey && orgDiskAnchor != null) {
    const from = rows.findIndex((r) => r.key === orgDiskAnchor);
    if (!(e.metaKey || e.ctrlKey)) orgDiskSel.clear();
    const [a, b] = from < 0 ? [at, at] : [Math.min(from, at), Math.max(from, at)];
    for (let i = a; i <= b; i++) orgDiskSel.add(rows[i].key);
  } else if (e.metaKey || e.ctrlKey) {
    if (orgDiskSel.has(key)) orgDiskSel.delete(key);
    else orgDiskSel.add(key);
    orgDiskAnchor = key;
  } else {
    orgDiskSel.clear();
    orgDiskSel.add(key);
    orgDiskAnchor = key;
  }
  orgDiskAfterSelect(rows[at]);
}

function orgDiskStep(delta, extend) {
  const rows = orgDiskRows();
  if (!rows.length) return;
  const from = rows.findIndex((r) => r.key === orgDiskAnchor);
  const to = Math.max(0, Math.min(rows.length - 1, (from < 0 ? (delta > 0 ? -1 : rows.length) : from) + delta));
  if (!extend) orgDiskSel.clear();
  orgDiskSel.add(rows[to].key);
  orgDiskAnchor = rows[to].key;
  orgDiskAfterSelect(rows[to]);
}

/** ⌘A: every file (folders are a different kind of thing to add). Plays the last, so something is heard. */
function orgDiskSelectAll() {
  const rows = orgDiskRows().filter((r) => r.kind === 'file');
  if (!rows.length) return;
  orgDiskSel.clear();
  for (const r of rows) orgDiskSel.add(r.key);
  orgDiskAnchor = rows[rows.length - 1].key;
  orgDiskAfterSelect(rows[rows.length - 1]);
}

function orgDiskAfterSelect(row) {
  orgRenderAll();
  orgDiskScrollTo(row.key);
  if (row.kind === 'file') orgPlay(row.abs, row.name);
  else orgDescribeFolder(row.abs, row.name);
}

function orgDiskScrollTo(key) {
  const box = orgEl.querySelector('#orgAll');
  const el = [...box.children].find((c) => c.dataset.key === String(key));
  if (!el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

// --- folders as whole trees, and the tree search (packWalk / packFind, mirrored) ---

const orgFindFetch = (dir, q, limit) =>
  api('GET', `/api/songfiles/find?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}&limit=${limit}`);

function orgWalk(dir) {
  const hit = orgWalks.get(dir);
  if (hit && Date.now() - hit.at < ORG_WALK_TTL_MS) return hit.walk;
  const walk = orgFindFetch(dir, '', ORG_WALK_LIMIT)
    .then((r) => ({ path: r.path, files: r.files ?? [], truncated: !!r.truncated }))
    .catch((err) => { orgWalks.delete(dir); throw err; }); // a failed walk must not stick
  orgWalks.set(dir, { at: Date.now(), walk });
  return walk;
}

async function orgDescribeFolder(abs, name) {
  try {
    const { files, truncated } = await orgWalk(abs);
    if (!orgDiskSel.has(`d:${name}`)) return;
    const deep = files.some((f) => f.includes('/'));
    orgSay(`${name} · ${files.length}${truncated ? '+' : ''} playable file${files.length === 1 ? '' : 's'}${deep ? ', subfolders and all' : ''} · ← adds them all, double-click goes in`);
  } catch { /* the walk failed - the add will say so */ }
}

function orgDiskFindClear(render = true) {
  clearTimeout(orgDiskFindTimer);
  orgDiskFindTimer = null;
  orgDiskFind = { query: '', running: false, files: [], matched: 0, total: 0, truncated: false, seq: orgDiskFind.seq + 1 };
  orgDiskSel.clear();
  orgDiskAnchor = null;
  if (render) orgRenderAll();
}

function orgDiskQueueFind() {
  const q = orgEl.querySelector('#orgSearch').value.trim();
  clearTimeout(orgDiskFindTimer);
  if (!q) return orgDiskFindClear();
  orgDiskFind.query = q;
  orgDiskFind.running = true;
  orgDiskFindTimer = setTimeout(() => orgDiskRunFind(q), ORG_FIND_DEBOUNCE_MS);
  orgRenderAll();
}

async function orgDiskRunFind(q) {
  const dir = orgDisk?.dir;
  if (dir == null) return;
  const seq = ++orgDiskFind.seq;
  try {
    const r = await orgFindFetch(dir, q, ORG_FIND_SHOW);
    if (seq !== orgDiskFind.seq) return; // a later keystroke owns the list now
    Object.assign(orgDiskFind, { files: r.files ?? [], matched: r.matched ?? 0, total: r.total ?? 0, truncated: !!r.truncated });
  } catch (err) {
    if (seq !== orgDiskFind.seq) return;
    Object.assign(orgDiskFind, { files: [], matched: 0, total: 0, truncated: false });
    orgSay(err.message ?? String(err), true);
  }
  orgDiskFind.running = false;
  orgDiskSel.clear(); // the rows underneath the selection just changed
  orgDiskAnchor = null;
  orgRenderAll();
}

function orgDiskFindNote() {
  if (!orgDiskFindActive()) return '';
  if (orgDiskFind.running && !orgDiskFind.files.length) return 'searching…';
  const parts = [orgDiskFind.matched
    ? `${orgDiskFind.matched} of ${orgDiskFind.total} files match`
    : `no match in ${orgDiskFind.total} files`];
  if (orgDiskFind.matched > orgDiskFind.files.length) parts.push(`first ${orgDiskFind.files.length} shown`);
  if (orgDiskFind.truncated) parts.push('big tree, searched part of it');
  return parts.join(' · ');
}

// --- inserting the selection (packAddSelected, mirrored onto playlist items) ---

const orgOpenPlaylist = () => libDoc.playlists.find((x) => x.id === orgSelected) ?? null;
const orgDiskItem = (abs) => ({ kind: 'file', path: abs, title: abs.split('/').pop().replace(/\.[^.]+$/, '') });

/** Paths already in the open playlist - the rows' ✓ marks, and what a bulk add skips. */
function orgDiskHave() {
  const p = orgOpenPlaylist();
  return new Set((p?.items ?? []).filter(libItemIsFile).map((it) => it.path));
}

// A bulk insert skips what the playlist already holds (adding a folder twice must not double
// the set); a deliberate replay of a track still goes in by drag or the row's + button.
function orgDiskAddPaths(paths) {
  const p = orgOpenPlaylist();
  if (!p) return orgSay('pick a playlist on the left first', true);
  const have = orgDiskHave();
  const added = paths.filter((abs) => !have.has(abs));
  for (const abs of added) p.items.push(orgDiskItem(abs));
  if (!added.length) return orgSay('already in the playlist');
  saveLibraryDoc();
  orgRender();
  orgSay(`added ${added.length === 1 ? added[0].split('/').pop() : `${added.length} files`} to ${p.name}`);
}

/**
 * ← / the bar's add button: the selection into the open playlist - files as they are, folders
 * as every playable file anywhere under them. Nothing selected means the whole folder on
 * screen, or, while searching, every match (including the ones past the rows drawn).
 */
async function orgDiskAddSelected() {
  const rows = orgDiskRows();
  const picked = rows.filter((r) => orgDiskSel.has(r.key));
  if (!picked.length && orgDiskFindActive()) {
    try {
      const r = await orgFindFetch(orgDisk.dir, orgDiskFind.query, ORG_WALK_LIMIT);
      const all = (r.files ?? []).map((f) => `${r.path}/${f}`);
      if (!all.length) return orgSay('nothing matches', true);
      return orgDiskAddPaths(all);
    } catch (err) {
      return orgSay(err.message ?? String(err), true);
    }
  }
  const chosen = picked.length ? picked : rows.filter((r) => r.kind === 'file');
  const paths = [];
  let clipped = false;
  for (const r of chosen) {
    if (r.kind === 'file') { paths.push(r.abs); continue; }
    try {
      const { path: dir, files, truncated } = await orgWalk(r.abs);
      paths.push(...files.map((f) => `${dir}/${f}`));
      clipped ||= truncated;
    } catch (err) {
      orgSay(err.message ?? String(err), true);
    }
  }
  if (!paths.length) return orgSay('nothing to add here', true);
  orgDiskAddPaths(paths);
  if (clipped) orgSay(`that is a big tree — took the first ${paths.length} files`, true);
}

// --- the keys the focused list answers to (packListKeys, mirrored) ---

function orgDiskKeys(e) {
  if (orgPane3 !== 'disk') return;
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    orgDiskStep(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  } else if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    orgDiskSelectAll();
  } else if (e.key === ' ') {
    e.preventDefault();
    orgPlayerToggle();
  } else if (e.key === 'ArrowLeft' || e.key === 'Enter') {
    e.preventDefault();
    // Enter on one folder goes in (the folder is what a lone selection mostly is); otherwise it adds.
    const sel = [...orgDiskSel];
    if (e.key === 'Enter' && sel.length === 1 && String(sel[0]).startsWith('d:')) orgBrowseTo(`${orgDisk.dir}/${String(sel[0]).slice(2)}`);
    else orgDiskAddSelected();
  } else {
    return;
  }
  e.stopPropagation();
}

// --- the preview player (the pack panel's, mirrored onto /api/songAudio) ---
// One file at a time, played whole from the moment it is selected, with a transport along the
// modal's foot. The endpoint hands the browser bytes it can decode itself (aiff/caf take the
// deck's afconvert cache server-side), so mp3s and m4as preview as readily as wavs.

const orgPlayer = { abs: null, name: '', buffer: null, source: null, startedAt: 0, offset: 0, playing: false, raf: null, gen: 0 };
const orgBuffers = new Map(); // abs -> decoded AudioBuffer, so walking back up a list is instant
const ORG_BUFFER_CACHE = 24; // whole songs, not one-shots - keep fewer than the pack panel does

async function orgLoadBuffer(abs) {
  if (orgBuffers.has(abs)) return orgBuffers.get(abs);
  previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  const res = await fetch(`/api/songAudio?file=${encodeURIComponent(abs)}`);
  if (!res.ok) throw new Error(`can't read ${abs.split('/').pop()} (${res.status})`);
  const buf = await previewCtx.decodeAudioData(await res.arrayBuffer());
  if (orgBuffers.size >= ORG_BUFFER_CACHE) orgBuffers.delete(orgBuffers.keys().next().value);
  orgBuffers.set(abs, buf);
  return buf;
}

async function orgPlay(abs, name) {
  const blocked = auditionBlocked();
  if (blocked) { orgPlayerStopSource(); return orgSay(blocked, true); }
  const gen = ++orgPlayer.gen;
  orgPlayerStopSource();
  Object.assign(orgPlayer, { abs, name, buffer: null, offset: 0 });
  orgRenderTransport();
  orgMarkPlaying();
  try {
    const buf = await orgLoadBuffer(abs);
    if (gen !== orgPlayer.gen) return; // a newer pick superseded this one while it decoded
    orgPlayer.buffer = buf;
    orgPlayerStart(0);
  } catch (e) {
    if (gen === orgPlayer.gen) orgSay(e.message ?? String(e), true);
  }
}

function orgPlayerStopSource() {
  if (orgPlayer.source) {
    const src = orgPlayer.source;
    orgPlayer.source = null;
    src.onended = null;
    try { src.stop(); } catch { /* already ended */ }
  }
  orgPlayer.playing = false;
  cancelAnimationFrame(orgPlayer.raf);
}

function orgPlayerStart(offset) {
  const buf = orgPlayer.buffer;
  if (!buf) return;
  const blocked = auditionBlocked(); // DJ mode may have come on since this buffer was decoded
  if (blocked) return orgSay(blocked, true);
  orgPlayerStopSource();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {});
  const at = Math.max(0, Math.min(offset, buf.duration));
  const src = previewCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewCtx.destination);
  src.start(0, at);
  Object.assign(orgPlayer, { source: src, startedAt: previewCtx.currentTime - at, offset: at, playing: true });
  src.onended = () => {
    if (orgPlayer.source !== src) return;
    orgPlayer.source = null;
    orgPlayer.playing = false;
    orgPlayer.offset = 0;
    orgRenderTransport();
  };
  orgPlayerTick();
}

const orgPlayerPosition = () => (orgPlayer.playing ? previewCtx.currentTime - orgPlayer.startedAt : orgPlayer.offset);

function orgPlayerPause() {
  if (!orgPlayer.playing) return;
  orgPlayer.offset = orgPlayerPosition();
  orgPlayerStopSource();
  orgRenderTransport();
}

function orgPlayerToggle() {
  if (!orgPlayer.buffer) return;
  if (orgPlayer.playing) orgPlayerPause();
  else orgPlayerStart(orgPlayer.offset >= orgPlayer.buffer.duration - 0.01 ? 0 : orgPlayer.offset);
}

function orgPlayerSeek(frac) {
  if (!orgPlayer.buffer) return;
  orgPlayer.offset = Math.max(0, Math.min(1, frac)) * orgPlayer.buffer.duration;
  if (orgPlayer.playing) orgPlayerStart(orgPlayer.offset);
  else orgRenderTransport();
}

function orgPlayerTick() {
  cancelAnimationFrame(orgPlayer.raf);
  orgRenderTransport();
  if (orgPlayer.playing) orgPlayer.raf = requestAnimationFrame(orgPlayerTick);
}

function orgRenderTransport() {
  if (!orgEl) return;
  const row = orgEl.querySelector('#orgPlayRow');
  row.classList.toggle('hidden', !orgPlayer.abs);
  const d = orgPlayer.buffer?.duration ?? 0;
  const pos = Math.min(d, Math.max(0, orgPlayerPosition()));
  orgEl.querySelector('#orgPlayBtn').textContent = orgPlayer.playing ? '❚❚' : '▶';
  orgEl.querySelector('#orgPlayBtn').disabled = !orgPlayer.buffer;
  const nameEl = orgEl.querySelector('#orgPlayName');
  nameEl.textContent = orgPlayer.name;
  nameEl.title = orgPlayer.abs ?? '';
  orgEl.querySelector('#orgPlayHead').style.width = d ? `${(pos / d) * 100}%` : '0%';
  orgEl.querySelector('#orgPlayTime').textContent = d ? `${songFmt(pos, true)} / ${songFmt(d)}` : '';
}

/** The row that IS the playing file lights up without a redraw. */
function orgMarkPlaying() {
  if (!orgEl) return;
  // Both lists hold auditionable rows now - the disk tab's files and a set's own tracks.
  for (const list of ['#orgAll', '#orgItems']) {
    for (const el of orgEl.querySelector(list).children) {
      if (el.dataset.abs == null) continue;
      el.classList.toggle('playing', el.dataset.abs === orgPlayer.abs);
    }
  }
}

function orgRenderDisk(ul) {
  const pathEl = orgEl.querySelector('#orgBrowsePath');
  const up = orgEl.querySelector('#orgBrowseUp');
  const addBtn = orgEl.querySelector('#orgDiskAdd');
  if (!orgDisk) {
    ul.innerHTML = '<li class="org-empty">reading…</li>';
    addBtn.disabled = true;
    return;
  }
  pathEl.textContent = orgDisk.dir;
  pathEl.title = orgDisk.dir;
  up.disabled = !orgDisk.parent;
  const rows = orgDiskRows();
  const finding = orgDiskFindActive();
  if (finding) orgSay(orgDiskFindNote());
  // The bar's ← reads like the pack panel's: the selection, or everything on screen.
  const nSel = orgDiskSel.size;
  const nFiles = finding ? orgDiskFind.matched : rows.filter((r) => r.kind === 'file').length;
  addBtn.disabled = !orgSelected || (!nSel && !nFiles);
  addBtn.textContent = nSel ? `← add ${nSel > 1 ? nSel : ''}`.trimEnd() : `← add all ${nFiles}`;
  addBtn.title = nSel
    ? 'add the selection to the open playlist (←)'
    : finding ? 'add every file that matches, wherever it is (←)' : 'add every playable file in this folder (←)';
  if (!rows.length) {
    ul.innerHTML = `<li class="org-empty">${finding
      ? (orgDiskFind.running ? 'searching…' : `nothing under here matches "${orgDiskFind.query}"`)
      : 'nothing playable in here'}</li>`;
    return;
  }
  const have = orgDiskHave();
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.key = row.key;
    li.dataset.abs = row.abs;
    const selected = orgDiskSel.has(row.key);
    if (selected) li.classList.add('selected');
    const name = document.createElement('span');
    if (row.kind === 'dir') {
      name.textContent = `▸ ${row.name}`;
    } else {
      // A search hit's name is its path from here: the folders it sits in read quieter than
      // the file (the pack browser's has-path rendering, reused classes and all).
      const cut = row.name.lastIndexOf('/');
      if (cut < 0) {
        name.textContent = `♪ ${row.name}`;
      } else {
        const where = document.createElement('span');
        where.className = 'pack-file-dir';
        where.textContent = `♪ ${row.name.slice(0, cut + 1)}`;
        const base = document.createElement('span');
        base.className = 'pack-file-base';
        base.textContent = row.name.slice(cut + 1);
        name.append(where, base);
      }
    }
    li.appendChild(name);
    if (row.kind === 'dir') {
      li.classList.add('org-browse-dir');
      li.title = 'click to select (← adds everything in it) · double-click to go in';
      li.addEventListener('dblclick', (e) => { e.preventDefault(); orgBrowseTo(row.abs); });
    } else {
      if (have.has(row.abs)) li.classList.add('org-added'); // the ✓ - already in the open playlist
      if (row.abs === orgPlayer.abs) li.classList.add('playing');
      li.title = `${row.abs}\nclick to hear and select · ← (or double-click) adds to the open playlist`;
      li.draggable = true;
      const add = orgIconBtn('+', 'add to the open playlist (a replay of a track goes in even when it is already there)', () => {
        const p = orgOpenPlaylist();
        if (!p) return;
        p.items.push(orgDiskItem(row.abs));
        saveLibraryDoc();
        orgRender();
      });
      add.disabled = !orgSelected;
      li.appendChild(add);
      li.addEventListener('dblclick', (e) => { e.preventDefault(); orgDiskAddPaths([row.abs]); });
      li.addEventListener('dragstart', (e) => {
        orgHeld = { from: 'all', item: orgDiskItem(row.abs) };
        e.dataTransfer.setData('text/plain', row.abs);
      });
    }
    li.addEventListener('mousedown', (e) => {
      if (e.detail > 1) return; // the double-click's second press: the dblclick handler has it
      if (e.target.tagName === 'BUTTON') return; // the row's + is its own gesture
      e.preventDefault();
      ul.focus({ preventScroll: true });
      orgDiskClick(row.key, e);
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------------------------
// Snippets - a phrase kept for re-use, and everything it needs to play.
//
// The ★ library generalises one DEFINITION across projects: a roll, a shape, a preset, a pack. What
// it can't hold is the code between them - the four-line acid bass, the sidechain-pump chain, the
// dub-delay send. Reusing one of those meant loading the old patch, copying the lines, loading
// yours back, and finding the paste broken: the lines said `pianoroll("bass")` and the notes stayed
// behind in the other file.
//
// So a snippet carries its sidecar. Select code, right-click, name it; the definitions the
// selection NAMES are copied in beside it (see snippetCarriesFor) - including ones that live in the
// ★ library, so unpinning something later can never break a snippet made before. Putting one back
// writes the body where you clicked and files the definitions in the block at the bottom of the
// buffer, the same place every other definition goes.
//
// The gesture is the right-click rather than a hotkey for three reasons: it is discoverable, it
// already carries WHERE (which is the one argument insertion needs), and the menu has room to grow.
// ctrl+J is the same two entry points from the keyboard, for when the mouse is on a knob.
//
// The collision rules - what happens when a snippet's `bass` meets a buffer that has one - live in
// public/snippet-code.js and are unit-tested there. This file's job is reading them off the buffer
// and writing the answer back.
// ---------------------------------------------------------------------------------------------

const snippetSaveBackdrop = document.getElementById('snippetSaveBackdrop');
const snippetSaveNameEl = document.getElementById('snippetSaveName');
const snippetSaveTagsEl = document.getElementById('snippetSaveTags');
const snippetSaveCarriesEl = document.getElementById('snippetSaveCarries');
const snippetSaveNote = document.getElementById('snippetSaveNote');
const snippetSaveConfirm = document.getElementById('snippetSaveConfirm');
const snippetBrowseBackdrop = document.getElementById('snippetBrowseBackdrop');
const snippetBrowseSearch = document.getElementById('snippetBrowseSearch');
const snippetBrowseList = document.getElementById('snippetBrowseList');
const snippetBrowseCarriesEl = document.getElementById('snippetBrowseCarries');
const snippetBrowseNote = document.getElementById('snippetBrowseNote');
const snippetBrowseInsert = document.getElementById('snippetBrowseInsert');
const editorMenu = document.getElementById('editorMenu');

// The drag type the browser's rows carry. text/plain rides along too, so CodeMirror draws its own
// drop cursor as the pointer crosses the code; this private one is how the drop handler knows the
// text has a sidecar to file with it rather than being a plain paste.
const SNIPPET_DND = 'application/x-poptart-snippet';

let snippetSaveState = null; // { ed, carries: [{ kind, id, scope, code, why, off }], names }
let snippetBrowseState = null; // { ed, at, entries, sel, pinned, unlocked, dirty }
let snippetSaveCM = null;
let snippetBrowseCM = null;

// --------------------------------------------------------------------------------- what it carries

/**
 * Every definition the code in [from, to) NAMES, in the order it names them.
 *
 * Read against the WHOLE buffer and then filtered to the calls inside the selection - because a
 * preset's owner is the plugin at the end of its block (see presetTargetAt), so a selected
 * `.preset("growl")` whose `.synth("Serum 2")` sits just above the selection still belongs to
 * Serum. Cutting the text out first and parsing that would lose the owner.
 */
function snippetRefsIn(code, from, to) {
  const out = [];
  const seen = new Set();
  for (const reg of DEF_REGISTRIES) {
    for (const call of reg.idCalls(code)) {
      if (call.start < from || call.close >= to) continue;
      for (const id of idsNamedIn(call.str)) {
        const scope = call.scope ?? '';
        const key = `${reg.kind} ${id} ${reg.kind === 'preset' ? scope : ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ reg, kind: reg.kind, id, scope });
      }
    }
  }
  return out;
}

/**
 * Those definitions as code to write into the snippet file. The buffer's own are read straight off
 * it; anything else is a library name, and the server is asked for its source - the browser knows
 * the library's NAMES but has no source for them (openRollById says as much when you try to open a
 * prebake roll). A name nothing can produce a definition for comes back carrying `why`, and shows
 * struck through in the dialog rather than being quietly dropped.
 */
async function snippetCarriesFor(code, from, to) {
  const carries = [];
  const ask = [];
  for (const r of snippetRefsIn(code, from, to)) {
    const def = r.reg.findDef(code, r.id, r.scope);
    if (def) {
      carries.push({ kind: r.kind, id: r.id, scope: def.scope ?? '', code: code.slice(def.start, def.close + 1) });
    } else {
      carries.push({ kind: r.kind, id: r.id, scope: r.scope, code: null, pending: true });
      ask.push({ kind: r.kind, id: r.id, scope: r.scope });
    }
  }
  if (!ask.length) return carries;
  let found = [];
  try {
    ({ defs: found } = await api('POST', '/api/snippets/resolveDefs', { want: ask }));
  } catch (e) {
    logLine(`couldn't look up the library definitions this names: ${e.message ?? e}`, true);
  }
  for (const c of carries) {
    if (!c.pending) continue;
    delete c.pending;
    const hit = found.find((d) => d.kind === c.kind && d.id === c.id);
    c.code = hit?.code ?? null;
    c.scope = hit?.scope ?? c.scope;
    if (!c.code) c.why = hit?.why ?? `nothing defines the ${c.kind} "${c.id}" to copy`;
  }
  return carries;
}

/** The chip row both dialogs show: one per definition riding along, droppable in the save dialog. */
function renderSnippetCarries(el, carries, { onToggle = null } = {}) {
  el.innerHTML = '';
  for (const c of carries) {
    const chip = document.createElement('span');
    chip.className = `snippet-chip${c.off || !c.code ? ' off' : ''}`;
    const kind = document.createElement('span');
    kind.textContent = `${c.kind} `;
    const name = document.createElement('b');
    name.textContent = c.id;
    chip.append(kind, name);
    if (c.scope) {
      const owner = document.createElement('span');
      owner.textContent = ` · ${c.scope}`;
      chip.appendChild(owner);
    }
    // The definition itself on hover - which is where the SIZE of a captured program shows up,
    // so a snippet about to carry one says so rather than surprising you with the file.
    chip.title = c.code
      ? (c.code.length > 300 ? `${c.code.slice(0, 300)}…` : c.code)
      : (c.why ?? "this one can't be carried");
    if (onToggle && c.code) {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = c.off ? '+' : '✕';
      x.title = c.off ? 'carry this one after all' : "don't carry this one";
      x.addEventListener('click', () => onToggle(c));
      chip.appendChild(x);
    }
    el.appendChild(chip);
  }
}

// ------------------------------------------------------------------------------------- saving one

function ensureSnippetSaveCM() {
  if (!snippetSaveCM) {
    snippetSaveCM = CodeMirror.fromTextArea(document.getElementById('snippetSaveEditor'), {
      mode: { name: 'javascript' },
      theme: 'poptart',
      keyMap: 'sublime',
      matchBrackets: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Cmd-Enter': saveSnippet,
        'Ctrl-Enter': saveSnippet,
        'Cmd-S': saveSnippet,
        'Ctrl-S': saveSnippet,
      },
    });
  }
  return snippetSaveCM;
}

function setSnippetSaveNote(text, isError = false) {
  snippetSaveNote.textContent = text;
  snippetSaveNote.classList.toggle('error', !!isError);
  snippetSaveNote.classList.toggle('warn', !isError && !!text);
}

/** The name to offer: what the selection's first block calls itself. */
function suggestedSnippetName(body) {
  const label = (/^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:(?!:)/m.exec(body) ?? [])[1] ?? '';
  return label === '$' ? '' : label.replace(/^[_S](?=[A-Za-z_$])/, '').toLowerCase();
}

async function openSnippetSave(ed = activeCM()) {
  const code = ed.getValue();
  const from = ed.indexFromPos(ed.getCursor('from'));
  const to = ed.indexFromPos(ed.getCursor('to'));
  const body = code.slice(from, to).replace(/^\s*\n|\s+$/g, '');
  if (!body.trim()) {
    logLine('select the code you want to keep first - a snippet is a piece of a patch, not the whole buffer', true);
    return;
  }
  const state = { ed, carries: [], names: new Set(), loading: true };
  snippetSaveState = state;
  const box = ensureSnippetSaveCM();
  box.setValue(body);
  snippetSaveNameEl.value = suggestedSnippetName(body);
  snippetSaveTagsEl.value = '';
  snippetSaveCarriesEl.innerHTML = '';
  snippetSaveBackdrop.classList.remove('hidden');
  box.refresh(); // laid out while hidden - size it now that it is visible
  snippetSaveNameEl.focus();
  snippetSaveNameEl.select();
  syncSnippetSaveState(); // down, and saying so, until the lookups below land

  // The two lookups the dialog needs, together: what rides along, and which names are taken.
  const [carries, names] = await Promise.all([
    snippetCarriesFor(code, from, to),
    api('GET', '/api/snippets?q=').then((r) => new Set((r.snippets ?? []).map((s) => s.name))).catch(() => new Set()),
  ]);
  if (snippetSaveState !== state) return; // superseded while we were away
  state.carries = carries;
  state.names = names;
  state.loading = false;
  drawSnippetSaveCarries();
  syncSnippetSaveState();
}

function drawSnippetSaveCarries() {
  renderSnippetCarries(snippetSaveCarriesEl, snippetSaveState?.carries ?? [], {
    onToggle: (c) => { c.off = !c.off; drawSnippetSaveCarries(); syncSnippetSaveState(); },
  });
}

// The save button carries its own reason for being off, the way the pattern naming dialog does - a
// disabled button that says why beats a request that comes back refused.
function syncSnippetSaveState() {
  if (!snippetSaveState) return;
  const name = snippetSaveNameEl.value.trim();
  const problem = patternNameProblem(name);
  const lost = snippetSaveState.carries.filter((c) => !c.code);
  // `loading` keeps the button down while the sidecar is still being worked out - typing a name
  // must not be a way past that, or the code gets kept with its definitions left behind.
  snippetSaveConfirm.disabled = !!problem || snippetSaveState.loading;
  const collides = !problem && snippetSaveState.names.has(name);
  snippetSaveConfirm.textContent = collides ? 'overwrite' : 'save';
  if (problem) return setSnippetSaveNote(problem, true);
  if (snippetSaveState.loading) return setSnippetSaveNote('reading what this names…');
  if (collides) return setSnippetSaveNote(`"${name}" already exists - saving replaces it`);
  if (lost.length) {
    const s = lost.length === 1 ? '' : 's';
    return setSnippetSaveNote(`${lost.length} name${s} couldn't be copied in - see the struck-through chip${s}`);
  }
  setSnippetSaveNote('');
}

async function saveSnippet() {
  if (!snippetSaveState || snippetSaveConfirm.disabled) return;
  const name = snippetSaveNameEl.value.trim();
  const defs = snippetSaveState.carries.filter((c) => c.code && !c.off);
  snippetSaveConfirm.disabled = true;
  setSnippetSaveNote('saving…');
  try {
    await api('POST', '/api/snippets/save', {
      name,
      tags: snippetSaveTagsEl.value,
      body: ensureSnippetSaveCM().getValue(),
      defs: defs.map(({ kind, id, scope, code }) => ({ kind, id, scope, code })),
    });
    closeSnippetSave();
    const rode = defs.length ? ` (carrying ${defs.map((d) => `${d.kind} "${d.id}"`).join(', ')})` : '';
    logLine(`kept snippet "${name}"${rode}`);
  } catch (e) {
    // No `finally`: a save that worked has already closed the dialog, and re-enabling the button
    // there would only overwrite the message this one leaves on it.
    snippetSaveConfirm.disabled = false;
    setSnippetSaveNote(e.message ?? String(e), true);
    logLine(e.message ?? String(e), true);
  }
}

function closeSnippetSave() {
  snippetSaveBackdrop.classList.add('hidden');
  const ed = snippetSaveState?.ed;
  snippetSaveState = null;
  ed?.focus();
}

// -------------------------------------------------------------------------------- putting one back

/** Does the shared library hold this name? A buffer definition of it would shadow that one. */
function snippetLibraryHas(kind, id, scope) {
  const reg = DEF_REGISTRIES.find((r) => r.kind === kind);
  // Asked against an EMPTY buffer, so allIds answers with the library alone.
  return !!reg && reg.allIds(null, '').some((r) => r.id === id
    && (kind !== 'preset' || !r.scope || !scope || r.scope === scope));
}

/** Every definition already in `code`, flattened across the kinds, as planInjection wants them. */
function snippetBufferDefs(code) {
  const out = [];
  for (const reg of DEF_REGISTRIES) {
    for (const d of reg.defsInBuffer(code)) {
      out.push({ kind: reg.kind, id: d.id, scope: d.scope ?? '', code: code.slice(d.start, d.close + 1) });
    }
  }
  return out;
}

/** The spans of the id STRINGS inside a snippet body - what a rename has to rewrite. */
function snippetBodyIdCalls(body) {
  const out = [];
  for (const reg of DEF_REGISTRIES) {
    for (const call of reg.idCalls(body)) {
      out.push({ kind: reg.kind, from: call.from, to: call.to, scope: call.scope ?? '' });
    }
  }
  return out;
}

/** The block labels `code` already uses - a snippet's own `bass:` must not land on top of one. */
function snippetBufferLabels(code) {
  if (!labelsMod) return [];
  return labelsMod.splitLabeledBlocks(code).map((b) => b.label).filter(Boolean);
}

/**
 * Puts a snippet into `ed` at `at` (the caret when null), definitions and all.
 *
 * The library's own copies of the names it carries are fetched first and handed to planInjection
 * alongside the buffer's, so a definition that is still exactly what it was resolves against the
 * library instead of being filed a second time - and one that has DRIFTED is filed under a fresh
 * name rather than quietly playing something else.
 */
async function insertSnippet(entry, ed = activeCM(), at = null) {
  const code = ed.getValue();
  const carried = (entry.carries ?? []).filter((c) => c.code);
  // Only the carried names the library holds; the rest cannot collide with it by definition.
  const ask = carried
    .filter((c) => snippetLibraryHas(c.kind, c.id, c.scope))
    .map(({ kind, id, scope }) => ({ kind, id, scope }));
  let known = [];
  if (ask.length) {
    try {
      ({ defs: known } = await api('POST', '/api/snippets/resolveDefs', { want: ask }));
    } catch {
      // No answer is no proof the library's copy is the same one, so those names are treated as
      // taken-by-something-different and stepped over - the safe way round.
      known = ask.map((w) => ({ ...w, code: null }));
    }
  }
  const body = entry.body ?? '';
  const plan = planInjection({
    body,
    carried,
    idCalls: snippetBodyIdCalls(body),
    bufferDefs: [...snippetBufferDefs(code), ...known],
    labels: snippetBufferLabels(code),
  });
  const cursor = at == null ? ed.indexFromPos(ed.getCursor()) : at;
  const [where, text] = placeSnippet(code, plan.body, cursor, firstDefRunStart(code));
  ed.operation(() => {
    ed.replaceRange(text, ed.posFromIndex(where), ed.posFromIndex(where));
    // Recomputed against the buffer as it now stands: the body just moved everything below it
    // along, so an offset taken before the insert would land in the wrong place. Same sequencing
    // as materialize's, and for the same reason.
    for (const reg of DEF_REGISTRIES) {
      const mine = plan.defs.filter((d) => d.kind === reg.kind);
      if (!mine.length) continue;
      const bodies = new Map(mine.map((d) => [d.id, defBody(d.code)]));
      const [from, to, str] = reg.defsEdit(
        ed.getValue(),
        mine.map((d) => ({ id: d.id, scope: d.scope })),
        (id) => bodies.get(id),
      );
      ed.replaceRange(str, ed.posFromIndex(from), ed.posFromIndex(to));
    }
  });
  if (ed === cm) refoldAll(); // the new definitions arrive folded, like every other block
  ed.focus();
  for (const r of plan.renames) logLine(renameNote(r));
  const n = plan.defs.length;
  logLine(`inserted snippet "${entry.name}"${n ? `, filing ${n} definition${n === 1 ? '' : 's'}` : ''}`);
}

// ------------------------------------------------------------------------------------ the browser

function snippetRow(entry) {
  const row = document.createElement('div');
  row.className = 'snippet-row';
  row.draggable = true;
  row.title = 'hover to preview, click to pin it and edit on the right - → (or Enter) puts it in at the caret, or drag it where you want it';

  const main = document.createElement('div');
  main.className = 'snippet-row-main';
  const label = document.createElement('span');
  label.className = 'snippet-row-label';
  label.textContent = entry.label;
  label.title = 'click to rename';
  // The name renames in place: it turns into a field on click and back into text on Enter, blur or
  // Escape. Sized to its own text in the stylesheet, so the rest of the row is still the row.
  label.addEventListener('click', (e) => { e.stopPropagation(); renameSnippetInline(entry, label); });
  const meta = document.createElement('span');
  meta.className = 'snippet-row-meta';
  const bits = [];
  if (entry.name !== entry.label) bits.push(entry.name);
  for (const t of entry.tags ?? []) bits.push(`#${t}`);
  if (entry.carries?.length) bits.push(`carries ${entry.carries.length}`);
  bits.push(new Date(entry.mtime).toLocaleDateString([], { dateStyle: 'short' }));
  meta.textContent = bits.join(' · ');
  main.append(label, meta);
  row.appendChild(main);

  for (const [glyph, title, fn] of [
    ['→', 'insert it at the caret', () => { selectSnippetRow(entry); insertSelectedSnippet(); }],
    ['✕', 'delete', () => deleteSnippetFile(entry)],
  ]) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = glyph;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    row.appendChild(b);
  }

  // Hover peeks, click PINS - the Quick Look shape. Once a row is pinned the pointer can cross
  // every other row on its way to the code pane without the preview swapping out from under it,
  // and the pane is already unlocked when it gets there; the next click pins something else. An edit under way pins harder still (see
  // snippetEditDirty): then even a click on another row is ignored until it is saved or dropped.
  row.addEventListener('mouseenter', () => {
    if (!snippetBrowseState?.pinned && !snippetBrowseState?.dirty) selectSnippetRow(entry);
  });
  row.addEventListener('click', () => {
    if (snippetBrowseState?.dirty) return;
    selectSnippetRow(entry);
    pinSnippetRow();
    snippetBrowseList.focus();
  });
  // text/plain as well as the private type, so CodeMirror draws its own drop cursor all the way
  // in; the private one is what tells the drop handler there are definitions to file with it.
  row.addEventListener('dragstart', (e) => {
    if (snippetBrowseState?.dirty) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', entry.body ?? '');
    e.dataTransfer.setData(SNIPPET_DND, entry.name);
    e.dataTransfer.effectAllowed = 'copy';
    // Out of the way, so the drop lands on the code rather than on the overlay covering it. Only
    // HIDDEN, not closed: a drag let go somewhere that isn't the editor has to leave the browser
    // where it was, not dismiss it (see dragend below).
    snippetBrowseBackdrop.classList.add('hidden');
  });
  row.addEventListener('dragend', () => {
    // The drop handler closes the browser for real; anything still open here was abandoned.
    if (snippetBrowseState) snippetBrowseBackdrop.classList.remove('hidden');
  });
  return row;
}

/** The row's name turned into a field, and back again - Enter or blur renames, Escape leaves it. */
function renameSnippetInline(entry, label) {
  if (!snippetBrowseState || snippetBrowseState.dirty || label.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'snippet-row-rename';
  input.value = entry.name;
  input.spellcheck = false;
  label.textContent = '';
  label.appendChild(input);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const to = input.value.trim();
    label.textContent = entry.label;
    if (!commit || !to || to === entry.name) return;
    const problem = patternNameProblem(to);
    if (problem) { snippetBrowseNote.textContent = problem; return; }
    try {
      await api('POST', '/api/snippets/rename', { from: entry.name, to });
      if (snippetBrowseState?.sel === entry.name) snippetBrowseState.sel = to;
      logLine(`renamed snippet "${entry.name}" to "${to}"`);
      refreshSnippetList();
    } catch (e) {
      snippetBrowseNote.textContent = e.message ?? String(e);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation(); // arrows and Enter are the field's here, not the list's
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.focus();
  input.select();
}

/**
 * The right-hand pane: a CodeMirror, a read-only preview until a row is clicked and editable from
 * then on. A real editor even for the preview, so the code is highlighted the way it is in the
 * buffer and unlocking it changes nothing about how it looks.
 */
function ensureSnippetBrowseCM() {
  if (!snippetBrowseCM) {
    snippetBrowseCM = CodeMirror.fromTextArea(document.getElementById('snippetBrowseEditor'), {
      mode: { name: 'javascript' },
      theme: 'poptart',
      keyMap: 'sublime',
      matchBrackets: true,
      viewportMargin: Infinity,
      readOnly: true,
      extraKeys: {
        'Cmd-S': saveSnippetEdit,
        'Ctrl-S': saveSnippetEdit,
        'Cmd-Enter': saveSnippetEdit,
        'Ctrl-Enter': saveSnippetEdit,
        'Shift-Tab': () => snippetBrowseList.focus(),
        Esc: () => {
          if (snippetBrowseState?.dirty) cancelSnippetEdit();
          else { unpinSnippetRow(); snippetBrowseList.focus(); }
        },
      },
    });
    // `setValue` is this code putting a row up, not somebody typing - only a real edit counts.
    snippetBrowseCM.on('change', (_cm, ch) => {
      if (ch.origin !== 'setValue' && snippetBrowseState) snippetEditDirty(true);
    });
  }
  return snippetBrowseCM;
}

/** The selected row stays put under the pointer, and the code pane is open for it. */
function pinSnippetRow() {
  if (!snippetBrowseState?.sel) return;
  snippetBrowseState.pinned = true;
  snippetBrowseState.unlocked = true;
  ensureSnippetBrowseCM().setOption('readOnly', false);
  for (const el of snippetBrowseList.querySelectorAll('.snippet-row')) {
    el.classList.toggle('pinned', el.dataset.name === snippetBrowseState.sel);
  }
}

function unpinSnippetRow() {
  if (!snippetBrowseState) return;
  snippetBrowseState.pinned = false;
  for (const el of snippetBrowseList.querySelectorAll('.snippet-row.pinned')) el.classList.remove('pinned');
}

/** Tab off the list: pin the row and put the caret at the end of its code. */
function editSnippetRow() {
  if (!snippetBrowseState || snippetBrowseState.dirty || !snippetBrowseState.sel) return;
  pinSnippetRow();
  const box = ensureSnippetBrowseCM();
  box.focus();
  box.setCursor(box.lineCount(), 0);
}

/**
 * An edit under way: the footer shows save and cancel, and the list goes quiet so a hover can't
 * swap the code out from under it. Clears again on save or cancel.
 */
function snippetEditDirty(on) {
  if (!snippetBrowseState) return;
  snippetBrowseState.dirty = !!on;
  snippetBrowseBackdrop.classList.toggle('editing', !!on);
  snippetBrowseNote.textContent = on ? `editing "${snippetBrowseState.sel}"` : '';
}

function cancelSnippetEdit() {
  const st = snippetBrowseState;
  if (!st?.dirty) return;
  const entry = st.entries.find((e) => e.name === st.sel);
  snippetEditDirty(false);
  selectSnippetRow(entry); // the code as it was, back in the pane
}

async function saveSnippetEdit() {
  const st = snippetBrowseState;
  if (!st?.dirty) return;
  const entry = st.entries.find((e) => e.name === st.sel);
  const body = ensureSnippetBrowseCM().getValue();
  if (!entry || body === entry.body) return cancelSnippetEdit();
  snippetBrowseNote.textContent = 'saving…';
  try {
    // Title, tags and sidecar go back exactly as they came: this edits the body and nothing else,
    // and composeSnippet rebuilds the file from all four.
    await api('POST', '/api/snippets/save', {
      name: entry.name,
      title: entry.title ?? '',
      tags: entry.tags ?? [],
      body,
      defs: (entry.carries ?? [])
        .filter((c) => c.code)
        .map(({ kind, id, scope, code }) => ({ kind, id, scope, code })),
    });
    if (snippetBrowseState !== st) return;
    entry.body = body;
    snippetEditDirty(false);
    logLine(`kept snippet "${entry.name}"`);
    // Deliberately no list refresh: it sorts by mtime, and a save would send the row you were on
    // to the top - the entry has already been updated in place above.
  } catch (e) {
    snippetBrowseNote.textContent = "couldn't save";
    logLine(`couldn't save snippet "${entry.name}" - ${e.message ?? String(e)}`, true);
  }
}

function selectSnippetRow(entry) {
  if (!snippetBrowseState) return;
  snippetBrowseState.sel = entry?.name ?? null;
  for (const el of snippetBrowseList.querySelectorAll('.snippet-row')) {
    el.classList.toggle('current', el.dataset.name === snippetBrowseState.sel);
  }
  const box = ensureSnippetBrowseCM();
  box.setValue(entry?.body ?? '');
  box.setOption('readOnly', !(entry && snippetBrowseState.unlocked));
  renderSnippetCarries(snippetBrowseCarriesEl, entry?.carries ?? []);
  snippetBrowseInsert.disabled = !entry;
}

function renderSnippetList() {
  const entries = snippetBrowseState?.entries ?? [];
  snippetBrowseList.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'snippet-empty';
    empty.textContent = snippetBrowseSearch.value.trim()
      ? 'no snippets match'
      : 'nothing kept yet - select some code in the editor and right-click it to keep it here';
    snippetBrowseList.appendChild(empty);
    selectSnippetRow(null);
    return;
  }
  for (const entry of entries) {
    const row = snippetRow(entry);
    row.dataset.name = entry.name;
    snippetBrowseList.appendChild(row);
  }
  const keep = entries.find((e) => e.name === snippetBrowseState.sel);
  selectSnippetRow(keep ?? entries[0]);
  if (keep && snippetBrowseState.pinned) pinSnippetRow(); else unpinSnippetRow();
}

async function refreshSnippetList() {
  if (!snippetBrowseState) return;
  // The rows are about to be replaced; an edit open against one of them has nowhere to go back to.
  cancelSnippetEdit();
  const q = snippetBrowseSearch.value.trim();
  try {
    const { snippets } = await api('GET', `/api/snippets?q=${encodeURIComponent(q)}`);
    if (!snippetBrowseState) return;
    snippetBrowseState.entries = snippets ?? [];
    renderSnippetList();
    snippetBrowseNote.textContent = '';
  } catch (e) {
    snippetBrowseNote.textContent = e.message ?? String(e);
  }
}

/**
 * `at` is where an insert will land, remembered on the way IN: opening the overlay takes the
 * caret's focus, so clicking a row afterwards would otherwise write wherever the editor was left.
 */
function openSnippetBrowser(ed = activeCM(), at = null) {
  snippetBrowseState = { ed, at: at ?? ed.indexFromPos(ed.getCursor()), entries: [], sel: null, pinned: false, unlocked: false, dirty: false };
  snippetBrowseSearch.value = '';
  const box = ensureSnippetBrowseCM();
  box.setValue('');
  box.setOption('readOnly', true);
  snippetBrowseCarriesEl.innerHTML = '';
  snippetBrowseNote.textContent = '';
  snippetBrowseInsert.disabled = true;
  snippetBrowseBackdrop.classList.remove('hidden', 'editing');
  box.refresh(); // laid out while hidden - size it now that it is visible
  snippetBrowseSearch.focus();
  refreshSnippetList();
}

function closeSnippetBrowser({ refocus = true } = {}) {
  const ed = snippetBrowseState?.ed;
  snippetBrowseBackdrop.classList.add('hidden');
  snippetBrowseBackdrop.classList.remove('editing');
  snippetBrowseState = null;
  if (refocus) ed?.focus();
}

function insertSelectedSnippet() {
  if (!snippetBrowseState || snippetBrowseState.dirty) return;
  const entry = snippetBrowseState.entries.find((e) => e.name === snippetBrowseState.sel);
  if (!entry) return;
  const { ed, at } = snippetBrowseState;
  closeSnippetBrowser();
  insertSnippet(entry, ed, at).catch((e) => logLine(e.message ?? String(e), true));
}

async function deleteSnippetFile(entry) {
  const go = await askDialog(`Delete the snippet "${entry.name}"?`, [
    { label: 'cancel', value: null },
    { label: 'delete', value: 'go', primary: true },
  ]);
  if (go !== 'go') return;
  try {
    await api('POST', '/api/snippets/delete', { name: entry.name });
    if (snippetBrowseState?.sel === entry.name) snippetBrowseState.sel = null;
    logLine(`deleted snippet "${entry.name}"`);
    refreshSnippetList();
  } catch (e) {
    snippetBrowseNote.textContent = e.message ?? String(e);
  }
}

// ------------------------------------------------------------------------------- the editor's menu

/** The CodeMirror an event happened inside, when that is one of the two the player writes in. */
function editorAt(target) {
  const ed = target?.closest?.('.CodeMirror')?.CodeMirror ?? null;
  return ed === cm || ed === deckBCM ? ed : null;
}

function openEditorMenu(ed, e) {
  const selected = ed.somethingSelected();
  const items = [selected
    ? ['save as snippet…', () => openSnippetSave(ed), 'keep this selection - and the rolls, shapes, presets and packs it names - for every project']
    : ['insert snippet…', () => openSnippetBrowser(ed), 'put a kept phrase in here, sidecar and all']];
  items.push('-');
  if (selected) {
    items.push(['cut', () => { writeClipboard(ed.getSelection()); ed.replaceSelection(''); ed.focus(); }]);
    items.push(['copy', () => { writeClipboard(ed.getSelection()); ed.focus(); }]);
  }
  // Offered only where the browser will actually hand the text over: a dead menu item is worse
  // than no menu item, and Cmd/Ctrl+V works regardless.
  if (navigator.clipboard?.readText) {
    items.push(['paste', async () => {
      try {
        ed.replaceSelection(await navigator.clipboard.readText());
        ed.focus();
      } catch {
        logLine("the browser wouldn't hand over the clipboard - use Cmd/Ctrl+V", true);
      }
    }]);
  }
  // No blanket `after` handing focus back: two of these items open a dialog and would have it
  // taken away again the moment they returned at their first await. The clipboard items below ask
  // for the editor back themselves, because they are the ones that want it.
  openCtxMenu(editorMenu, e.clientX, e.clientY, { items });
}

function writeClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => logLine("couldn't reach the clipboard - use Cmd/Ctrl+C", true));
}

document.addEventListener('contextmenu', (e) => {
  const ed = editorAt(e.target);
  if (!ed) return;
  // Shift+right-click is the way through to the browser's own menu - spellcheck, inspect, and
  // whatever else it offers. A page that takes the right button over should leave one.
  if (e.shiftKey) return;
  e.preventDefault();
  // With nothing selected the caret goes where the click landed, which is what makes "insert
  // snippet…" put the code where you pointed rather than wherever you were last typing. A
  // selection is left alone: right-clicking one is a gesture ABOUT it, not a place to go.
  if (!ed.somethingSelected()) {
    ed.setCursor(ed.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
  }
  openEditorMenu(ed, e);
});

// The menu goes away on any press outside it (its items act on click, so a press ON it must not
// hide them first) and on Escape - the same pair the piano roll's lane menu keeps.
document.addEventListener('pointerdown', (e) => {
  if (!editorMenu.contains(e.target)) editorMenu.classList.add('hidden');
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!editorMenu.classList.contains('hidden')) { editorMenu.classList.add('hidden'); e.stopPropagation(); return; }
  if (snippetSaveState) { closeSnippetSave(); e.stopPropagation(); return; }
  if (snippetBrowseState) {
    if (snippetBrowseState.dirty) cancelSnippetEdit(); else closeSnippetBrowser();
    e.stopPropagation();
  }
}, true);

// A row dropped onto the code. CodeMirror has been drawing the cursor for it the whole way in (the
// drag carries text/plain), and this is where the definitions catch up with the text. Capture and
// preventDefault, so CodeMirror's own drop doesn't paste the body a second time.
document.addEventListener('drop', (e) => {
  if (!Array.from(e.dataTransfer?.types ?? []).includes(SNIPPET_DND)) return;
  const ed = editorAt(e.target);
  if (!ed) return;
  e.preventDefault();
  e.stopPropagation();
  const name = e.dataTransfer.getData(SNIPPET_DND);
  const at = ed.indexFromPos(ed.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
  closeSnippetBrowser({ refocus: false }); // before the round trip, so dragend has nothing to undo
  api('GET', '/api/snippets?q=')
    .then(({ snippets }) => {
      const entry = (snippets ?? []).find((s) => s.name === name);
      if (!entry) throw new Error(`the snippet "${name}" is gone`);
      return insertSnippet(entry, ed, at);
    })
    .catch((err) => logLine(err.message ?? String(err), true));
}, true);

// -------------------------------------------------------------------------------------- the wiring

snippetSaveNameEl.addEventListener('input', syncSnippetSaveState);
snippetSaveConfirm.addEventListener('click', saveSnippet);
document.getElementById('snippetSaveClose').addEventListener('click', closeSnippetSave);
snippetSaveBackdrop.addEventListener('click', (e) => { if (e.target === snippetSaveBackdrop) closeSnippetSave(); });
// On the dialog rather than the fields, so the editor's chords never fire from inside it - the
// same guard the naming dialog keeps. Enter in a FIELD saves; inside the code window it is a
// newline, which is what it should be.
snippetSaveBackdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target === snippetSaveNameEl || e.target === snippetSaveTagsEl)) {
    e.preventDefault();
    saveSnippet();
  }
  e.stopPropagation();
});

snippetBrowseInsert.addEventListener('click', insertSelectedSnippet);
document.getElementById('snippetBrowseSave').addEventListener('click', saveSnippetEdit);
document.getElementById('snippetBrowseCancel').addEventListener('click', cancelSnippetEdit);
document.getElementById('snippetBrowseClose').addEventListener('click', () => closeSnippetBrowser());
snippetBrowseBackdrop.addEventListener('click', (e) => { if (e.target === snippetBrowseBackdrop) closeSnippetBrowser(); });
snippetBrowseSearch.addEventListener('input', () => refreshSnippetList());
snippetBrowseBackdrop.addEventListener('keydown', (e) => {
  // The code window and the rename field own their keys (Cmd/Ctrl+S saves, Esc cancels or hands
  // focus back - see ensureSnippetBrowseCM's extraKeys). Nothing reaches the page's own chords
  // either way, as in the save dialog.
  if (e.target?.closest?.('.CodeMirror') || e.target?.tagName === 'INPUT' && e.target !== snippetBrowseSearch) {
    e.stopPropagation();
    return;
  }
  // Tab off the list goes to the code, and nowhere the browser's tab order might otherwise wander.
  if (e.key === 'Tab' && !e.shiftKey && e.target === snippetBrowseList) {
    e.preventDefault();
    e.stopPropagation();
    editSnippetRow();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const entries = snippetBrowseState?.entries ?? [];
    if (!entries.length) return;
    const i = entries.findIndex((x) => x.name === snippetBrowseState.sel);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    selectSnippetRow(entries[Math.max(0, Math.min(entries.length - 1, (i < 0 ? 0 : i) + step))]);
    pinSnippetRow(); // the arrows are as deliberate as a click
    snippetBrowseList.querySelector('.snippet-row.current')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    // Enter inserts, like the row's → button. Not the → KEY: in organize that is the gesture for
    // moving a song OUT of a playlist, and one arrow meaning two things across two browsers is
    // one too many.
    e.preventDefault();
    insertSelectedSnippet();
  }
  e.stopPropagation();
});

// ctrl+J - the same two entry points from the keyboard, for when the mouse is somewhere else: with
// a selection it keeps one, with none it opens the browser.
addHotkey(builtinHotkeys, 'ctrl+j', () => {
  const ed = activeCM();
  if (ed.somethingSelected()) openSnippetSave(ed);
  else openSnippetBrowser(ed);
}, 'keep the selection as a snippet / open the snippet browser');

// ---------------------------------------------------------------------------------------------
// The arrangement painter - `$: arrange()`, double-click the name.
//
// A playlist: lanes down the side, bars along the top, and the buffer's labelled blocks as a
// palette of brushes. Painting a block onto a lane makes a CLIP, and a block with any clip at all
// plays only inside them - its bare loop has become a part (the server gates it, see the
// arrangement pass in /api/evaluate and pattern-core's arrange.mjs). Lanes are display only: a
// lane may hold any number of labels, and a label may sit on any lane, so the rows are for laying
// the song out to read rather than one-track-per-row. The whole thing loops over its length.
//
// Clips edit like the roll's notes: click-drag to paint one, drag its body to move it (between
// lanes too), drag its right edge to resize, right-click or delete to remove it. Every edit is
// written straight back into the arrange("…", { … }) call - the data folds to a chip like a roll's
// notes - and re-evaluates the buffer, so what is painted is what plays.
// ---------------------------------------------------------------------------------------------

const arPanel = document.getElementById('arrangePanel');
const arCanvas = document.getElementById('arrangeCanvas');
const arChips = document.getElementById('arrangeChips');
const arSnapSelect = document.getElementById('arrangeSnap');
const arLenInput = document.getElementById('arrangeLen');
const arZoomInBtn = document.getElementById('arrangeZoomIn');
const arZoomOutBtn = document.getElementById('arrangeZoomOut');
const arToolBtn = document.getElementById('arrangeTool');
const arCloseBtn = document.getElementById('arrangeClose');
const arLaneNameInput = document.getElementById('arrangeLaneName');
const arMenu = document.getElementById('arrangeMenu');

const AR_LOOPS_H = 22; // px: the loops strip along the top, where loop regions live
const AR_RULER = 20; // px: the bar numbers, under the strip and directly against the lanes they label
const AR_RULER_TOP = AR_LOOPS_H;
const AR_LANES_TOP = AR_LOOPS_H + AR_RULER; // where the lanes start
const AR_ROW = 36; // px per lane
const AR_VISIBLE_LANES = 8; // the canvas shows this many; lanes are unbounded and scroll under it
const AR_GUTTER = 96; // px: the lane names down the left
const AR_PAD_BOTTOM = 6;
const AR_DEFAULT_PX_PER_CYCLE = 44; // one bar is comfortably wide by default: the unit you paint in
const AR_MIN_PX_PER_CYCLE = 6;
const AR_MAX_PX_PER_CYCLE = 400;
const AR_EDGE_PX = 8; // how close to a clip's (or region's) edge counts as grabbing it to resize
const AR_SNAPS = [1, 2, 4, 8, 16]; // cells per bar the snap menu offers
const AR_HISTORY_MAX = 200;
const AR_EVAL_DEBOUNCE_MS = 120;

let arState = null;
let arRaf = null;
let arPlayheadOn = false;
let arW = 0;
let arH = 0;
let arEvalTimer = null;
let arSuppressClose = false; // set while the panel's own write is changing the buffer
let arTool = localStorage.getItem('poptartArrangeTool') === 'select' ? 'select' : 'draw'; // pencil vs arrow, sticky like the roll's

// --- the call in the buffer ---

function findArrangeCallAt(code, idx) {
  return findNamedCallAt(code, idx, /\barrange\s*\(/g, 'arrange');
}

/**
 * The arguments of an arrange(...) call -> its clips and options. The first argument is the clip
 * string; whatever follows the comma after it is the options object, read as the JavaScript it is
 * (an object literal, which is all the painter ever writes) and ignored if it doesn't read.
 */
function parseArrangeCall(inner) {
  const text = inner.trim();
  let clipStr = '';
  let optsText = '';
  const m = /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*(?:,\s*([\s\S]*))?$/.exec(text);
  if (m) {
    clipStr = m[1].slice(1, -1);
    optsText = (m[2] ?? '').trim();
  } else if (text.startsWith('{')) {
    optsText = text;
  }
  let opts = {};
  if (optsText) {
    try {
      // eslint-disable-next-line no-new-func
      opts = new Function(`return (${optsText})`)() ?? {};
    } catch {
      opts = {};
    }
  }
  return { clips: arrangeMod.parseArrangement(clipStr), opts: arrangeMod.normalizeArrangeOpts(opts) };
}

function arCallOpts(state) {
  const opts = {};
  if (state.snap !== arrangeMod.ARRANGE_DEFAULT_SNAP) opts.snap = state.snap;
  if (state.len != null) opts.len = state.len;
  // Names are written up to the last lane that has one; a hole is an unnamed lane in between.
  const lanes = state.lanes.slice();
  while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
  if (lanes.length) opts.lanes = lanes.map((n) => n || '');
  if (state.loops.length) opts.loops = state.loops.map((r) => [r.name, r.start, r.end]);
  return opts;
}

function serializeArrangeCall(state) {
  const clips = arrangeMod.serializeArrangement(state.clips);
  const opts = arCallOpts(state);
  const optsText = Object.entries(opts)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');
  if (!clips && !optsText) return 'arrange()';
  return optsText ? `arrange(${JSON.stringify(clips)}, { ${optsText} })` : `arrange(${JSON.stringify(clips)})`;
}

function writeArrangeCall(record = true) {
  if (!arState) return;
  const range = arState.marker.find();
  if (!range) return;
  if (record) arPushHistory();
  const text = serializeArrangeCall(arState);
  arSuppressClose = true;
  try {
    cm.replaceRange(text, range.from, range.to);
    arState.marker.clear();
    const startIdx = cm.indexFromPos(range.from);
    arState.marker = cm.markText(range.from, cm.posFromIndex(startIdx + text.length), {});
    arState.callStart = startIdx;
  } finally {
    arSuppressClose = false;
  }
  refoldAll(); // the rewrite cleared the data chip; put it (and everything else) back in one frame
  arRenderChips();
  clearTimeout(arEvalTimer);
  arEvalTimer = setTimeout(() => { arEvalTimer = null; evaluate(false); }, AR_EVAL_DEBOUNCE_MS);
}

// --- history ---

const arRegionData = (r) => ({ name: r.name, start: r.start, end: r.end }); // without the drawn-geometry scratch fields
const arSnapshot = () => ({ clips: arState.clips.map((c) => ({ ...c })), len: arState.len, snap: arState.snap, lanes: arState.lanes.slice(), loops: arState.loops.map(arRegionData) });
const arSnapKey = (s) => `${arrangeMod.serializeArrangement(s.clips)}|${s.len}|${s.snap}|${s.lanes.join(',')}|${JSON.stringify(s.loops.map(arRegionData))}`;

function arPushHistory() {
  const snap = arSnapshot();
  const current = arState.history[arState.histIdx];
  if (current && arSnapKey(current) === arSnapKey(snap)) return;
  arState.history.length = arState.histIdx + 1;
  arState.history.push(snap);
  if (arState.history.length > AR_HISTORY_MAX) arState.history.shift();
  arState.histIdx = arState.history.length - 1;
}

function arHistoryStep(delta) {
  const next = arState.histIdx + delta;
  if (next < 0 || next >= arState.history.length) return;
  arState.histIdx = next;
  const snap = arState.history[next];
  arState.clips = snap.clips.map((c) => ({ ...c }));
  arState.len = snap.len;
  arState.snap = snap.snap;
  arState.lanes = snap.lanes.slice();
  arState.loops = snap.loops.map(arRegionData);
  arState.selRegion = null;
  arState.sel.clear();
  arSyncControls();
  writeArrangeCall(false);
  drawArrange();
}

// --- open / close ---

function openArrangeEditor(call) {
  if (!arrangeMod) return;
  const wasOpen = !!arState;
  if (wasOpen) closeArrangeEditor();
  const code = cm.getValue();
  const from = cm.posFromIndex(call.start);
  const to = cm.posFromIndex(call.close + 1);
  const { clips, opts } = parseArrangeCall(code.slice(call.open + 1, call.close));
  arState = {
    marker: cm.markText(from, to, {}),
    callStart: call.start,
    clips,
    snap: opts.snap, // cells per bar the painter snaps to (editor metadata, written to the call)
    len: opts.len, // explicit loop length in bars, or null for "the last clip's end"
    lanes: opts.lanes, // lane names by index ('' = unnamed)
    loops: opts.loops.map((r) => ({ ...r })), // loop regions [{ name, start, end }] - see ArrangeClock
    pxPerCycle: AR_DEFAULT_PX_PER_CYCLE,
    scroll: 0, // leftmost visible bar
    scrollLane: 0, // topmost visible lane (fractional while scrolling) - lanes are unbounded
    brush: null, // the label the next paint lays down
    sel: new Set(), // selected clip objects (transient, never serialized)
    selRegion: null, // the selected loop region (its name and × become live in the ruler)
    drag: null,
    hover: null,
    history: [],
    histIdx: -1,
  };
  arPushHistory();
  arSyncControls();
  arRenderChips();
  arPanel.classList.remove('hidden');
  arSizeCanvas();
  drawArrange();
  if (!arRaf) arRaf = requestAnimationFrame(arPlayheadLoop);
  // The song clock the server is running: the painter opened after the eval that built it.
  if (!arClockSnap) api('GET', '/api/arrange').then((res) => arSetClock(res.arrange ?? null)).catch(() => {});
}

function closeArrangeEditor() {
  arCloseMenu();
  arLaneNameInput.classList.add('hidden');
  if (arRaf) { cancelAnimationFrame(arRaf); arRaf = null; }
  if (arState?.marker) arState.marker.clear();
  arState = null;
  arPanel.classList.add('hidden');
}

function arPlayheadLoop() {
  if (!arState) { arRaf = null; return; }
  if (!transport.paused || arPlayheadOn) drawArrange();
  arRaf = requestAnimationFrame(arPlayheadLoop);
}

// --- the palette ---

/** The labels a clip may name: every labelled block in the buffer, in document order. */
function arLabels() {
  if (!labelsMod) return [];
  const seen = new Set();
  const out = [];
  for (const b of labelsMod.splitLabeledBlocks(cm.getValue())) {
    if (!b.label || b.label.startsWith('$') || seen.has(b.label)) continue;
    seen.add(b.label);
    out.push(b.label);
  }
  return out;
}

/** A label's colour: a hue hashed from its name, so `bass` is the same colour in every song. */
function arHue(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return h % 360;
}
const arColor = (label, alpha = 1) => `hsla(${arHue(label)}, 62%, 58%, ${alpha})`;

function arRenderChips() {
  if (!arState) return;
  const labels = arLabels();
  const painted = new Set(arState.clips.map((c) => c.label));
  // Labels that are painted but no longer in the buffer still get a chip, so their clips can be
  // seen for what they are (and repainted or deleted) rather than being invisible orphans.
  for (const l of painted) if (!labels.includes(l)) labels.push(l);
  if (!labels.includes(arState.brush)) arState.brush = labels[0] ?? null;
  arChips.innerHTML = '';
  if (!labels.length) {
    const e = document.createElement('span');
    e.className = 'arrange-chips-empty';
    e.textContent = 'no labelled blocks to paint yet';
    arChips.appendChild(e);
    return;
  }
  for (const label of labels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `arrange-chip${label === arState.brush ? ' active' : ''}${painted.has(label) ? ' painted' : ''}`;
    b.style.setProperty('--chip', arColor(label));
    b.title = painted.has(label) ? `${label} — painted: plays only inside its clips` : `${label} — plays as written until painted`;
    const dot = document.createElement('span');
    dot.className = 'arrange-chip-dot';
    b.appendChild(dot);
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', () => {
      arState.brush = label;
      arRenderChips();
      arCanvas.focus({ preventScroll: true });
    });
    arChips.appendChild(b);
  }
}

// --- controls ---

function arSyncControls() {
  if (!arState) return;
  if (![...arSnapSelect.options].some((o) => Number(o.value) === arState.snap)) {
    const o = document.createElement('option');
    o.value = String(arState.snap);
    o.textContent = `1/${arState.snap}`;
    arSnapSelect.appendChild(o);
  }
  arSnapSelect.value = String(arState.snap);
  arLenInput.value = arState.len == null ? '' : String(arState.len);
}

/** The loop length the painter shows and the server plays: explicit, or the last clip's end. */
const arLoopLen = () => arrangeMod.arrangementLength(arState.clips, { len: arState.len });

// --- geometry ---

const arCell = () => 1 / arState.snap; // one snap cell, in bars
const arSnapTo = (bars) => Math.round(bars * arState.snap) / arState.snap;
const arXOf = (bars) => AR_GUTTER + (bars - arState.scroll) * arState.pxPerCycle;
const arBarsOf = (x) => arState.scroll + (x - AR_GUTTER) / arState.pxPerCycle;
const arLaneOf = (y) => Math.floor((y - AR_LANES_TOP) / AR_ROW + arState.scrollLane);
const arYOf = (lane) => AR_LANES_TOP + (lane - arState.scrollLane) * AR_ROW;
const arGridBottom = () => AR_LANES_TOP + AR_VISIBLE_LANES * AR_ROW;
const arInLoops = (y) => y < AR_LOOPS_H;
const arInRuler = (y) => y >= AR_RULER_TOP && y < AR_LANES_TOP;

function arSizeCanvas() {
  if (!arState) return;
  const w = arCanvas.clientWidth;
  if (!w) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  arW = w;
  arH = AR_LANES_TOP + AR_VISIBLE_LANES * AR_ROW + AR_PAD_BOTTOM;
  arCanvas._dpr = dpr;
  arCanvas.width = w * dpr;
  arCanvas.height = arH * dpr;
}

function arPoint(e) {
  const r = arCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** The clip under (x, y), the topmost drawn (last in the list) winning, and whether its right edge is. */
function arClipAt(x, y) {
  const lane = arLaneOf(y);
  const bars = arBarsOf(x);
  for (let i = arState.clips.length - 1; i >= 0; i--) {
    const c = arState.clips[i];
    if (c.lane !== lane) continue;
    const x1 = arXOf(c.start);
    const x2 = arXOf(c.start + c.len);
    if (x < x1 || x > x2) continue;
    if (bars < c.start || bars > c.start + c.len) continue;
    // Either edge is a handle when the clip is wide enough to leave a body between them.
    const wide = x2 - x1 > AR_EDGE_PX * 3;
    const edge = wide && x2 - x <= AR_EDGE_PX ? 'right' : wide && x - x1 <= AR_EDGE_PX ? 'left' : null;
    return { clip: c, edge };
  }
  return null;
}

/** What is under x in the ruler: a region and which part of it - an edge, its name, its ×, or the body. */
function arRegionHit(x) {
  const region = arRegionAt(x);
  if (!region) return null;
  const x1 = region._x1 ?? arXOf(region.start);
  const x2 = region._x2 ?? arXOf(region.end);
  const selected = arState.selRegion === region;
  if (x2 - x1 > AR_EDGE_PX * 3) {
    if (x - x1 <= AR_EDGE_PX) return { region, part: 'left' };
    if (x2 - x <= AR_EDGE_PX) return { region, part: 'right' };
  }
  if (selected && x2 - x <= 18) return { region, part: 'close' };
  return { region, part: 'body' };
}

function arVisibleBars() {
  return (arW - AR_GUTTER) / arState.pxPerCycle;
}

function arZoomAt(factor, x = AR_GUTTER) {
  const barsUnder = arBarsOf(x);
  arState.pxPerCycle = Math.min(AR_MAX_PX_PER_CYCLE, Math.max(AR_MIN_PX_PER_CYCLE, arState.pxPerCycle * factor));
  arState.scroll = Math.max(0, barsUnder - (x - AR_GUTTER) / arState.pxPerCycle);
  drawArrange();
}

// --- drawing ---

function drawArrange() {
  if (!arState || !arrangeMod) return;
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const dpr = arCanvas._dpr || 1;
  const ctx = arCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = arW;
  const H = arH;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';

  const loopLen = arLoopLen();
  const gridTop = AR_LANES_TOP;
  const gridBottom = arGridBottom();
  const firstLane = Math.floor(arState.scrollLane);
  const lastLane = Math.ceil(arState.scrollLane + AR_VISIBLE_LANES);

  // lanes: alternate fills, a rule between (unbounded - whichever are scrolled into view)
  ctx.save();
  ctx.beginPath(); ctx.rect(0, gridTop, W, gridBottom - gridTop); ctx.clip();
  for (let lane = firstLane; lane <= lastLane; lane++) {
    const y = arYOf(lane);
    ctx.fillStyle = lane % 2 ? col('--bg') : col('--bg-panel');
    ctx.fillRect(AR_GUTTER, y, W - AR_GUTTER, AR_ROW);
  }
  // past the loop's end: dimmed, nothing there plays
  const loopX = arXOf(loopLen);
  if (loopX < W) {
    ctx.fillStyle = col('--bg');
    ctx.globalAlpha = 0.55;
    ctx.fillRect(Math.max(AR_GUTTER, loopX), gridTop, W - Math.max(AR_GUTTER, loopX), gridBottom - gridTop);
    ctx.globalAlpha = 1;
  }

  // vertical grid: snap cells faint, bars stronger, every 4 bars stronger still
  const cell = arCell();
  const firstCell = Math.floor(arState.scroll / cell);
  const lastCell = Math.ceil((arState.scroll + arVisibleBars()) / cell);
  const cellPx = cell * arState.pxPerCycle;
  for (let k = firstCell; k <= lastCell; k++) {
    const bars = k * cell;
    const x = Math.round(arXOf(bars)) + 0.5;
    if (x < AR_GUTTER) continue;
    const onBar = Math.abs(bars - Math.round(bars)) < 1e-9;
    if (!onBar && cellPx < 5) continue; // too fine to draw
    const onPhrase = onBar && Math.round(bars) % 4 === 0;
    ctx.strokeStyle = col('--border');
    ctx.globalAlpha = onPhrase ? 1 : onBar ? 0.7 : 0.3;
    ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, gridBottom); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // lane rules
  ctx.strokeStyle = col('--border');
  for (let lane = firstLane; lane <= lastLane; lane++) {
    const y = Math.round(arYOf(lane)) + 0.5;
    ctx.beginPath(); ctx.moveTo(AR_GUTTER, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // clips
  const text = col('--text');
  const hoverClip = !arState.drag && arState.hover && arState.hover.y >= AR_LANES_TOP && arState.hover.x >= AR_GUTTER ? arClipAt(arState.hover.x, arState.hover.y) : null;
  for (const c of arState.clips) {
    const x1 = arXOf(c.start);
    const x2 = arXOf(c.start + c.len);
    if (x2 <= AR_GUTTER || x1 >= W || c.lane < firstLane || c.lane > lastLane) continue;
    const dx = Math.max(AR_GUTTER, x1);
    const dx2 = Math.min(W, x2);
    const y = arYOf(c.lane);
    const w = Math.max(2, dx2 - dx - 1);
    const selected = arState.sel.has(c);
    const past = c.start >= loopLen - 1e-9;
    ctx.fillStyle = arColor(c.label, past ? 0.18 : 0.42);
    prRoundRect(ctx, dx + 0.5, y + 3, w, AR_ROW - 6, 4); ctx.fill();
    ctx.strokeStyle = selected ? col('--accent') : arColor(c.label, 0.95);
    ctx.lineWidth = selected ? 1.5 : 1;
    prRoundRect(ctx, dx + 0.5, y + 3, w, AR_ROW - 6, 4); ctx.stroke();
    ctx.lineWidth = 1;
    // the edge under the pointer shows as a handle, so a resize is offered before it is tried
    if (hoverClip?.clip === c && hoverClip.edge) {
      ctx.fillStyle = col('--accent');
      ctx.globalAlpha = 0.9;
      ctx.fillRect(hoverClip.edge === 'left' ? dx + 1 : dx2 - 4, y + 5, 3, AR_ROW - 10);
      ctx.globalAlpha = 1;
    }
    if (w > 18) {
      ctx.save();
      ctx.beginPath(); ctx.rect(dx + 2, y, w - 4, AR_ROW); ctx.clip();
      ctx.fillStyle = text;
      ctx.globalAlpha = past ? 0.5 : 0.95;
      ctx.fillText(c.label, dx + 6, y + AR_ROW / 2);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // the paint in progress, hollow, so what a drag is about to make is visible before it lands
  if (arState.drag?.kind === 'marquee') {
    const r = arState.drag;
    ctx.fillStyle = col('--accent-soft');
    ctx.strokeStyle = col('--accent');
    const rx = Math.min(r.x0, r.x1), ry = Math.min(r.y0, r.y1);
    ctx.fillRect(rx, ry, Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
  }
  ctx.restore();

  // ruler: bar numbers, and the loop's end as a marker you can drag
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, AR_RULER_TOP, W, AR_RULER);
  ctx.strokeStyle = col('--border');
  ctx.beginPath(); ctx.moveTo(0, AR_LANES_TOP - 0.5); ctx.lineTo(W, AR_LANES_TOP - 0.5); ctx.stroke();
  const every = arState.pxPerCycle >= 28 ? 1 : arState.pxPerCycle >= 12 ? 4 : arState.pxPerCycle >= 4 ? 8 : 16;
  ctx.fillStyle = col('--text-dim');
  for (let bar = Math.ceil(arState.scroll); bar <= arState.scroll + arVisibleBars(); bar++) {
    if (bar % every) continue;
    const x = arXOf(bar);
    if (x < AR_GUTTER) continue;
    ctx.fillText(String(bar + 1), x + 3, AR_RULER_TOP + AR_RULER / 2);
  }
  // loop regions: bands in the ruler, the one looping now lit, released ones dimmed
  const clockState = arClockState();
  // the loops strip: its own row above the ruler, so the bar numbers stay readable and stay
  // against the lanes they label
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, 0, W, AR_LOOPS_H);
  ctx.strokeStyle = col('--border');
  ctx.beginPath(); ctx.moveTo(0, AR_LOOPS_H - 0.5); ctx.lineTo(W, AR_LOOPS_H - 0.5); ctx.stroke();
  const stripMid = AR_LOOPS_H / 2;
  const hoverRegion = !arState.drag && arState.hover && arInLoops(arState.hover.y) && arState.hover.x >= AR_GUTTER ? arRegionHit(arState.hover.x) : null;
  for (const r of arState.loops) {
    const x1 = Math.max(AR_GUTTER, arXOf(r.start));
    const x2 = Math.min(W, arXOf(r.end));
    r._x1 = x1; r._x2 = x2; // where it was drawn, for the ruler's hit-testing
    if (x2 <= x1) continue;
    const looping = clockState?.looping === r.name;
    const released = clockState?.released.includes(r.name);
    const selected = arState.selRegion === r;
    ctx.fillStyle = col('--accent');
    ctx.globalAlpha = looping ? 0.55 : released ? 0.12 : 0.28;
    ctx.fillRect(x1, 3, x2 - x1, AR_LOOPS_H - 6);
    ctx.globalAlpha = 1;
    if (selected) {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 + 0.75, 3.75, x2 - x1 - 1.5, AR_LOOPS_H - 7.5);
      ctx.lineWidth = 1;
    }
    const label = `${looping ? '↻ ' : ''}${r.name}`;
    r._nameW = ctx.measureText(label).width;
    if (x2 - x1 > 24) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x1, 0, x2 - x1 - (selected ? 18 : 4), AR_LOOPS_H); ctx.clip();
      ctx.fillStyle = text;
      ctx.globalAlpha = released ? 0.5 : 0.95;
      ctx.fillText(label, x1 + 4, stripMid);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    if (selected && x2 - x1 > 30) {
      // the × that removes it, at the right end - live only while the region is selected
      ctx.fillStyle = text;
      ctx.globalAlpha = hoverRegion?.region === r && hoverRegion.part === 'close' ? 1 : 0.7;
      ctx.fillText('×', x2 - 12, stripMid);
      ctx.globalAlpha = 1;
    }
    if (hoverRegion?.region === r && (hoverRegion.part === 'left' || hoverRegion.part === 'right')) {
      ctx.fillStyle = col('--accent');
      ctx.fillRect(hoverRegion.part === 'left' ? x1 : x2 - 3, 3, 3, AR_LOOPS_H - 6);
    }
    // its bounds down the lanes, faint, so a clip can be lined up with it
    ctx.strokeStyle = col('--accent');
    ctx.globalAlpha = 0.25;
    for (const x of [x1, x2]) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, gridTop); ctx.lineTo(Math.round(x) + 0.5, gridBottom); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (arState.drag?.kind === 'region') {
    const d = arState.drag;
    const x1 = arXOf(Math.min(d.a, d.b)), x2 = arXOf(Math.max(d.a, d.b));
    ctx.fillStyle = col('--accent');
    ctx.globalAlpha = 0.4;
    ctx.fillRect(x1, 3, x2 - x1, AR_LOOPS_H - 6);
    ctx.globalAlpha = 1;
  }
  // loop end
  if (loopX >= AR_GUTTER && loopX <= W + 1) {
    ctx.strokeStyle = col('--accent');
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = arState.len == null ? 0.5 : 0.9;
    ctx.beginPath(); ctx.moveTo(Math.round(loopX) + 0.5, AR_RULER_TOP); ctx.lineTo(Math.round(loopX) + 0.5, gridBottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col('--accent');
    ctx.beginPath(); ctx.moveTo(loopX, AR_LANES_TOP - 1); ctx.lineTo(loopX - 5, AR_RULER_TOP + 1); ctx.lineTo(loopX + 5, AR_RULER_TOP + 1); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // gutter: lane names
  ctx.fillStyle = col('--bg-panel');
  ctx.fillRect(0, 0, AR_GUTTER, gridBottom);
  ctx.fillStyle = col('--text-dim');
  ctx.globalAlpha = 0.7;
  ctx.fillText('loops', 8, stripMid);
  ctx.fillText('bar', 8, AR_RULER_TOP + AR_RULER / 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = col('--border');
  ctx.beginPath(); ctx.moveTo(AR_GUTTER - 0.5, 0); ctx.lineTo(AR_GUTTER - 0.5, gridBottom); ctx.stroke();
  ctx.save();
  ctx.beginPath(); ctx.rect(0, AR_LANES_TOP, AR_GUTTER, gridBottom - AR_LANES_TOP); ctx.clip();
  for (let lane = firstLane; lane <= lastLane; lane++) {
    const name = arState.lanes[lane] || '';
    const y = arYOf(lane) + AR_ROW / 2;
    ctx.fillStyle = name ? text : col('--text-dim');
    ctx.globalAlpha = name ? 0.95 : 0.55;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, arYOf(lane), AR_GUTTER - 4, AR_ROW); ctx.clip();
    ctx.fillText(name || `${lane + 1}`, 8, y);
    ctx.restore();
    ctx.globalAlpha = 1;
    const y2 = Math.round(arYOf(lane + 1)) + 0.5;
    ctx.strokeStyle = col('--border');
    ctx.beginPath(); ctx.moveTo(0, y2); ctx.lineTo(AR_GUTTER, y2); ctx.stroke();
  }
  ctx.restore();

  // playhead
  arPlayheadOn = false;
  if (!transport.paused) {
    const pos = clockState ? clockState.pos : ((currentCyclePos() % loopLen) + loopLen) % loopLen;
    const x = arXOf(pos);
    if (x >= AR_GUTTER && x <= W) {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, gridBottom); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      arPlayheadOn = true;
    }
  }
}

// --- gestures ---

function arCursorFor(x, y) {
  if (!arState) return 'default';
  if (arInRuler(y)) return x >= AR_GUTTER ? 'col-resize' : 'default'; // anywhere in the ruler sets the length
  if (arInLoops(y)) {
    if (x < AR_GUTTER) return 'default';
    const rh = arRegionHit(x);
    if (rh?.part === 'left') return CUR_BRACKET_L;
    if (rh?.part === 'right') return CUR_BRACKET_R;
    if (rh?.part === 'close') return 'pointer';
    if (rh) return 'grab';
    return arTool === 'draw' ? CUR_PENCIL : 'default';
  }
  if (x < AR_GUTTER) return 'default';
  const hit = arClipAt(x, y);
  if (hit) return hit.edge === 'left' ? CUR_BRACKET_L : hit.edge === 'right' ? CUR_BRACKET_R : 'grab';
  return arTool === 'draw' && arState.brush ? CUR_PENCIL : 'crosshair';
}

function arRefreshCursor() {
  if (!arState || arState.drag) return;
  const h = arState.hover;
  arCanvas.style.cursor = h ? arCursorFor(h.x, h.y) : 'default';
}

function arDeleteClips(clips) {
  const gone = new Set(clips);
  if (!gone.size) return;
  arState.clips = arState.clips.filter((c) => !gone.has(c));
  for (const c of gone) arState.sel.delete(c);
  writeArrangeCall();
  drawArrange();
}

function arRemoveRegion(region) {
  arState.loops = arState.loops.filter((r) => r !== region);
  if (arState.selRegion === region) arState.selRegion = null;
  writeArrangeCall();
  drawArrange();
}

function arOpenMenu(clientX, clientY, hit, lane) {
  const items = [];
  if (hit) {
    const targets = arState.sel.has(hit.clip) ? [...arState.sel] : [hit.clip];
    const labels = arLabels();
    items.push([`delete${targets.length > 1 ? ` ${targets.length} clips` : ''}`, () => arDeleteClips(targets)]);
    items.push(['duplicate after', () => arDuplicate(targets)]);
    if (labels.length > 1) {
      items.push('-');
      for (const l of labels) {
        if (l === hit.clip.label && targets.length === 1) continue;
        items.push([`→ ${l}`, () => { for (const c of targets) c.label = l; writeArrangeCall(); drawArrange(); }, `repaint as ${l}`]);
      }
    }
  } else if (lane != null && lane >= 0) {
    items.push(['rename lane', () => arRenameLane(lane)]);
    if (arState.clips.some((c) => c.lane === lane)) items.push(['clear lane', () => arDeleteClips(arState.clips.filter((c) => c.lane === lane))]);
  }
  if (!items.length) return;
  openCtxMenu(arMenu, clientX, clientY, { items });
}

function arCloseMenu() {
  arMenu.classList.add('hidden');
}

function arDuplicate(clips) {
  if (!clips.length) return;
  const end = Math.max(...clips.map((c) => c.start + c.len));
  const start = Math.min(...clips.map((c) => c.start));
  const shift = end - start;
  const made = clips.map((c) => ({ ...c, start: c.start + shift }));
  arState.clips.push(...made);
  arState.sel = new Set(made);
  writeArrangeCall();
  drawArrange();
}

/** The one text box the painter has, laid over whatever is being named: a lane, or a loop region. */
function arShowNameInput({ left, top, width, value, placeholder, edit }) {
  const r = arCanvas.getBoundingClientRect();
  const body = arCanvas.parentElement.getBoundingClientRect();
  arLaneNameInput.style.left = `${r.left - body.left + left}px`;
  arLaneNameInput.style.top = `${r.top - body.top + top}px`;
  arLaneNameInput.style.width = `${width}px`;
  arLaneNameInput.value = value;
  arLaneNameInput.placeholder = placeholder;
  arNameEdit = edit;
  arLaneNameInput.classList.remove('hidden');
  arLaneNameInput.focus();
  arLaneNameInput.select();
}
let arNameEdit = null; // { kind: 'lane', lane } | { kind: 'region', region, fresh }

function arRenameLane(lane) {
  arShowNameInput({ left: 4, top: arYOf(lane) + (AR_ROW - 22) / 2, width: AR_GUTTER - 8, value: arState.lanes[lane] || '', placeholder: 'lane name', edit: { kind: 'lane', lane } });
}

function arNameRegion(region, fresh = false) {
  const x1 = Math.max(AR_GUTTER, arXOf(region.start));
  const x2 = Math.min(arW, arXOf(region.end));
  arShowNameInput({ left: x1, top: 0, width: Math.max(90, x2 - x1), value: fresh ? '' : region.name, placeholder: 'loop name', edit: { kind: 'region', region, fresh } });
}

function arCommitLaneName(save) {
  if (arLaneNameInput.classList.contains('hidden')) return;
  const edit = arNameEdit;
  arNameEdit = null;
  arLaneNameInput.classList.add('hidden');
  if (!arState || !edit) return;
  const name = arLaneNameInput.value.trim();
  if (edit.kind === 'lane') {
    if (!save) return;
    while (arState.lanes.length <= edit.lane) arState.lanes.push('');
    if (arState.lanes[edit.lane] === name) return;
    arState.lanes[edit.lane] = name;
  } else {
    if (!save && edit.fresh) {
      arState.loops = arState.loops.filter((r) => r !== edit.region); // escaped out of a new one: no region
      drawArrange();
      return;
    }
    if (!save) return;
    // A name that is one word, unique among the regions: it is what the console names on ctrl+L.
    const taken = new Set(arState.loops.filter((r) => r !== edit.region).map((r) => r.name));
    let candidate = name.replace(/\s+/g, '_') || `loop${arState.loops.indexOf(edit.region) + 1}`;
    while (taken.has(candidate)) candidate += '_';
    if (edit.region.name === candidate && !edit.fresh) return;
    edit.region.name = candidate;
  }
  writeArrangeCall();
  drawArrange();
}

/** The loop region under x in the ruler, the shortest winning when they nest. */
function arRegionAt(x) {
  const bars = arBarsOf(x);
  let best = null;
  for (const r of arState.loops) {
    if (bars >= r.start && bars < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
  }
  return best;
}

const arNearLoopEnd = (x) => Math.abs(x - arXOf(arLoopLen())) <= 6;

// --- the song clock ---
// The server gates the tracks by its ArrangeClock; the painter draws the playhead by a twin built
// from the same snapshot (see arrange.mjs), refreshed by every eval and every ctrl+L.

let arClockSnap = null;
let arClockTwin = null;

function arSetClock(snap) {
  arClockSnap = snap;
  arClockTwin = snap && arrangeMod ? new arrangeMod.ArrangeClock(snap) : null;
}

/** Where the song is now, by the clock: { pos, looping, released }, or null without an arrangement. */
function arClockState() {
  if (!arClockTwin) return null;
  return arClockTwin.stateAt(currentCyclePos());
}

/** ctrl+L: release the loop region playback is in. Works from anywhere in the editor. */
function arrangeUnlock() {
  api('POST', '/api/arrangeUnlock', { deck: mixModeOn ? djActiveDeck : 'a' })
    .then((res) => {
      arSetClock(res.arrange ?? null);
      logLine(res.released ? `[arrange] loop ${res.released} released` : '[arrange] no loop to release');
      if (arState) drawArrange();
    })
    .catch((e) => logLine(`[arrange] ${e.message}`, true));
}

function arReflectTool() {
  arToolBtn.textContent = arTool === 'draw' ? '✏️' : '⬚';
  arToolBtn.title = `${arTool} (B)`;
}

function arToggleTool() {
  arTool = arTool === 'draw' ? 'select' : 'draw';
  localStorage.setItem('poptartArrangeTool', arTool);
  arReflectTool();
  arRefreshCursor();
}

function initArrangeCanvas() {
  for (const n of AR_SNAPS) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = n === 1 ? 'bar' : `1/${n}`;
    arSnapSelect.appendChild(o);
  }

  arCanvas.addEventListener('pointerdown', (e) => {
    if (!arState) return;
    arCloseMenu();
    arCommitLaneName(true);
    const { x, y } = arPoint(e);
    const lane = arLaneOf(y);
    const hit = y >= AR_LANES_TOP && x >= AR_GUTTER ? arClipAt(x, y) : null;
    if (e.button === 2) {
      e.preventDefault();
      if (y < AR_LANES_TOP) return; // the ruler and loops strip have no menu: a selected region carries its own name and ×
      arOpenMenu(e.clientX, e.clientY, hit, x < AR_GUTTER ? lane : null);
      return;
    }
    if (e.button !== 0) return;
    arCanvas.focus({ preventScroll: true });
    arCanvas.setPointerCapture(e.pointerId);

    if (arInRuler(y)) {
      // the ruler: drag anywhere in it to set the length, which is where the song wraps
      if (x < AR_GUTTER) return;
      arState.drag = { kind: 'len', moved: false };
      arState.len = Math.max(arCell(), arSnapTo(arBarsOf(x)));
      arSyncControls();
      drawArrange();
      return;
    }
    if (arInLoops(y)) {
      if (x < AR_GUTTER) return;
      const rh = arRegionHit(x);
      if (rh) {
        const { region, part } = rh;
        if (arState.selRegion === region && part === 'close') { arRemoveRegion(region); return; }
        // selecting a region (either tool) - and from there its edges resize, its body moves
        arState.selRegion = region;
        arState.sel.clear();
        const orig = { start: region.start, end: region.end };
        arState.drag = part === 'left' || part === 'right'
          ? { kind: 'regionEdge', region, orig, side: part, x0: x, moved: false }
          : { kind: 'regionMove', region, orig, x0: x, moved: false };
      } else if (arTool === 'draw') {
        // the pencil on an empty stretch of the strip: drag out a loop region
        arState.selRegion = null;
        const a = Math.max(0, Math.floor(arBarsOf(x) / arCell()) * arCell());
        arState.drag = { kind: 'region', a, b: a + arCell() };
      } else {
        arState.selRegion = null; // the arrow on an empty stretch: nothing selected
      }
      drawArrange();
      return;
    }
    if (x < AR_GUTTER || lane < 0 || y >= arGridBottom()) return;

    arState.selRegion = null; // anything selected in the lanes is instead of a region
    if (hit) {
      if (e.altKey) { arDeleteClips([hit.clip]); return; }
      if (e.shiftKey) {
        if (arState.sel.has(hit.clip)) arState.sel.delete(hit.clip);
        else arState.sel.add(hit.clip);
      } else if (!arState.sel.has(hit.clip)) {
        arState.sel = new Set([hit.clip]);
      }
      const targets = [...arState.sel];
      const orig = new Map(targets.map((c) => [c, { start: c.start, lane: c.lane, len: c.len }]));
      arState.drag = hit.edge
        ? { kind: 'resize', targets, orig, x0: x, side: hit.edge, moved: false }
        : { kind: 'move', targets, orig, x0: x, lane0: lane, moved: false };
      drawArrange();
      return;
    }

    if (arTool === 'select' || e.shiftKey || !arState.brush) {
      // the arrow tool (or shift, or nothing to paint): rubber-band a selection
      arState.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y };
      if (!e.shiftKey) arState.sel.clear();
      drawArrange();
      return;
    }
    // paint: the clip lands one cell wide and grows with the drag
    const start = Math.floor(arBarsOf(x) / arCell()) * arCell();
    const clip = { label: arState.brush, lane, start: Math.max(0, start), len: arCell() };
    arState.clips.push(clip);
    arState.sel = new Set([clip]);
    arState.drag = { kind: 'resize', targets: [clip], orig: new Map([[clip, { ...clip }]]), x0: x, side: 'right', moved: false, painted: true };
    drawArrange();
  });

  arCanvas.addEventListener('pointermove', (e) => {
    if (!arState) return;
    const { x, y } = arPoint(e);
    arState.hover = { x, y };
    const d = arState.drag;
    if (!d) {
      arRefreshCursor();
      return;
    }
    if (d.kind === 'len') {
      arState.len = Math.max(arCell(), arSnapTo(arBarsOf(x)));
      d.moved = true;
      arSyncControls();
    } else if (d.kind === 'region') {
      const bars = arBarsOf(x);
      d.b = bars >= d.a ? Math.max(d.a + arCell(), arSnapTo(bars)) : Math.max(0, Math.floor(bars / arCell()) * arCell());
    } else if (d.kind === 'move') {
      const dBars = arSnapTo(arBarsOf(x) - arBarsOf(d.x0));
      const dLane = arLaneOf(y) - d.lane0;
      const minStart = Math.min(...d.targets.map((c) => d.orig.get(c).start));
      const minLane = Math.min(...d.targets.map((c) => d.orig.get(c).lane));
      const shift = Math.max(dBars, -minStart);
      const laneShift = Math.max(dLane, -minLane);
      for (const c of d.targets) {
        const o = d.orig.get(c);
        c.start = o.start + shift;
        c.lane = o.lane + laneShift;
      }
      d.moved = d.moved || shift !== 0 || laneShift !== 0;
    } else if (d.kind === 'resize') {
      const dBars = arBarsOf(x) - arBarsOf(d.x0);
      for (const c of d.targets) {
        const o = d.orig.get(c);
        // the edge snaps to the grid, and a clip is never thinner than one cell
        if (d.side === 'left') {
          const start = Math.max(0, Math.min(arSnapTo(o.start + dBars), o.start + o.len - arCell()));
          c.start = start;
          c.len = o.start + o.len - start;
        } else {
          c.len = Math.max(arCell(), arSnapTo(o.start + o.len + dBars) - o.start);
        }
      }
      d.moved = true;
    } else if (d.kind === 'regionMove') {
      const shift = Math.max(arSnapTo(arBarsOf(x) - arBarsOf(d.x0)), -d.orig.start);
      d.region.start = d.orig.start + shift;
      d.region.end = d.orig.end + shift;
      d.moved = d.moved || shift !== 0;
    } else if (d.kind === 'regionEdge') {
      const dBars = arBarsOf(x) - arBarsOf(d.x0);
      if (d.side === 'left') d.region.start = Math.max(0, Math.min(arSnapTo(d.orig.start + dBars), d.orig.end - arCell()));
      else d.region.end = Math.max(d.orig.start + arCell(), arSnapTo(d.orig.end + dBars));
      d.moved = true;
    } else if (d.kind === 'marquee') {
      d.x1 = x;
      d.y1 = y;
      const bx0 = arBarsOf(Math.min(d.x0, d.x1)), bx1 = arBarsOf(Math.max(d.x0, d.x1));
      const l0 = arLaneOf(Math.min(d.y0, d.y1)), l1 = arLaneOf(Math.max(d.y0, d.y1));
      for (const c of arState.clips) {
        const inside = c.lane >= l0 && c.lane <= l1 && c.start < bx1 && c.start + c.len > bx0;
        if (inside) arState.sel.add(c);
        else if (!e.shiftKey) arState.sel.delete(c);
      }
    }
    // a drag near the right or bottom edge scrolls the timeline / the lanes along
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'regionMove' || d.kind === 'regionEdge') {
      if (x > arW - 12) arState.scroll += arCell();
      if (y > arGridBottom() - 8 && d.kind === 'move') arState.scrollLane += 0.25;
      else if (y < AR_LANES_TOP + 8 && arState.scrollLane > 0) arState.scrollLane = Math.max(0, arState.scrollLane - 0.25);
    }
    drawArrange();
  });

  const finish = (e) => {
    if (!arState?.drag) return;
    const d = arState.drag;
    arState.drag = null;
    try { arCanvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (d.kind === 'marquee') { drawArrange(); return; }
    if (d.kind === 'region') {
      const region = { name: '', start: Math.min(d.a, d.b), end: Math.max(d.a, d.b) };
      arState.loops.push(region);
      arState.loops.sort((p, q) => p.start - q.start || p.end - q.end);
      arState.selRegion = region;
      drawArrange();
      arNameRegion(region, true); // the name lands the region (esc lets it go)
      return;
    }
    if (d.kind === 'regionMove' || d.kind === 'regionEdge') {
      if (d.moved) {
        arState.loops.sort((p, q) => p.start - q.start || p.end - q.end);
        writeArrangeCall();
      }
      drawArrange();
      arRefreshCursor();
      return;
    }
    if (d.kind === 'len' || d.moved || d.painted) writeArrangeCall();
    drawArrange();
    arRefreshCursor();
  };
  arCanvas.addEventListener('pointerup', finish);
  arCanvas.addEventListener('pointercancel', finish);
  arCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  arCanvas.addEventListener('dblclick', (e) => {
    if (!arState) return;
    const { x, y } = arPoint(e);
    const lane = arLaneOf(y);
    if (x < AR_GUTTER && lane >= 0 && y < arGridBottom()) arRenameLane(lane);
    else if (arTool === 'select' && x >= AR_GUTTER && y >= AR_LANES_TOP && y < arGridBottom() && arState.brush && !arClipAt(x, y)) {
      // double-click empty in the arrow tool paints one cell, as the roll does
      const start = Math.max(0, Math.floor(arBarsOf(x) / arCell()) * arCell());
      const clip = { label: arState.brush, lane, start, len: arCell() };
      arState.clips.push(clip);
      arState.sel = new Set([clip]);
      writeArrangeCall();
      drawArrange();
    }
    else if (arInLoops(y) && x >= AR_GUTTER && arRegionAt(x)) {
      // double-click a loop region to rename it (a single click is for dragging it)
      const region = arRegionAt(x);
      arState.selRegion = region;
      arState.sel.clear();
      drawArrange();
      arNameRegion(region);
    }
    else if (arInRuler(y) && arState.len != null && arNearLoopEnd(x)) {
      // the ruler: back to an automatic length
      arState.len = null;
      arSyncControls();
      writeArrangeCall();
      drawArrange();
    }
  });

  arCanvas.addEventListener('wheel', (e) => {
    if (!arState) return;
    e.preventDefault();
    const { x } = arPoint(e);
    if (e.ctrlKey || e.metaKey) {
      arZoomAt(Math.exp(-e.deltaY * 0.01), x);
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = e.shiftKey ? e.deltaY : e.deltaX;
      arState.scroll = Math.max(0, arState.scroll + delta / arState.pxPerCycle);
    } else {
      arState.scrollLane = Math.max(0, arState.scrollLane + e.deltaY / AR_ROW);
    }
    drawArrange();
  }, { passive: false });

  arCanvas.addEventListener('keydown', (e) => {
    if (!arState) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { closeArrangeEditor(); e.preventDefault(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (arState.selRegion) arRemoveRegion(arState.selRegion);
      else arDeleteClips([...arState.sel]);
      e.preventDefault();
      return;
    }
    if (arState.selRegion && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // the selected region: arrows move it a cell, shift+arrows move its END (its length)
      const r = arState.selRegion;
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * arCell();
      if (e.shiftKey) r.end = Math.max(r.start + arCell(), r.end + step);
      else {
        const shift = Math.max(step, -r.start);
        r.start += shift;
        r.end += shift;
      }
      arState.loops.sort((p, q) => p.start - q.start || p.end - q.end);
      writeArrangeCall();
      drawArrange();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') { arHistoryStep(e.shiftKey ? 1 : -1); e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'a') { arState.sel = new Set(arState.clips); drawArrange(); e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'd') { arDuplicate([...arState.sel]); e.preventDefault(); return; }
    if (!mod && e.key.toLowerCase() === 'b') { arToggleTool(); e.preventDefault(); return; }
    if (e.key === 'Tab') {
      // tab / shift+tab step the brush through the palette, so a part can be picked without
      // leaving the canvas (the chips are in the palette's order: document order, then orphans)
      const labels = [...arChips.querySelectorAll('.arrange-chip')].map((b) => b.textContent);
      if (labels.length) {
        const at = labels.indexOf(arState.brush);
        arState.brush = labels[(at + (e.shiftKey ? -1 : 1) + labels.length) % labels.length];
        arRenderChips();
        arRefreshCursor();
      }
      e.preventDefault();
      return;
    }
    if (e.key === '+' || e.key === '=') { arZoomAt(1.25); e.preventDefault(); return; }
    if (e.key === '-') { arZoomAt(0.8); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * arCell();
      if (arState.sel.size && e.shiftKey) {
        // Shift is the roll's length nudge: the onset stays put and the END moves one cell -
        // right lengthens, left shortens back down to a single cell.
        for (const c of arState.sel) c.len = Math.max(arCell(), c.len + step);
        writeArrangeCall();
      } else if (arState.sel.size) {
        const minStart = Math.min(...[...arState.sel].map((c) => c.start));
        const shift = Math.max(step, -minStart);
        if (shift) { for (const c of arState.sel) c.start += shift; writeArrangeCall(); }
      } else {
        arState.scroll = Math.max(0, arState.scroll + step * 4);
      }
      drawArrange();
      e.preventDefault();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && arState.sel.size) {
      const step = e.key === 'ArrowUp' ? -1 : 1;
      const minLane = Math.min(...[...arState.sel].map((c) => c.lane));
      const shift = Math.max(step, -minLane);
      if (shift) {
        for (const c of arState.sel) c.lane += shift;
        writeArrangeCall();
      }
      drawArrange();
      e.preventDefault();
    }
  });

  arLaneNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { arCommitLaneName(true); arCanvas.focus({ preventScroll: true }); e.preventDefault(); }
    else if (e.key === 'Escape') { arCommitLaneName(false); arCanvas.focus({ preventScroll: true }); e.preventDefault(); }
    e.stopPropagation();
  });
  arLaneNameInput.addEventListener('blur', () => arCommitLaneName(true));

  document.addEventListener('pointerdown', (e) => { if (!arMenu.contains(e.target)) arCloseMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !arMenu.classList.contains('hidden')) { arCloseMenu(); e.stopPropagation(); } }, true);
}

function initArrangeEditor() {
  initArrangeCanvas();
  arSnapSelect.addEventListener('change', () => {
    if (!arState) return;
    arState.snap = Math.max(1, Math.round(Number(arSnapSelect.value) || 1));
    writeArrangeCall();
    drawArrange();
  });
  arLenInput.addEventListener('change', () => {
    if (!arState) return;
    const v = Number(arLenInput.value);
    arState.len = Number.isFinite(v) && v > 0 ? v : null;
    arSyncControls();
    writeArrangeCall();
    drawArrange();
  });
  arZoomInBtn.addEventListener('click', () => arState && arZoomAt(1.25));
  arZoomOutBtn.addEventListener('click', () => arState && arZoomAt(0.8));
  arReflectTool();
  arToolBtn.addEventListener('click', arToggleTool);
  arCloseBtn.addEventListener('click', closeArrangeEditor);
  window.addEventListener('resize', () => { if (arState) { arSizeCanvas(); drawArrange(); } });
  // The call the panel is editing can be deleted, or typed over, from the buffer side: the panel
  // then has nothing to write into, so it goes. Its own writes are the exception.
  cm.on('change', () => {
    if (!arState || arSuppressClose) return;
    const range = arState.marker.find();
    if (!range) { closeArrangeEditor(); return; }
    const text = cm.getRange(range.from, range.to);
    if (!/^arrange\s*\(/.test(text)) closeArrangeEditor();
    else arRenderChips(); // a label added or renamed shows up in the palette as you type
  });
}
